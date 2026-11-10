import { isIPv4 } from 'node:net'
import { and, eq, isNull } from 'drizzle-orm'
import { newId } from '../db/ids.ts'
import { cidrPattern, networkLayout, type SettingKey } from '@stationly/protocol'
import { audit_event, component, station } from '../db/schema.ts'
import { readSetting, storedSetting, writeSetting } from '../db/settings.ts'
import { hostArch, lockfileFor, parseManifest, resolvePins, sha256Of, storeRelease } from '../platform/lockfile.ts'
import type { Db } from '../db/client.ts'
import type { Keyring } from '../secrets/keyring.ts'
import { loginLinkSeconds, minPasswordLength, takeLoginLink, userExists, type AuthService } from './auth.ts'
import { checkHostnamePair } from './hostnames.ts'

export type SetupInput = {
  email: string
  password: string
  name?: string
  acme_email?: string
  hostnames?: { dashboard: string; api: string }
  'ipam.pool'?: string
  public_address?: string
  release?: InstalledRelease | null
}

export type InstalledRelease = { manifest: string; bundle: string; source: string }

export type SetupActor = { type: 'system' | 'station'; id: string | null; client: string }

export class SetupError extends Error {
  readonly code: 'SETUP_DONE' | 'VALIDATION_FAILED' | 'HOSTNAME_DOMAIN_MISMATCH'

  constructor(code: SetupError['code'], message: string) {
    super(message)
    this.code = code
  }
}

const poolPattern = new RegExp(cidrPattern)

const { dispatchHostAddress, dispatchPort } = networkLayout

export const ensureInstanceId = (db: Db) => {
  if (storedSetting(db, 'instance.id') !== undefined) return
  writeSetting(db, 'instance.id', newId('instance'), { type: 'system', id: null, client: 'dispatch' })
}

export const setupInstance = async (deps: { db: Db; keyring: Keyring; auth: AuthService }, input: SetupInput, actor: SetupActor) => {
  const { db, keyring, auth } = deps
  if (userExists(db)) throw new SetupError('SETUP_DONE', 'An admin already exists; sly setup runs once.')
  if (typeof input.email !== 'string' || !input.email.includes('@')) throw new SetupError('VALIDATION_FAILED', 'The admin email is not an email address.')
  if (typeof input.password !== 'string' || input.password.length < minPasswordLength) throw new SetupError('VALIDATION_FAILED', `The password needs at least ${minPasswordLength} characters.`)
  const settings: Partial<Record<SettingKey, unknown>> = {}
  if (input.hostnames) {
    const check = checkHostnamePair(input.hostnames.dashboard, input.hostnames.api)
    if (!check.ok) throw new SetupError('HOSTNAME_DOMAIN_MISMATCH', check.reason)
    settings['hostnames.dashboard'] = input.hostnames.dashboard
    settings['hostnames.api'] = input.hostnames.api
    settings['auth.passkey_rp_id'] = check.commonParent
  }
  if (input.acme_email) settings['acme.email'] = input.acme_email
  if (input.public_address !== undefined && !isIPv4(input.public_address)) throw new SetupError('VALIDATION_FAILED', `public_address ${input.public_address} is not an IPv4 address in dotted-quad form.`)
  if (input.public_address !== undefined && !(actor.type === 'station' && actor.id && db.select({ id: station.id }).from(station).where(and(eq(station.id, actor.id), eq(station.hosts_dispatch, true))).get()))
    throw new SetupError('VALIDATION_FAILED', 'public_address needs the station that hosts Dispatch to have enrolled.')
  const pool = input['ipam.pool']
  if (pool !== undefined) {
    if (!poolPattern.test(pool)) throw new SetupError('VALIDATION_FAILED', `ipam.pool ${pool} is not a CIDR.`)
    const stored = storedSetting(db, 'ipam.pool')
    if (stored === undefined) settings['ipam.pool'] = pool
    else if (stored !== pool) throw new SetupError('VALIDATION_FAILED', `ipam.pool is ${String(stored)} in Dispatch but the installer chose ${pool}.`)
  }
  ensureInstanceId(db)
  let manifest: ReturnType<typeof parseManifest> | null = null
  const release = input.release ?? null
  if (release) {
    try {
      manifest = parseManifest(release.manifest)
      JSON.parse(release.bundle)
    } catch (error) {
      throw new SetupError('VALIDATION_FAILED', `The installed release is unreadable: ${(error as Error).message}`)
    }
    settings['platform.lockfile'] = lockfileFor(manifest, sha256Of(release.manifest))
  }

  const created = await auth.current.api.createUser({
    body: { email: input.email, password: input.password, name: input.name ?? 'admin', role: 'admin', data: { emailVerified: true } }
  })
  const userId = created.user.id
  db.transaction(tx => {
    keyring.wrapForPassword(userId, input.password)
    if (input.public_address !== undefined) tx.update(station).set({ public_address: input.public_address }).where(eq(station.id, actor.id!)).run()
    for (const [key, value] of Object.entries(settings)) writeSetting(tx as unknown as Db, key as SettingKey, value, actor)
    if (release && manifest) {
      storeRelease(tx as unknown as Db, { manifestRaw: release.manifest, bundle: release.bundle, source: release.source, verifiedBy: 'stationd install' })
      for (const [name, pin] of Object.entries(resolvePins(manifest, null, hostArch()))) {
        const values = { name: name as (typeof component.$inferInsert)['name'], version: pin.version, digest: pin.digest, lockfile_version: pin.version, lockfile_digest: pin.digest, since: new Date(), signature: (pin.kind === 'image' ? 'verified' : 'not_applicable') as 'verified' | 'not_applicable' }
        if (name === 'dispatch') tx.update(component).set({ lockfile_version: pin.version, lockfile_digest: pin.digest, signature: values.signature }).where(and(isNull(component.station_id), eq(component.name, 'dispatch'))).run()
        else tx.insert(component).values(values).run()
      }
    }
    tx.insert(audit_event)
      .values({
        actor,
        action: 'setup.admin_created',
        target: { entity: 'user', id: userId },
        request_id: `req_setup_${Date.now()}`,
        after: { email: input.email.toLowerCase(), settings: Object.keys(settings), public_address: input.public_address ?? null, release: manifest?.release ?? null, components: Object.keys(manifest?.components ?? {}) }
      })
      .run()
  })
  auth.rebuild()
  const surface = auth.surface
  await auth.current.api.signInMagicLink({ body: { email: input.email, callbackURL: `${surface.dashboardOrigin}/` }, headers: new Headers() })
  const minted = takeLoginLink(input.email)
  const loginLink = minted ? `${surface.dashboardOrigin}${new URL(minted).pathname}${new URL(minted).search}` : null
  const instanceId = readSetting(db, 'instance.id')!
  return {
    admin_user_id: userId,
    email: created.user.email,
    instance_id: instanceId,
    settings: Object.keys(settings),
    lockfile: settings['platform.lockfile'] ? { release: manifest?.release ?? null, manifest_digest: release ? sha256Of(release.manifest) : null } : null,
    login_link: loginLink,
    login_link_expires_at: new Date(Date.now() + loginLinkSeconds * 1000).toISOString(),
    public_address: input.public_address ?? null,
    hostnames: input.hostnames ? { ...input.hostnames, status: 'pending' } : null,
    reach: [...(input.hostnames ? [`https://${input.hostnames.dashboard} once its DNS resolves and its certificate is issued`] : []), `ssh -L ${dispatchPort}:${dispatchHostAddress}:${dispatchPort} <station>, then ${auth.localOrigin}; sign in with password, then enroll TOTP`]
  }
}
