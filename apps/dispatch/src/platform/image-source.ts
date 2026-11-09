import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import type { Db } from '../db/client.ts'
import { station } from '../db/schema.ts'
import { fail } from '../api/errors.ts'
import { displayRef, manifestAccept, parseReference, registryRequest, type Reference, type RegistryResponse } from './registry.ts'

export type ImageSource = { type: 'image'; ref: string; digest: string }

export type Resolution = {
  ref: string
  digest: string
  pinned: string
  media_type: string | null
  platforms: string[]
  hosts: string[]
}

const indexTypes = new Set(['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'])
const imageTypes = new Set(['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'])
const repositoryPattern = /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*)*$/
const tagPattern = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/
const digestPattern = /^sha256:[0-9a-f]{64}$/
export const pinnedPattern = /^[^@]+@sha256:[0-9a-f]{64}$/
const maxManifestBytes = 4 * 1024 * 1024
const maxConfigBytes = 1024 * 1024

export const pinnedRef = (ref: string, digest: string) => {
  const r = parseReference(ref)
  return `${r.registry}/${r.repository}@${digest}`
}

export const isPinned = (imageRef: string | null | undefined): imageRef is string => typeof imageRef === 'string' && pinnedPattern.test(imageRef)

type Descriptor = { mediaType?: string; digest?: string; platform?: { os?: string; architecture?: string; variant?: string } }

const registryCodes = (res: RegistryResponse) => {
  if (!res.body) return []
  try {
    const doc = JSON.parse(res.body.toString('utf8')) as { errors?: { code?: string }[] }
    return (doc.errors ?? []).map(e => e.code ?? '').filter(Boolean)
  } catch {
    return []
  }
}

const hostsOf = (res: RegistryResponse) => [...new Set(res.hops.map(h => h.host))]

const refuse = (r: Reference, input: string, res: RegistryResponse, path: string): never => {
  const shown = displayRef(r)
  const codes = registryCodes(res)
  const base = { ref: input, registry: r.registry, repository: r.repository, tag: r.tag, digest: r.digest, status: res.status, registry_codes: codes, hosts: hostsOf(res), path }
  if (res.status === 0 || res.status >= 500 || res.status === 508)
    return fail('SOURCE_UNREACHABLE', `Dispatch could not read ${shown} from ${r.apiHost}${res.error ? `: ${res.error}` : ` (HTTP ${res.status})`}.`, `Check that Dispatch can resolve and reach ${r.apiHost} and the token host it names, then retry.`, { ...base, reason: 'unreachable' })
  if (res.status === 429 || codes.includes('TOOMANYREQUESTS')) {
    const retry = Number(res.headers.get('retry-after'))
    return fail('SOURCE_UNREACHABLE', `${r.apiHost} refused the lookup of ${shown} with a rate limit.`, 'Retry after the registry rate limit window, or pin the image by digest (ref@sha256:...).', {
      ...base,
      reason: 'rate_limited',
      retry_after_s: Number.isFinite(retry) && retry > 0 ? retry : null,
      ratelimit: { limit: res.headers.get('ratelimit-limit'), remaining: res.headers.get('ratelimit-remaining') }
    })
  }
  if (res.status === 401 || res.status === 403 || codes.includes('UNAUTHORIZED') || codes.includes('DENIED'))
    return fail(
      'SOURCE_UNREACHABLE',
      `${r.apiHost} refused anonymous access to ${r.repository}: the repository is private or does not exist (registries answer both the same way).`,
      `Check the spelling of ${r.registry === 'docker.io' ? r.repository.replace(/^library\//, '') : `${r.registry}/${r.repository}`}. Dispatch reads registries anonymously, so a private image must be made public or pushed to a registry that allows anonymous pulls.`,
      { ...base, reason: 'auth_required' }
    )
  if (res.status === 404 && codes.includes('NAME_UNKNOWN'))
    return fail('SOURCE_UNREACHABLE', `${r.registry} has no repository ${r.repository}.`, 'Check the image name.', { ...base, reason: 'repository_not_found' })
  if (res.status === 404)
    return fail(
      'SOURCE_UNREACHABLE',
      r.digest ? `${r.registry}/${r.repository} has no manifest ${r.digest}.` : `${r.registry}/${r.repository} has no tag ${r.tag ?? 'latest'}.`,
      r.digest ? 'Check the digest, or name the image by a tag and let Dispatch pin it.' : `Pick a tag that exists in ${r.registry}/${r.repository}.`,
      { ...base, reason: 'not_found' }
    )
  return fail('SOURCE_UNREACHABLE', `${r.apiHost} answered HTTP ${res.status} for ${shown}.`, 'Check the image reference and retry.', { ...base, reason: 'unexpected_status' })
}

const validate = (r: Reference, path: string) => {
  const issues: { path: string; message: string }[] = []
  if (!repositoryPattern.test(r.repository)) issues.push({ path, message: `${r.repository} is not a valid repository name (lowercase letters, digits and separators)` })
  if (r.tag !== null && !tagPattern.test(r.tag)) issues.push({ path, message: `${r.tag} is not a valid tag` })
  if (r.digest !== null && !digestPattern.test(r.digest)) issues.push({ path, message: `${r.digest} is not a sha256 digest` })
  if (issues.length) fail('VALIDATION_FAILED', issues.map(i => `${i.path}: ${i.message}`).join('; '), 'Use a reference like nginx:1.27, ghcr.io/owner/name:tag or name@sha256:<64 hex>.', { issues })
}

const configPlatform = async (r: Reference, manifest: { config?: Descriptor }) => {
  const digest = manifest.config?.digest
  if (!digest) return []
  const res = await registryRequest(r, `blobs/${digest}`, { method: 'GET', accept: '*/*', maxBytes: maxConfigBytes, timeoutMs: 15_000 })
  if (res.status !== 200 || !res.body) return []
  try {
    const config = JSON.parse(res.body.toString('utf8')) as { os?: string; architecture?: string; variant?: string }
    return config.os && config.architecture ? [[config.os, config.architecture, config.variant].filter(Boolean).join('/')] : []
  } catch {
    return []
  }
}

export const resolveImage = async (input: string, arch: string | null, path = '/source/ref'): Promise<Resolution> => {
  const r = parseReference(input.trim())
  validate(r, path)
  const res = await registryRequest(r, `manifests/${r.digest ?? r.tag ?? 'latest'}`, { method: 'GET', accept: manifestAccept, maxBytes: maxManifestBytes, timeoutMs: 15_000, errorBody: true })
  if (res.status !== 200 || !res.body) return refuse(r, input, res, path)
  const computed = `sha256:${createHash('sha256').update(res.body).digest('hex')}`
  const announced = res.headers.get('docker-content-digest')
  if ((announced && announced !== computed) || (r.digest && r.digest !== computed))
    fail('SOURCE_UNREACHABLE', `${displayRef(r)} returned a manifest whose sha256 is ${computed}, not ${r.digest ?? announced}.`, 'Retry; if it persists, the registry or a proxy in between is altering responses.', {
      ref: input,
      reason: 'digest_mismatch',
      computed,
      expected: r.digest ?? announced,
      hosts: hostsOf(res),
      path
    })
  let doc: { mediaType?: string; manifests?: Descriptor[]; config?: Descriptor }
  try {
    doc = JSON.parse(res.body.toString('utf8'))
  } catch {
    return fail('SOURCE_UNREACHABLE', `${displayRef(r)} returned a manifest that is not JSON.`, 'Check the image reference.', { ref: input, reason: 'invalid_manifest', path })
  }
  const mediaType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim() || doc.mediaType || null
  const isIndex = (mediaType !== null && indexTypes.has(mediaType)) || Array.isArray(doc.manifests)
  if (!isIndex && mediaType !== null && !imageTypes.has(mediaType) && !doc.config)
    fail('SOURCE_UNREACHABLE', `${displayRef(r)} is a ${mediaType}, which is not a runnable image.`, 'Name an image manifest or an image index.', { ref: input, reason: 'unsupported_media_type', media_type: mediaType, path })
  const platforms = isIndex
    ? [...new Set((doc.manifests ?? []).flatMap(m => (m.platform?.os && m.platform.architecture && m.platform.os !== 'unknown' ? [[m.platform.os, m.platform.architecture, m.platform.variant].filter(Boolean).join('/')] : [])))]
    : await configPlatform(r, doc)
  if (arch && platforms.length && !platforms.some(p => p === `linux/${arch}` || p.startsWith(`linux/${arch}/`)))
    fail('STATION_CAPABILITY_MISSING', `${displayRef(r)} has no linux/${arch} image; it is published for ${platforms.join(', ')}.`, `Use a tag published for linux/${arch}, or place the service on a station whose architecture is listed.`, {
      ref: input,
      reason: 'platform_missing',
      arch,
      platforms,
      digest: computed,
      path
    })
  return { ref: input, digest: computed, pinned: `${r.registry}/${r.repository}@${computed}`, media_type: mediaType, platforms, hosts: hostsOf(res) }
}

export const stationArch = (db: Db, stationId: string | null | undefined) => {
  if (!stationId) return null
  return db.select({ arch: station.arch }).from(station).where(eq(station.id, stationId)).get()?.arch ?? null
}

export type Pinned = { source: ImageSource; resolution: Resolution | null }

export const pinImageSource = async (db: Db, source: { type: 'image'; ref: string }, stationId: string | null | undefined, prior: unknown, path = '/source/ref'): Promise<Pinned> => {
  const before = prior as Partial<ImageSource> | null | undefined
  if (before?.type === 'image' && before.ref === source.ref && typeof before.digest === 'string' && digestPattern.test(before.digest)) return { source: { type: 'image', ref: source.ref, digest: before.digest }, resolution: null }
  const resolution = await resolveImage(source.ref, stationArch(db, stationId), path)
  return { source: { type: 'image', ref: source.ref, digest: resolution.digest }, resolution }
}

export const pinnedWarning = (resolution: Resolution) => {
  const r = parseReference(resolution.ref)
  const tagged = r.digest === null
  return {
    code: 'IMAGE_PINNED',
    explanation: tagged
      ? `${resolution.ref} resolved to ${resolution.digest} (${resolution.platforms.join(', ') || 'platform not listed'}); deployments run ${resolution.pinned}. Redeploys keep this digest; deploy resolves the tag again.`
      : `${resolution.ref} is pinned by digest (${resolution.platforms.join(', ') || 'platform not listed'}); deployments run ${resolution.pinned}.`
  }
}
