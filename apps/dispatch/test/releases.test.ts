import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, beforeEach, describe, test } from 'node:test'
import { releaseConfig } from '@stationly/protocol/release-config'
import { fetchRelease, ReleaseFetchError } from '../src/platform/releases.ts'

const sha = (b: string | Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`

const manifestFor = (release: string) =>
  JSON.stringify({
    schema: 1,
    release,
    channel: 'stable',
    published_at: '2026-11-08T00:00:00Z',
    changelog: '',
    components: {
      stationd: { kind: 'binary', version: release, source: 'registry.test/stationly/release', digest: null, platforms: { 'linux/amd64': sha('stationd') } },
      dispatch: { kind: 'image', version: release, source: 'registry.test/stationly/dispatch', digest: sha('index'), platforms: { 'linux/amd64': sha('amd64') } }
    }
  })

type Served = { blobs: Map<string, Buffer>; tags: Map<string, Buffer>; tamper: Set<string>; requests: string[]; tokens: number }

const listen = (handler: (req: IncomingMessage, res: ServerResponse) => void) =>
  new Promise<Server>(resolve => {
    const s = createServer(handler)
    s.listen(0, '127.0.0.1', () => resolve(s))
  })

const port = (s: Server) => (s.address() as AddressInfo).port

let registry: Server
let blobHost: Server
let state: Served
let host: string

const publish = (version: string, files: Record<string, string>, artifactType = releaseConfig.media_types.release_artifact) => {
  const layers = Object.entries(files).map(([title, body]) => {
    const b = Buffer.from(body)
    state.blobs.set(sha(b), b)
    return { mediaType: 'application/octet-stream', digest: sha(b), size: b.length, annotations: { 'org.opencontainers.image.title': title } }
  })
  const empty = Buffer.from('{}')
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', artifactType, config: { mediaType: 'application/vnd.oci.empty.v1+json', digest: sha(empty), size: 2 }, layers }))
  state.tags.set(`v${version}`, manifest)
  return sha(manifest)
}

before(async () => {
  blobHost = await listen((req, res) => {
    const digest = req.url!.slice(1)
    const blob = state.blobs.get(digest)
    if (!blob) return res.writeHead(404).end()
    res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(state.tamper.has(digest) ? Buffer.concat([blob, Buffer.from('x')]) : blob)
  })
  registry = await listen((req, res) => {
    const url = new URL(req.url!, 'http://x')
    state.requests.push(url.pathname)
    if (url.pathname === '/token') {
      state.tokens++
      assert.equal(url.searchParams.get('scope'), 'repository:stationly/release:pull')
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ token: 'anonymous-token' }))
    }
    if (req.headers.authorization !== 'Bearer anonymous-token') {
      return res.writeHead(401, { 'www-authenticate': `Bearer realm="http://${host}/token",service="registry.test",scope="repository:stationly/release:pull"` }).end()
    }
    const m = /^\/v2\/stationly\/release\/(manifests|blobs)\/(.+)$/.exec(url.pathname)
    if (!m) return res.writeHead(404).end()
    if (m[1] === 'manifests') {
      const body = state.tags.get(m[2]!)
      if (!body) return res.writeHead(404, { 'content-type': 'application/json' }).end('{"errors":[{"code":"MANIFEST_UNKNOWN"}]}')
      return res.writeHead(200, { 'content-type': 'application/vnd.oci.image.manifest.v1+json' }).end(body)
    }
    res.writeHead(307, { location: `http://127.0.0.1:${port(blobHost)}/${m[2]}` }).end()
  })
  host = `127.0.0.1:${port(registry)}`
  process.env.STATIONLY_INSECURE_REGISTRIES = host
  process.env.STATIONLY_RELEASES_REPOSITORY = `${host}/stationly/release`
})

after(() => {
  registry.close()
  blobHost.close()
  delete process.env.STATIONLY_INSECURE_REGISTRIES
  delete process.env.STATIONLY_RELEASES_REPOSITORY
})

beforeEach(() => {
  state = { blobs: new Map(), tags: new Map(), tamper: new Set(), requests: [], tokens: 0 }
})

describe('fetching a release from the releases repository', () => {
  test('reads the manifest and its bundle from the artifact tagged v<version>, through the token flow and the blob redirect', async () => {
    const raw = manifestFor('0.1.0')
    const digest = publish('0.1.0', { 'release-manifest.json': raw, 'release-manifest.json.sigstore.json': '{"bundle":true}', 'stationd-linux-amd64': 'stationd' })
    const got = await fetchRelease('0.1.0')
    assert.equal(got.manifestRaw, raw)
    assert.equal(got.bundle, '{"bundle":true}')
    assert.equal(got.manifestDigest, sha(raw))
    assert.equal(got.manifest.release, '0.1.0')
    assert.equal(got.source, `${host}/stationly/release:v0.1.0@${digest}`)
    assert.ok(state.tokens >= 1)
    assert.deepEqual(
      [...new Set(state.requests.filter(p => p.startsWith('/v2/')))],
      ['/v2/stationly/release/manifests/v0.1.0', `/v2/stationly/release/blobs/${sha(raw)}`, `/v2/stationly/release/blobs/${sha('{"bundle":true}')}`]
    )
  })

  test('an unknown version is RELEASE_NOT_FOUND', async () => {
    await assert.rejects(fetchRelease('9.9.9'), (e: unknown) => e instanceof ReleaseFetchError && e.code === 'RELEASE_NOT_FOUND')
  })

  test('an artifact without the manifest is RELEASE_NOT_FOUND', async () => {
    publish('0.1.1', { 'stationd-linux-amd64': 'stationd' })
    await assert.rejects(fetchRelease('0.1.1'), (e: unknown) => e instanceof ReleaseFetchError && e.code === 'RELEASE_NOT_FOUND' && /release-manifest\.json/.test(e.message))
  })

  test('a blob that does not match its digest is refused', async () => {
    const raw = manifestFor('0.1.2')
    publish('0.1.2', { 'release-manifest.json': raw, 'release-manifest.json.sigstore.json': '{}' })
    state.tamper.add(sha(raw))
    await assert.rejects(fetchRelease('0.1.2'), (e: unknown) => e instanceof ReleaseFetchError && e.code === 'SOURCE_UNREACHABLE' && /does not match its digest/.test(e.message))
  })

  test('a tag that is not a Stationly release artifact is refused', async () => {
    publish('0.1.3', { 'release-manifest.json': manifestFor('0.1.3'), 'release-manifest.json.sigstore.json': '{}' }, 'application/vnd.example.other')
    await assert.rejects(fetchRelease('0.1.3'), (e: unknown) => e instanceof ReleaseFetchError && /not a Stationly release artifact/.test(e.message))
  })

  test('a manifest of another release under the tag is refused', async () => {
    publish('0.1.4', { 'release-manifest.json': manifestFor('0.1.5'), 'release-manifest.json.sigstore.json': '{}' })
    await assert.rejects(fetchRelease('0.1.4'), (e: unknown) => e instanceof ReleaseFetchError && /is release 0\.1\.5, not 0\.1\.4/.test(e.message))
  })

  test('a version that is not semver is RELEASE_NOT_FOUND without a request', async () => {
    await assert.rejects(fetchRelease('latest'), (e: unknown) => e instanceof ReleaseFetchError && e.code === 'RELEASE_NOT_FOUND')
    assert.equal(state.requests.length, 0)
  })
})
