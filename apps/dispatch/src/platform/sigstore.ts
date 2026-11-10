import type { Db } from '../db/client.ts'
import { releaseConfig } from '@stationly/protocol/release-config'
import { env } from '../env.ts'
import { storeBlob } from '../station/blobs.ts'
import { parseReference, registryRequest } from './registry.ts'

const indexAccept = 'application/vnd.oci.image.index.v1+json'
const manifestAccept = 'application/vnd.oci.image.manifest.v1+json'
const maxTufBytes = 16 << 20
const maxBundleBytes = 1 << 20
const maxBundles = 16
const blobTtlMs = 60 * 60 * 1000

export class UpstreamError extends Error {
  readonly code: 'NOT_FOUND' | 'SOURCE_UNREACHABLE' | 'PROTOCOL_INVALID_MESSAGE'

  constructor(code: UpstreamError['code'], message: string) {
    super(message)
    this.code = code
  }
}

const tufPath = /^(?:[0-9]+\.)?(?:root|timestamp|snapshot|targets)\.json$|^targets\/[0-9a-f]{64}\.[A-Za-z0-9_.-]+$/

export const fetchTuf = async (path: string) => {
  if (!tufPath.test(path)) throw new UpstreamError('PROTOCOL_INVALID_MESSAGE', `${path} is not a TUF metadata or target path`)
  const url = `${env().STATIONLY_SIGSTORE_TUF_MIRROR}/${path}`
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: 'follow' })
  } catch (error) {
    throw new UpstreamError('SOURCE_UNREACHABLE', `GET ${url}: ${(error as Error).message}`)
  }
  if (res.status === 404) throw new UpstreamError('NOT_FOUND', `GET ${url} answered 404`)
  if (res.status !== 200) throw new UpstreamError('SOURCE_UNREACHABLE', `GET ${url} answered ${res.status}`)
  const body = Buffer.from(await res.arrayBuffer())
  if (body.length > maxTufBytes) throw new UpstreamError('SOURCE_UNREACHABLE', `${url} is above ${maxTufBytes} bytes`)
  return body
}

type Descriptor = { mediaType?: string; digest: string; size?: number; artifactType?: string }

export const fetchBundles = async (digest: string) => {
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new UpstreamError('PROTOCOL_INVALID_MESSAGE', `${digest} is not a sha256 digest`)
  const repo = parseReference(env().STATIONLY_SIGNATURES_REPOSITORY)
  const get = (path: string, accept: string, maxBytes: number) => registryRequest(repo, path, { method: 'GET', accept, maxBytes, timeoutMs: 20_000 })
  let index = await get(`referrers/${digest}?artifactType=${encodeURIComponent(releaseConfig.media_types.sigstore_bundle)}`, indexAccept, maxBundleBytes)
  if (index.status === 404) index = await get(`manifests/sha256-${digest.slice(7)}`, indexAccept, maxBundleBytes)
  if (index.status === 404 || (index.status === 401 && !index.body)) return { bundles: [] as unknown[], hosts: index.hops.map(h => h.host) }
  if (index.status !== 200 || !index.body) throw new UpstreamError('SOURCE_UNREACHABLE', `referrers of ${digest} in ${repo.registry}/${repo.repository}: ${index.status} ${index.error ?? ''}`.trim())
  const manifests = ((JSON.parse(index.body.toString('utf8')) as { manifests?: Descriptor[] }).manifests ?? []).filter(m => m.artifactType === releaseConfig.media_types.sigstore_bundle).slice(0, maxBundles)
  const bundles: unknown[] = []
  const hosts = new Set(index.hops.map(h => h.host))
  for (const m of manifests) {
    const man = await get(`manifests/${m.digest}`, manifestAccept, maxBundleBytes)
    man.hops.forEach(h => hosts.add(h.host))
    if (man.status !== 200 || !man.body) continue
    const layer = ((JSON.parse(man.body.toString('utf8')) as { layers?: Descriptor[] }).layers ?? [])[0]
    if (!layer || (layer.size ?? 0) > maxBundleBytes) continue
    const blob = await get(`blobs/${layer.digest}`, '*/*', maxBundleBytes)
    blob.hops.forEach(h => hosts.add(h.host))
    if (blob.status !== 200 || !blob.body) continue
    try {
      bundles.push(JSON.parse(blob.body.toString('utf8')))
    } catch {
      continue
    }
  }
  return { bundles, hosts: [...hosts] }
}

export const upstreamBlob = async (db: Db, blobDir: string, upstream: { tuf_path: string } | { signature_digest: string }) => {
  const bytes = 'tuf_path' in upstream ? await fetchTuf(upstream.tuf_path) : Buffer.from(JSON.stringify({ bundles: (await fetchBundles(upstream.signature_digest)).bundles }))
  return storeBlob(db, blobDir, { kind: 'sigstore', bytes, ttlMs: blobTtlMs })
}
