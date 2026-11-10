import { Value } from '@sinclair/typebox/value'
import { Cron } from 'croner'
import { count, inArray } from 'drizzle-orm'

import {
  isSettingKey,
  settingDefault,
  settingKeys,
  settings,
  type SettingKey,
} from '@stationly/protocol'

import { surfaceKeys } from '../auth/auth.ts'
import { checkHostnamePair, validRpId } from '../auth/hostnames.ts'
import type { Principal } from '../auth/principal.ts'
import type { Db } from '../db/client.ts'
import { domain, environment, passkey, setting } from '../db/schema.ts'
import { readSetting, storedSetting } from '../db/settings.ts'
import { cidrProblem } from '../net/cidr.ts'
import { s3TargetIssues, type S3Target } from '../volumes/s3-target.ts'

import { requireHuman } from './access.ts'
import { ChangeSet } from './changes.ts'
import { fail, invalid } from './errors.ts'
import { iso } from './views.ts'

const humanKeys = new Set(['platform.protected', 'platform.allow_unsigned'])
const surfaceKeySet = new Set<string>(surfaceKeys)
const authKeys = new Set<string>([...surfaceKeys, 'oauth.dynamic_registration'])

const httpsUrl = (value: string) => {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname !== '' && !url.username && !url.password
  } catch {
    return false
  }
}

export const frozenReason = (db: Db, key: SettingKey): string | null => {
  const stored = storedSetting(db, key) !== undefined
  if (key === 'ipam.pool' && stored)
    return 'ipam.pool is frozen after install, because the Docker daemon configuration is written from it.'
  if (
    key === 'ipam.virtual_prefix' &&
    (db
      .select({
        n: count(),
      })
      .from(environment)
      .get()?.n ?? 0) > 0
  )
    return 'ipam.virtual_prefix is frozen once the first environment exists.'
  if (key === 'instance.id' && stored) return 'instance.id is fixed at setup.'
  if (key === 'platform.lockfile')
    return 'platform.lockfile changes only through POST /v1/platform/upgrade.'
  return null
}

export const listSettings = (db: Db, prefix: string | undefined) => {
  const rows = new Map(
    db
      .select()
      .from(setting)
      .all()
      .map((row) => [row.key, row]),
  )
  return settingKeys
    .filter((key) => !prefix || key.startsWith(prefix))
    .map((key) => {
      const row = rows.get(key)
      return {
        key,
        value: row?.value ?? settingDefault(key),
        frozen: frozenReason(db, key) !== null,
        updated_by: row?.updated_by ?? null,
        updated_at: iso(row?.updated_at),
      }
    })
}

export type SettingsPlan = {
  set: ChangeSet
  keys: SettingKey[]
  surface: boolean
  passkeyReset: boolean
}

export const planSettings = (
  db: Db,
  principal: Principal,
  body: Record<string, unknown>,
  resetPasskeys: boolean,
): SettingsPlan => {
  const issues: { path: string; message: string }[] = []
  for (const [key, value] of Object.entries(body)) {
    const schema = isSettingKey(key) ? settings[key].schema : undefined
    if (!schema)
      issues.push({
        path: `/${key}`,
        message: 'unknown setting',
      })
    else if (value !== null && !Value.Check(schema, value))
      issues.push({
        path: `/${key}`,
        message: Value.Errors(schema, value).First()?.message ?? 'invalid value',
      })
    else if (
      (key === 'ipam.pool' || key === 'ipam.virtual_prefix') &&
      typeof value === 'string' &&
      cidrProblem(value)
    )
      issues.push({
        path: `/${key}`,
        message: cidrProblem(value)!,
      })
    else if (key === 'acme.ca_server' && typeof value === 'string' && !httpsUrl(value))
      issues.push({
        path: `/${key}`,
        message: 'must be an https URL with a host',
      })
    else if (
      key === 'volume_backup.target' &&
      value !== null &&
      (value as { type: string }).type === 's3'
    ) {
      for (const message of s3TargetIssues(value as S3Target))
        issues.push({
          path: `/${key}`,
          message,
        })
    } else if (key === 'volume_backup.schedule' && typeof value === 'string') {
      try {
        new Cron(value, {
          paused: true,
        }).stop()
      } catch (error) {
        issues.push({
          path: `/${key}`,
          message: `not a cron pattern: ${(error as Error).message}`,
        })
      }
    }
  }
  if (issues.length) invalid(issues)
  for (const key of Object.keys(body) as SettingKey[]) {
    const reason = frozenReason(db, key)
    if (reason)
      fail('SETTING_FROZEN', reason, 'Leave this key unchanged.', {
        key,
      })
    if (humanKeys.has(key))
      requireHuman(principal, `Changing ${key}`, {
        key,
      })
  }
  const next = (key: 'hostnames.dashboard' | 'hostnames.api') =>
    (key in body ? body[key] : readSetting(db, key)) as string | null
  const updates: Record<string, unknown> = {
    ...body,
  }
  let passkeyReset = false
  if (Object.keys(body).some((key) => surfaceKeySet.has(key))) {
    const dashboard = next('hostnames.dashboard')
    const api = next('hostnames.api')
    const currentRp = readSetting(db, 'auth.passkey_rp_id')
    if (dashboard && api) {
      const check = checkHostnamePair(dashboard, api)
      if (!check.ok)
        return fail(
          'HOSTNAME_DOMAIN_MISMATCH',
          check.reason,
          'Choose two DNS names under one registrable domain, such as dash.example.com and api.example.com.',
          {
            dashboard,
            api,
          },
        )
      const held = db
        .select({
          id: domain.id,
          hostname: domain.hostname,
        })
        .from(domain)
        .where(inArray(domain.hostname, [dashboard, api]))
        .get()
      if (held)
        fail(
          'NAME_TAKEN',
          `${held.hostname} is already routed to a service by domain ${held.id}.`,
          'Remove that domain first, or choose another hostname for Dispatch.',
          {
            hostname: held.hostname,
            domain_id: held.id,
          },
        )
      const askedRp =
        'auth.passkey_rp_id' in body ? (body['auth.passkey_rp_id'] as string | null) : null
      if (askedRp !== null && askedRp !== undefined && !validRpId(askedRp, dashboard, api)) {
        invalid([
          {
            path: '/auth.passkey_rp_id',
            message: `must be a common suffix of ${dashboard} and ${api}, no shorter than ${check.registrable}`,
          },
        ])
      }
      const wanted =
        askedRp ??
        (currentRp && validRpId(currentRp, dashboard, api) ? currentRp : check.commonParent)
      if (currentRp !== null && wanted !== currentRp) {
        if (!resetPasskeys) {
          fail(
            'PASSKEY_RESET_REQUIRED',
            `The change moves the passkey RP ID from ${currentRp} to ${wanted}, which invalidates every passkey.`,
            'Send reset_passkeys = true from a human session, then re-enroll a passkey after signing in with password and TOTP.',
            {
              current_rp_id: currentRp,
              new_rp_id: wanted,
            },
          )
        }
        requireHuman(principal, 'A passkey reset', {
          reset_passkeys: true,
        })
        passkeyReset = true
      }
      updates['auth.passkey_rp_id'] = wanted
    } else {
      if (dashboard || api)
        invalid([
          {
            path: dashboard ? '/hostnames.api' : '/hostnames.dashboard',
            message: 'set both hostnames, or clear both for a domainless station',
          },
        ])
      if ('auth.passkey_rp_id' in body && body['auth.passkey_rp_id'] !== null)
        invalid([
          {
            path: '/auth.passkey_rp_id',
            message: 'set hostnames.dashboard and hostnames.api first',
          },
        ])
      if (currentRp !== null) {
        if (!resetPasskeys) {
          fail(
            'PASSKEY_RESET_REQUIRED',
            `Clearing both hostnames removes the passkey RP ID ${currentRp}, which invalidates every passkey.`,
            'Send reset_passkeys = true from a human session, then sign in with password and TOTP.',
            {
              current_rp_id: currentRp,
              new_rp_id: null,
            },
          )
        }
        requireHuman(principal, 'A passkey reset', {
          reset_passkeys: true,
        })
        passkeyReset = true
        updates['auth.passkey_rp_id'] = null
      }
    }
  }
  const set = new ChangeSet()
  for (const [key, value] of Object.entries(updates)) {
    const before = storedSetting(db, key as SettingKey) ?? null
    if (JSON.stringify(before) !== JSON.stringify(value))
      set.update('setting', key, '/value', before, value)
  }
  return {
    set,
    keys: Object.keys(updates) as SettingKey[],
    surface: Object.keys(updates).some((key) => authKeys.has(key)),
    passkeyReset,
  }
}

export const resetPasskeys = (db: Db) => db.delete(passkey).run()
