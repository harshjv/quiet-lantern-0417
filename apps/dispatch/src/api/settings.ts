import { Lockfile } from '@stationly/protocol'
import { Type, type TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { Cron } from 'croner'
import { count, eq, inArray } from 'drizzle-orm'
import type { Principal } from '../auth/principal.ts'
import { checkHostnamePair, validRpId } from '../auth/hostnames.ts'
import type { Db } from '../db/client.ts'
import { domain, environment, passkey, setting } from '../db/schema.ts'
import { requireHuman } from './access.ts'
import { ChangeSet } from './changes.ts'
import { fail, invalid } from './errors.ts'
import { iso } from './views.ts'
import { s3TargetIssues, type S3Target } from '../volumes/s3-target.ts'

const Str = Type.String({ minLength: 1 })
const Int = Type.Integer({ minimum: 0 })
const Pct = Type.Integer({ minimum: 1, maximum: 100 })
const Bool = Type.Boolean()
const Cidr = Type.String({ pattern: '^\\d{1,3}(\\.\\d{1,3}){3}/\\d{1,2}$' })

export const settingSchemas: Record<string, TSchema> = {
  'instance.id': Str,
  'hostnames.dashboard': Str,
  'hostnames.api': Str,
  'access.team_domain': Str,
  'access.aud': Str,
  'exposure.port_range': Type.String({ pattern: '^\\d{1,5}-\\d{1,5}$' }),
  'disk.warning_pct': Pct,
  'disk.critical_pct': Pct,
  'oauth.dynamic_registration': Bool,
  'ipam.pool': Cidr,
  'ipam.virtual_prefix': Cidr,
  'ingress.mode': Type.Union([Type.Literal('direct'), Type.Literal('tunnel')]),
  'cloudflare.zone_id': Str,
  'cloudflare.account_id': Str,
  'logs.retention.runtime_days': Int,
  'logs.retention.build_days': Int,
  'logs.retention.run_days': Int,
  'logs.retention.system_days': Int,
  'logs.retention.runtime_bytes_per_service': Int,
  'github.poll_interval_s': Int,
  'workshop.idle_timeout_s': Int,
  'workshop.max_builds_per_project': Int,
  'workshop.max_daemons_per_station': Int,
  'registry.gc_schedule': Str,
  'base_images.check_interval_s': Int,
  'advisories.check_interval_s': Int,
  'disk.deploy_margin_bytes': Int,
  'gaming.quiet_period_s': Int,
  'platform.release_check': Bool,
  'platform.protected': Bool,
  'platform.lockfile': Lockfile,
  'platform.allow_unsigned': Bool,
  'advisories.pin_db': Bool,
  'guard.learn_window_s': Int,
  'gateway.rate_per_source': Type.Integer({ minimum: 0, maximum: 1000000 }),
  'sandbox.stopped_retention_s': Type.Union([Type.Literal(0), Type.Integer({ minimum: 86400 })]),
  'volume_backup.target': Type.Union([
    Type.Object({ type: Type.Literal('s3'), endpoint: Str, bucket: Str, prefix: Type.String(), credentials_variable: Str }, { additionalProperties: false }),
    Type.Object({ type: Type.Literal('path'), path: Str }, { additionalProperties: false })
  ]),
  'volume_backup.schedule': Str,
  'volume_backup.schedule_quiesce': Bool,
  'volume_backup.keep': Type.Integer({ minimum: 1, maximum: 1000 }),
  'cloudflare.token_variable': Str,
  'acme.email': Type.String({ pattern: '^[^@\\s]+@[^@\\s]+$' }),
  'acme.ca_server': Str,
  'auth.passkey_rp_id': Str,
  'domains.zone': Str,
  'acme.dns_provider': Type.Object({ provider: Str, token_variable: Str }, { additionalProperties: false }),
  'acme.fallback_ca': Type.Object({ ca_server: Str, eab_kid: Str, eab_hmac_variable: Str }, { additionalProperties: false })
}

export const settingDefaults: Record<string, unknown> = {
  'workshop.max_daemons_per_station': 4,
  'guard.learn_window_s': 259200,
  'gateway.rate_per_source': 20,
  'sandbox.stopped_retention_s': 604800,
  'exposure.port_range': '30000-32767',
  'platform.protected': false,
  'platform.allow_unsigned': false,
  'platform.release_check': false,
  'oauth.dynamic_registration': false,
  'volume_backup.keep': 7,
  'volume_backup.schedule_quiesce': true
}

const humanKeys = new Set(['platform.protected', 'platform.allow_unsigned'])
const surfaceKeys = new Set(['hostnames.dashboard', 'hostnames.api', 'auth.passkey_rp_id'])
const authKeys = new Set([...surfaceKeys, 'oauth.dynamic_registration'])

const httpsUrl = (value: string) => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname !== '' && !url.username && !url.password
  } catch {
    return false
  }
}

export const readSetting = <T>(db: Db, key: string): T | null => {
  const row = db.select().from(setting).where(eq(setting.key, key)).get()
  return ((row?.value ?? settingDefaults[key] ?? null) as T | null)
}

export const frozenReason = (db: Db, key: string): string | null => {
  const stored = db.select().from(setting).where(eq(setting.key, key)).get()
  if (key === 'ipam.pool' && stored) return 'ipam.pool is frozen after install, because the Docker daemon configuration is written from it.'
  if (key === 'ipam.virtual_prefix' && (db.select({ n: count() }).from(environment).get()?.n ?? 0) > 0) return 'ipam.virtual_prefix is frozen once the first environment exists.'
  if (key === 'instance.id' && stored) return 'instance.id is fixed at setup.'
  if (key === 'platform.lockfile') return 'platform.lockfile changes only through POST /v1/platform/upgrade.'
  return null
}

export const listSettings = (db: Db, prefix: string | undefined) => {
  const rows = new Map(db.select().from(setting).all().map(row => [row.key, row]))
  return Object.keys(settingSchemas)
    .filter(key => !prefix || key.startsWith(prefix))
    .map(key => {
      const row = rows.get(key)
      return {
        key,
        value: row?.value ?? settingDefaults[key] ?? null,
        frozen: frozenReason(db, key) !== null,
        updated_by: row?.updated_by ?? null,
        updated_at: iso(row?.updated_at)
      }
    })
}

export type SettingsPlan = { set: ChangeSet; keys: string[]; surface: boolean; passkeyReset: boolean }

export const planSettings = (db: Db, principal: Principal, body: Record<string, unknown>, resetPasskeys: boolean): SettingsPlan => {
  const issues: { path: string; message: string }[] = []
  for (const [key, value] of Object.entries(body)) {
    const schema = settingSchemas[key]
    if (!schema) issues.push({ path: `/${key}`, message: 'unknown setting' })
    else if (value !== null && !Value.Check(schema, value)) issues.push({ path: `/${key}`, message: Value.Errors(schema, value).First()?.message ?? 'invalid value' })
    else if (key === 'acme.ca_server' && typeof value === 'string' && !httpsUrl(value)) issues.push({ path: `/${key}`, message: 'must be an https URL with a host' })
    else if (key === 'volume_backup.target' && value !== null && (value as { type: string }).type === 's3') {
      for (const message of s3TargetIssues(value as S3Target)) issues.push({ path: `/${key}`, message })
    } else if (key === 'volume_backup.schedule' && typeof value === 'string') {
      try {
        new Cron(value, { paused: true }).stop()
      } catch (error) {
        issues.push({ path: `/${key}`, message: `not a cron pattern: ${(error as Error).message}` })
      }
    }
  }
  if (issues.length) invalid(issues)
  for (const key of Object.keys(body)) {
    const reason = frozenReason(db, key)
    if (reason) fail('SETTING_FROZEN', reason, 'Leave this key unchanged.', { key })
    if (humanKeys.has(key)) requireHuman(principal, `Changing ${key}`, { key })
  }
  const next = (key: string) => (key in body ? body[key] : readSetting(db, key)) as string | null
  const updates: Record<string, unknown> = { ...body }
  let passkeyReset = false
  if (Object.keys(body).some(key => surfaceKeys.has(key))) {
    const dashboard = next('hostnames.dashboard')
    const api = next('hostnames.api')
    const currentRp = readSetting<string>(db, 'auth.passkey_rp_id')
    if (dashboard && api) {
      const check = checkHostnamePair(dashboard, api)
      if (!check.ok) return fail('HOSTNAME_DOMAIN_MISMATCH', check.reason, 'Choose two DNS names under one registrable domain, such as dash.example.com and api.example.com.', { dashboard, api })
      const held = db.select({ id: domain.id, hostname: domain.hostname }).from(domain).where(inArray(domain.hostname, [dashboard, api])).get()
      if (held) fail('NAME_TAKEN', `${held.hostname} is already routed to a service by domain ${held.id}.`, 'Remove that domain first, or choose another hostname for Dispatch.', { hostname: held.hostname, domain_id: held.id })
      const askedRp = 'auth.passkey_rp_id' in body ? (body['auth.passkey_rp_id'] as string | null) : null
      if (askedRp !== null && askedRp !== undefined && !validRpId(askedRp, dashboard, api)) {
        invalid([{ path: '/auth.passkey_rp_id', message: `must be a common suffix of ${dashboard} and ${api}, no shorter than ${check.registrable}` }])
      }
      const wanted = askedRp ?? (currentRp && validRpId(currentRp, dashboard, api) ? currentRp : check.commonParent)
      if (currentRp !== null && wanted !== currentRp) {
        if (!resetPasskeys) {
          fail('PASSKEY_RESET_REQUIRED', `The change moves the passkey RP ID from ${currentRp} to ${wanted}, which invalidates every passkey.`, 'Send reset_passkeys = true from a human session, then re-enroll a passkey after signing in with password and TOTP.', {
            current_rp_id: currentRp,
            new_rp_id: wanted
          })
        }
        requireHuman(principal, 'A passkey reset', { reset_passkeys: true })
        passkeyReset = true
      }
      updates['auth.passkey_rp_id'] = wanted
    } else {
      if (dashboard || api) invalid([{ path: dashboard ? '/hostnames.api' : '/hostnames.dashboard', message: 'set both hostnames, or clear both for a domainless station' }])
      if ('auth.passkey_rp_id' in body && body['auth.passkey_rp_id'] !== null) invalid([{ path: '/auth.passkey_rp_id', message: 'set hostnames.dashboard and hostnames.api first' }])
      if (currentRp !== null) {
        if (!resetPasskeys) {
          fail('PASSKEY_RESET_REQUIRED', `Clearing both hostnames removes the passkey RP ID ${currentRp}, which invalidates every passkey.`, 'Send reset_passkeys = true from a human session, then sign in with password and TOTP.', { current_rp_id: currentRp, new_rp_id: null })
        }
        requireHuman(principal, 'A passkey reset', { reset_passkeys: true })
        passkeyReset = true
        updates['auth.passkey_rp_id'] = null
      }
    }
  }
  const set = new ChangeSet()
  for (const [key, value] of Object.entries(updates)) {
    const before = db.select().from(setting).where(eq(setting.key, key)).get()?.value ?? null
    if (JSON.stringify(before) !== JSON.stringify(value)) set.update('setting', key, '/value', before, value)
  }
  return { set, keys: Object.keys(updates), surface: Object.keys(updates).some(key => authKeys.has(key)), passkeyReset }
}

export const resetPasskeys = (db: Db) => db.delete(passkey).run()
