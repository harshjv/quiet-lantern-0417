import { createHash } from 'node:crypto'
import { Lockfile, ReleaseManifest, type LockfileDoc, type ReleaseComponentDoc, type ReleaseManifestDoc } from '@stationly/protocol'
import { Value } from '@sinclair/typebox/value'
import { and, eq, isNull } from 'drizzle-orm'
import type { Db } from '../db/client.ts'
import { component, platform_release, setting } from '../db/schema.ts'

export type Pin = { version: string; digest: string | null; source: string | null; kind: ReleaseComponentDoc['kind'] | null; origin: 'release' | 'override' }

export type Pins = Record<string, Pin>

export const lockfileUnpinned = 'unpinned'

export const hostArch = () => (process.arch === 'x64' ? 'amd64' : process.arch)

export const sha256Of = (bytes: string | Buffer) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

export const parseManifest = (raw: string): ReleaseManifestDoc => {
  const doc = JSON.parse(raw) as unknown
  if (!Value.Check(ReleaseManifest, doc)) {
    const first = Value.Errors(ReleaseManifest, doc).First()
    throw new Error(`release-manifest.json does not match schema 1: ${first?.path ?? '/'} ${first?.message ?? ''}`.trim())
  }
  for (const [name, c] of Object.entries(doc.components)) {
    if (c.digest === null && c.platforms === null) throw new Error(`components.${name} needs a digest or platforms`)
    if (c.kind === 'image' && (c.digest === null || c.platforms === null)) throw new Error(`components.${name} is an image and needs its index digest and its platform digests`)
  }
  return doc
}

export const readLockfile = (db: Db): LockfileDoc | null => {
  const value = db.select().from(setting).where(eq(setting.key, 'platform.lockfile')).get()?.value
  return value && Value.Check(Lockfile, value) ? value : null
}

export const releaseFor = (db: Db, lockfile: LockfileDoc | null) =>
  lockfile ? (db.select().from(platform_release).where(eq(platform_release.manifest_digest, lockfile.manifest_digest)).get() ?? null) : null

export const currentRelease = (db: Db) => releaseFor(db, readLockfile(db))

const platformOf = (arch: string | null | undefined) => (arch === 'amd64' || arch === 'arm64' ? (`linux/${arch}` as const) : null)

export const pinFor = (c: ReleaseComponentDoc, arch: string | null | undefined): string | null => {
  if (c.digest !== null) return c.digest
  const platform = platformOf(arch)
  return platform && c.platforms ? (c.platforms[platform] ?? null) : null
}

export const resolvePins = (manifest: ReleaseManifestDoc | null, lockfile: LockfileDoc | null, arch: string | null | undefined): Pins => {
  const pins: Pins = {}
  for (const [name, c] of Object.entries(manifest?.components ?? {})) {
    pins[name] = { version: c.version, digest: pinFor(c, arch), source: c.source, kind: c.kind, origin: 'release' }
  }
  for (const [name, o] of Object.entries(lockfile?.overrides ?? {})) {
    pins[name] = { version: o.version, digest: o.digest, source: o.source, kind: pins[name]?.kind ?? 'image', origin: 'override' }
  }
  return pins
}

export const effectivePins = (db: Db, arch: string | null | undefined): Pins => {
  const lockfile = readLockfile(db)
  return resolvePins(releaseFor(db, lockfile)?.manifest ?? null, lockfile, arch)
}

export const lockfileFor = (manifest: ReleaseManifestDoc, manifestDigest: string, now = new Date()): LockfileDoc => ({
  schema: 2,
  release: manifest.release,
  channel: manifest.channel,
  manifest_digest: manifestDigest,
  updated_at: now.toISOString().replace(/\.\d+Z$/, 'Z'),
  overrides: {},
  grype_db: null,
  templates: {}
})

export const storeRelease = (db: Db, input: { manifestRaw: string; bundle: string; source: string; verifiedBy: string | null }) => {
  const manifest = parseManifest(input.manifestRaw)
  JSON.parse(input.bundle)
  const manifest_digest = sha256Of(input.manifestRaw)
  const existing = db.select().from(platform_release).where(eq(platform_release.manifest_digest, manifest_digest)).get()
  if (existing) return existing
  const row: typeof platform_release.$inferInsert = { release: manifest.release, channel: manifest.channel as (typeof platform_release.$inferInsert)["channel"], manifest, manifest_raw: input.manifestRaw, manifest_digest, bundle: input.bundle, source: input.source, verified_by: input.verifiedBy }
  db.insert(platform_release).values(row).run()
  return db.select().from(platform_release).where(eq(platform_release.manifest_digest, manifest_digest)).get()!
}

export const recordDispatchComponent = (db: Db, version: string) => {
  const pin = effectivePins(db, hostArch()).dispatch
  const digest = process.env.STATIONLY_DISPATCH_DIGEST || null
  const values = {
    version,
    digest,
    lockfile_version: pin?.version ?? lockfileUnpinned,
    lockfile_digest: pin?.digest ?? null,
    status: (pin && pin.version !== version ? 'drift' : 'ok') as 'drift' | 'ok',
    signature: (digest ? 'pending' : 'not_applicable') as 'pending' | 'not_applicable',
    since: new Date()
  }
  const row = db.select().from(component).where(and(isNull(component.station_id), eq(component.name, 'dispatch'))).get()
  if (row) db.update(component).set(values).where(eq(component.id, row.id)).run()
  else db.insert(component).values({ name: 'dispatch', ...values }).run()
}
