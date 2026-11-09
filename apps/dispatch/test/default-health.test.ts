import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import type { FakeStation } from './helpers/fake-station.ts'
import { FakeRegistry } from './helpers/registry.ts'
import { createProject, createService, pinPlatform, seedLockfile, waitForDeployment } from './helpers/seed.ts'

let h: Dispatch
let registry: FakeRegistry
let station: FakeStation
let environmentId: string

before(async () => {
  registry = FakeRegistry.install()
  registry.publish('nginx:1.27')
  h = await startDispatch()
  seedLockfile(h)
  station = await startFakeStation(h)
  environmentId = (await createProject(h)).default_environment_id
})

after(async () => {
  await h.close()
  registry.restore()
})

const targetHealth = async (seed: Omit<Parameters<typeof createService>[2], 'ref' | 'deploy'>) => {
  const created = await createService(h, environmentId, { ...seed, ref: 'nginx:1.27', deploy: true })
  const deploymentId = created.deployments[0].id as string
  await waitForDeployment(h, deploymentId, 'active')
  const doc = await station.waitForGeneration(g => deploymentId in g.deployments)
  return (doc.deployments[deploymentId] as unknown as { target: { health: unknown } }).target.health
}

describe('default health checks by service kind', () => {
  test('a web service with an http port and no health gets the http check on that port', async () => {
    assert.deepEqual(await targetHealth({ name: 'web', ports: [{ port: 8080 }] }), { type: 'http', path: '/', port: 8080, interval_s: 5, timeout_s: 3, passes: 2, failures: 3, startup_timeout_s: 120, host: 'web.internal' })
  })

  test('a web service with only a tcp port gets the tcp check', async () => {
    assert.deepEqual(await targetHealth({ name: 'db', ports: [{ port: 5432, protocol: 'tcp' }] }), { type: 'tcp', port: 5432, interval_s: 5, timeout_s: 3, passes: 2, failures: 3, startup_timeout_s: 60 })
  })

  test('a worker gets the alive check', async () => {
    assert.deepEqual(await targetHealth({ name: 'jobs', kind: 'worker' }), { type: 'alive', seconds: 10 })
  })

  test('a web service left without ports gets the alive check', async () => {
    const created = await createService(h, environmentId, { name: 'portless', ref: 'nginx:1.27', ports: [{ port: 8081 }], deploy: true })
    await waitForDeployment(h, created.deployments[0].id, 'active')
    assert.equal((await h.call('DELETE', `/v1/ports/${created.ports[0].id}`, { token: h.admin.token })).status, 200)
    const redeployed = await h.call('POST', `/v1/services/${created.id}/redeploy`, { token: h.admin.token, body: {} })
    assert.equal(redeployed.status, 201, redeployed.text)
    const deploymentId = redeployed.body.id as string
    const doc = await station.waitForGeneration(g => deploymentId in g.deployments)
    assert.deepEqual((doc.deployments[deploymentId] as unknown as { target: { health: unknown } }).target.health, { type: 'alive', seconds: 10 })
  })

  test('an explicit check keeps the spec defaults for the fields it omits', async () => {
    const health = await targetHealth({ name: 'custom', ports: [{ port: 3000 }], extra: { health: { type: 'tcp', port: 3000 } } })
    assert.deepEqual(health, { type: 'tcp', port: 3000, interval_s: 5, timeout_s: 3, passes: 2, failures: 3, startup_timeout_s: 60 })
  })

  test('an http check sends the service first domain as Host once it has one', async () => {
    const created = await createService(h, environmentId, { name: 'domained', ref: 'nginx:1.27', ports: [{ port: 8082 }], deploy: true })
    await waitForDeployment(h, created.deployments[0].id, 'active')
    pinPlatform(h, { gateway: true })
    const added = await h.call('POST', `/v1/ports/${created.ports[0].id}/domains`, { token: h.admin.token, body: { hostname: 'bugsink.sly.test' } })
    assert.equal(added.status, 201, added.text)
    const redeployed = await h.call('POST', `/v1/services/${created.id}/redeploy`, { token: h.admin.token, body: {} })
    assert.equal(redeployed.status, 201, redeployed.text)
    const deploymentId = redeployed.body.id as string
    const doc = await station.waitForGeneration(g => deploymentId in g.deployments)
    const health = (doc.deployments[deploymentId] as unknown as { target: { health: { host: string } } }).target.health
    assert.equal(health.host, 'bugsink.sly.test')
  })

  test('health.host overrides the derived Host', async () => {
    const health = (await targetHealth({ name: 'override', ports: [{ port: 3001 }], extra: { health: { type: 'http', path: '/up', port: 3001, host: 'health.local' } } })) as { host: string; path: string }
    assert.equal(health.host, 'health.local')
    assert.equal(health.path, '/up')
  })

  test('health.host is refused on a tcp check', async () => {
    const res = await h.call('POST', `/v1/environments/${environmentId}/services`, {
      token: h.admin.token,
      body: { name: 'badhost', kind: 'web', source: { type: 'image', ref: 'nginx:1.27' }, ports: [{ port: 3002 }], health: { type: 'tcp', port: 3002, host: 'x.local' } }
    })
    assert.equal(res.status, 400, res.text)
  })
})
