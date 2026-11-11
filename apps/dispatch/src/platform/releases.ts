import { releaseConfig } from '@stationly/protocol/release-config'

import { env } from '../env.ts'
import { DomainError } from '../errors.ts'

import { parseManifest, sha256Of } from './lockfile.ts'
import { parseReference, registryRequest, type Reference } from './registry.ts'

const maxManifestBytes = 4 << 20
const maxBundleBytes = 1 << 20
const maxArtifactBytes = 1 << 20

const titleAnnotation = 'org.opencontainers.image.title'
const ociManifest = 'application/vnd.oci.image.manifest.v1+json'

export class ReleaseFetchError extends DomainError<'RELEASE_NOT_FOUND' | 'SOURCE_UNREACHABLE'> {
  readonly url: string

  constructor(code: ReleaseFetchError['code'], url: string, message: string) {
    super(code, message)
    this.url = url
  }
}

type Layer = {
  mediaType: string
  digest: string
  size: number
  annotations?: Record<string, string>
}

type ArtifactManifest = {
  mediaType?: string
  artifactType?: string
  config?: { mediaType?: string }
  layers?: Layer[]
}

const unreachable = (where: string, message: string) =>
  new ReleaseFetchError('SOURCE_UNREACHABLE', where, message)

const readArtifact = async (ref: Reference, tag: string, where: string) => {
  const res = await registryRequest(ref, `manifests/${tag}`, {
    method: 'GET',
    accept: ociManifest,
    timeoutMs: 30_000,
    maxBytes: maxArtifactBytes,
  })

  if (res.status === 404) {
    throw new ReleaseFetchError('RELEASE_NOT_FOUND', where, `${where} does not exist`)
  }

  if (res.status !== 200 || !res.body) {
    throw unreachable(
      where,
      `GET ${where} answered ${res.status}${res.error ? `: ${res.error}` : ''}`,
    )
  }

  const doc = JSON.parse(res.body.toString('utf8')) as ArtifactManifest

  if (
    doc.mediaType !== ociManifest ||
    (doc.artifactType !== releaseConfig.media_types.release_artifact &&
      doc.config?.mediaType !== releaseConfig.media_types.release_artifact)
  ) {
    throw unreachable(
      where,
      `${where} is not a Stationly release artifact (artifact type ${doc.artifactType ?? 'none'})`,
    )
  }

  const files = new Map<string, Layer>()

  for (const layer of doc.layers ?? []) {
    const title = layer.annotations?.[titleAnnotation]

    if (title) {
      files.set(title, layer)
    }
  }

  return {
    files,
    digest: sha256Of(res.body),
  }
}

const readFile = async (
  ref: Reference,
  files: Map<string, Layer>,
  file: string,
  maxBytes: number,
  where: string,
) => {
  const layer = files.get(file)

  if (!layer) {
    throw new ReleaseFetchError('RELEASE_NOT_FOUND', where, `${where} has no ${file}`)
  }

  if (layer.size > maxBytes) {
    throw unreachable(where, `${file} in ${where} is ${layer.size} bytes, above ${maxBytes}`)
  }

  const res = await registryRequest(ref, `blobs/${layer.digest}`, {
    method: 'GET',
    accept: '*/*',
    timeoutMs: 30_000,
    maxBytes,
  })

  if (res.status !== 200 || !res.body) {
    throw unreachable(
      where,
      `GET ${file} (${layer.digest}) from ${where} answered ${res.status}${res.error ? `: ${res.error}` : ''}`,
    )
  }

  if (sha256Of(res.body) !== layer.digest) {
    throw unreachable(where, `${file} from ${where} does not match its digest ${layer.digest}`)
  }

  return res.body.toString('utf8')
}

export const fetchRelease = async (version: string) => {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/.test(version)) {
    throw new ReleaseFetchError('RELEASE_NOT_FOUND', version, `${version} is not a release version`)
  }

  const tag = `v${version}`
  const where = `${env().STATIONLY_RELEASES_REPOSITORY}:${tag}`
  const ref = parseReference(where)
  const artifact = await readArtifact(ref, tag, where)
  const manifestRaw = await readFile(
    ref,
    artifact.files,
    'release-manifest.json',
    maxManifestBytes,
    where,
  )
  const bundle = await readFile(
    ref,
    artifact.files,
    'release-manifest.json.sigstore.json',
    maxBundleBytes,
    where,
  )
  const manifest = parseManifest(manifestRaw)

  if (manifest.release !== version) {
    throw unreachable(
      where,
      `the manifest at ${where} is release ${manifest.release}, not ${version}`,
    )
  }

  return {
    manifestRaw,
    bundle,
    manifest,
    manifestDigest: sha256Of(manifestRaw),
    source: `${where}@${artifact.digest}`,
  }
}
