import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import { FakeRegistry } from './helpers/registry.ts'
import { createProject, seedLockfile, waitForDeployment } from './helpers/seed.ts'

let h: Dispatch
let registry: FakeRegistry
let environmentId: string

const token = () => h.admin.token
const servicesNamed = () => (h.db as any).$client.prepare("select name from service").all() as { name: string }[]
const getService = async (id: string) => (await h.call('GET', `/v1/services/${id}`, { token: token() })).body

before(async () => {
  registry = FakeRegistry.install()
  h = await startDispatch()
  seedLockfile(h)
  await startFakeStation(h)
  environmentId = (await createProject(h)).default_environment_id
})

after(async () => {
  await h.close()
  registry.restore()
})

const create = (body: Record<string, unknown>) => h.call('POST', `/v1/environments/${environmentId}/services`, { token: token(), body })

describe('creating a service from an image', () => {
  test('a tag resolves to the registry digest and the response says so', async () => {
    const digest = registry.publish('nginx:1.27')
    const reply = await create({ name: 'tagged', kind: 'web', source: { type: 'image', ref: 'nginx:1.27' }, ports: [{ port: 80 }], deploy_on_create: false })
    assert.equal(reply.status, 201)
    assert.deepEqual(reply.body.source, { type: 'image', ref: 'nginx:1.27', digest })
    const pinned = reply.body.warnings.find((w: { code: string }) => w.code === 'IMAGE_PINNED')
    assert.match(pinned.explanation, /linux\/arm64, linux\/amd64/)
    assert.match(pinned.explanation, new RegExp(`docker.io/library/nginx@${digest}`))
  })

  test('the first deployment runs the pinned digest reference, never the tag', async () => {
    const digest = registry.publish('redis:7')
    const reply = await create({ name: 'deployed', kind: 'web', source: { type: 'image', ref: 'redis:7' }, ports: [{ port: 6379, protocol: 'tcp' }] })
    assert.equal(reply.status, 201)
    assert.equal(reply.body.deployments[0].image_ref, `docker.io/library/redis@${digest}`)
  })

  test('a digest reference is verified against the registry and kept', async () => {
    const digest = registry.publish('caddy:2')
    const reply = await create({ name: 'by-digest', kind: 'web', source: { type: 'image', ref: `caddy@${digest}` }, ports: [{ port: 80 }], deploy_on_create: false })
    assert.equal(reply.status, 201)
    assert.equal(reply.body.source.digest, digest)
  })
})

describe('a failed lookup answers at request time and creates nothing', () => {
  const refuses = async (name: string, ref: string, code: string, reason: string | null, status: number) => {
    const before = servicesNamed().length
    const reply = await create({ name, kind: 'web', source: { type: 'image', ref }, ports: [{ port: 80 }], deploy_on_create: false })
    assert.equal(reply.status, status)
    assert.equal(reply.body.error.code, code)
    if (reason) assert.equal(reply.body.error.details.reason, reason)
    assert.equal(servicesNamed().length, before)
    assert.equal(servicesNamed().some(s => s.name === name), false)
    return reply.body.error
  }

  test('a missing tag is not_found', async () => {
    await refuses('missing-tag', 'nginx:no-such-tag', 'SOURCE_UNREACHABLE', 'not_found', 422)
  })

  test('an unknown repository is repository_not_found', async () => {
    registry.fail('ghost:1', 404, { errors: [{ code: 'NAME_UNKNOWN' }] })
    await refuses('ghost', 'ghost:1', 'SOURCE_UNREACHABLE', 'repository_not_found', 422)
  })

  test('401 from the registry is auth_required', async () => {
    registry.fail('private/app:1', 401, { errors: [{ code: 'UNAUTHORIZED' }] })
    await refuses('private', 'private/app:1', 'SOURCE_UNREACHABLE', 'auth_required', 422)
  })

  test('429 is rate_limited and carries retry_after_s', async () => {
    registry.fail('busy:1', 429, { errors: [{ code: 'TOOMANYREQUESTS' }] }, { 'retry-after': '90' })
    const error = await refuses('busy', 'busy:1', 'SOURCE_UNREACHABLE', 'rate_limited', 422)
    assert.equal(error.details.retry_after_s, 90)
  })

  test('5xx is unreachable', async () => {
    registry.fail('flaky:1', 503)
    await refuses('flaky', 'flaky:1', 'SOURCE_UNREACHABLE', 'unreachable', 422)
  })

  test('a manifest whose sha256 differs from the digest in ref is digest_mismatch', async () => {
    const claimed = `sha256:${'a'.repeat(64)}`
    registry.fail(`tampered@${claimed}`, 200, { schemaVersion: 2 })
    await refuses('tampered', `tampered@${claimed}`, 'SOURCE_UNREACHABLE', 'digest_mismatch', 422)
  })

  test('an image without linux/arm64 fails with STATION_CAPABILITY_MISSING', async () => {
    registry.publish('amd-only:1', ['linux/amd64'])
    const error = await refuses('amd-only', 'amd-only:1', 'STATION_CAPABILITY_MISSING', 'platform_missing', 422)
    assert.deepEqual(error.details.platforms, ['linux/amd64'])
  })

  test('an unparseable reference is VALIDATION_FAILED', async () => {
    await refuses('bad-ref', 'Not_A_Valid/Ref:tag', 'VALIDATION_FAILED', null, 400)
  })
})

describe('keeping and refreshing the digest', () => {
  let serviceId: string
  let first: string
  let second: string

  before(async () => {
    first = registry.publish('app:stable')
    const created = await create({ name: 'moving', kind: 'web', source: { type: 'image', ref: 'app:stable' }, ports: [{ port: 80 }] })
    serviceId = created.body.id
    await waitForDeployment(h, created.body.deployments[0].id, 'active')
    second = registry.publish('app:stable')
    assert.notEqual(first, second)
  })

  test('redeploy keeps the digest the current deployment ran', async () => {
    const reply = await h.call('POST', `/v1/services/${serviceId}/redeploy`, { token: token(), body: {} })
    assert.equal(reply.status, 201)
    assert.equal(reply.body.image_ref, `docker.io/library/app@${first}`)
    assert.equal((await getService(serviceId)).source.digest, first)
    await waitForDeployment(h, reply.body.id, 'active')
  })

  test('restart keeps the digest', async () => {
    const reply = await h.call('POST', `/v1/services/${serviceId}/restart`, { token: token() })
    assert.equal(reply.status, 200)
    assert.equal(reply.body.image_ref, `docker.io/library/app@${first}`)
    await waitForDeployment(h, reply.body.id, 'active')
  })

  test('PATCH with an unchanged ref keeps the digest without asking the registry', async () => {
    const seen = registry.manifestRequests().length
    const reply = await h.call('PATCH', `/v1/services/${serviceId}`, { token: token(), body: { source: { type: 'image', ref: 'app:stable' }, deploy: false } })
    assert.equal(reply.status, 200)
    assert.equal(reply.body.source.digest, first)
    assert.equal(registry.manifestRequests().length, seen)
  })

  test('deploy resolves the tag again and updates source.digest', async () => {
    const reply = await h.call('POST', `/v1/services/${serviceId}/deployments`, { token: token(), body: {} })
    assert.equal(reply.status, 201)
    assert.equal(reply.body.image_ref, `docker.io/library/app@${second}`)
    assert.equal((await getService(serviceId)).source.digest, second)
    assert.ok(reply.body.warnings.some((w: { code: string }) => w.code === 'IMAGE_PINNED'))
    await waitForDeployment(h, reply.body.id, 'active')
  })

  test('redeploy after a deploy keeps the newly resolved digest while the tag moves on', async () => {
    registry.publish('app:stable')
    const reply = await h.call('POST', `/v1/services/${serviceId}/redeploy`, { token: token(), body: {} })
    assert.equal(reply.body.image_ref, `docker.io/library/app@${second}`)
    await waitForDeployment(h, reply.body.id, 'active')
  })

  test('rollback restores the digest of the deployment it names', async () => {
    const listed = await h.call('GET', `/v1/services/${serviceId}/deployments`, { token: token() })
    const oldest = listed.body.items.find((d: { number: number }) => d.number === 1)
    const reply = await h.call('POST', `/v1/services/${serviceId}/rollback`, { token: token(), body: { deployment_id: oldest.id } })
    assert.equal(reply.status, 201)
    assert.equal(reply.body.image_ref, `docker.io/library/app@${first}`)
    assert.equal((await getService(serviceId)).source.digest, first)
  })
})
