import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import { FakeRegistry } from './helpers/registry.ts'
import { createProject, createService, seedLockfile, waitForDeployment } from './helpers/seed.ts'

let h: Dispatch
let registry: FakeRegistry
let environmentId: string

const token = () => h.admin.token

before(async () => {
  registry = FakeRegistry.install()
  registry.publish('nginx:1.27')
  h = await startDispatch()
  seedLockfile(h)
  await startFakeStation(h)
  environmentId = (await createProject(h)).default_environment_id
})

after(async () => {
  await h.close()
  registry.restore()
})

const activeService = async (name: string, variables: unknown[] = []) => {
  const created = await createService(h, environmentId, { name, ref: 'nginx:1.27', ports: [{ port: 80 }], variables, deploy: true })
  await waitForDeployment(h, created.deployments[0].id, 'active')
  return created.id as string
}

const stateOf = async (id: string) => (await h.call('GET', `/v1/services/${id}`, { token: token() })).body as { stale: boolean; stale_reasons: { code: string; keys: string[] }[] }

const setVariable = (id: string, value: string, key = 'FOO') =>
  h.call('PATCH', `/v1/services/${id}/variables`, { token: token(), body: { set: [{ key, kind: 'literal', value }], apply: false } })

const patchService = (id: string, body: Record<string, unknown>) => h.call('PATCH', `/v1/services/${id}`, { token: token(), body: { deploy: false, ...body } })

describe('variables', () => {
  test('a service with a current deployment and unchanged variables is not stale', async () => {
    const id = await activeService('fresh', [{ key: 'FOO', kind: 'literal', value: 'a' }])
    assert.deepEqual(await stateOf(id), { ...(await stateOf(id)), stale: false, stale_reasons: [] })
  })

  test('a service without a current deployment is never stale', async () => {
    const created = await createService(h, environmentId, { name: 'never-deployed', ref: 'nginx:1.27', ports: [{ port: 80 }], deploy: false })
    await setVariable(created.id, 'x')
    assert.equal((await stateOf(created.id)).stale, false)
  })

  test('changing a value marks the service stale with VARIABLES_CHANGED naming the key', async () => {
    const id = await activeService('changed', [{ key: 'FOO', kind: 'literal', value: 'a' }])
    const reply = await setVariable(id, 'b')
    assert.equal(reply.status, 200)
    const state = await stateOf(id)
    assert.equal(state.stale, true)
    assert.equal(state.stale_reasons[0]!.code, 'VARIABLES_CHANGED')
    assert.deepEqual(state.stale_reasons[0]!.keys, ['FOO'])
  })

  test('setting the value it already has is a no-op and leaves the service not stale', async () => {
    const id = await activeService('noop', [{ key: 'FOO', kind: 'literal', value: 'a' }])
    const reply = await setVariable(id, 'a')
    assert.equal(reply.status, 200)
    assert.equal((await stateOf(id)).stale, false)
  })

  test('writing the old value again is a new secret version, so the service stays stale until deployed', async () => {
    const id = await activeService('restored', [{ key: 'FOO', kind: 'literal', value: 'a' }])
    await setVariable(id, 'b')
    await setVariable(id, 'a')
    assert.equal((await stateOf(id)).stale, true)
  })

  test('a removed key marks the service stale', async () => {
    const id = await activeService('removed', [{ key: 'FOO', kind: 'literal', value: 'a' }])
    const reply = await h.call('PATCH', `/v1/services/${id}/variables`, { token: token(), body: { unset: ['FOO'], apply: false } })
    assert.equal(reply.status, 200)
    const state = await stateOf(id)
    assert.equal(state.stale, true)
    assert.deepEqual(state.stale_reasons[0]!.keys, ['FOO'])
  })

  test('staleness clears when a deployment carrying the new digest becomes active', async () => {
    const id = await activeService('activated', [{ key: 'FOO', kind: 'literal', value: 'a' }])
    await setVariable(id, 'b')
    assert.equal((await stateOf(id)).stale, true)
    const deployed = await h.call('POST', `/v1/services/${id}/deployments`, { token: token(), body: {} })
    assert.equal(deployed.status, 201)
    await waitForDeployment(h, deployed.body.id, 'active')
    assert.deepEqual((await stateOf(id)).stale_reasons, [])
    assert.equal((await stateOf(id)).stale, false)
  })

  test('a plain redeploy takes the current variable versions and clears staleness', async () => {
    const id = await activeService('redeploy-takes', [{ key: 'FOO', kind: 'literal', value: 'a' }])
    await setVariable(id, 'b')
    const redeployed = await h.call('POST', `/v1/services/${id}/redeploy`, { token: token(), body: {} })
    assert.equal(redeployed.status, 201)
    await waitForDeployment(h, redeployed.body.id, 'active')
    assert.equal((await stateOf(id)).stale, false)
  })

  test('restart pins the current deployment environment, so the service stays stale', async () => {
    const id = await activeService('restart-pins', [{ key: 'FOO', kind: 'literal', value: 'a' }])
    await setVariable(id, 'b')
    const restarted = await h.call('POST', `/v1/services/${id}/restart`, { token: token() })
    assert.equal(restarted.status, 200)
    await waitForDeployment(h, restarted.body.id, 'active')
    assert.equal((await stateOf(id)).stale, true)
  })
})

describe('configuration', () => {
  test('a limits change recorded against the deployment snapshot marks CONFIG_CHANGED naming the field', async () => {
    const id = await activeService('limits')
    const reply = await patchService(id, { limits: { memory_bytes: 268435456 } })
    assert.equal(reply.status, 200)
    const state = await stateOf(id)
    assert.equal(state.stale, true)
    assert.equal(state.stale_reasons[0]!.code, 'CONFIG_CHANGED')
    assert.deepEqual(state.stale_reasons[0]!.keys, ['limits'])
  })

  test('patching a field back to its snapshot value clears staleness', async () => {
    const id = await activeService('limits-back')
    await patchService(id, { limits: { memory_bytes: 268435456 } })
    assert.equal((await stateOf(id)).stale, true)
    await patchService(id, { limits: { memory_bytes: 536870912 } })
    assert.equal((await stateOf(id)).stale, false)
  })

  test('patching a field to the value it already has is a no-op', async () => {
    const id = await activeService('limits-same')
    const reply = await patchService(id, { limits: { memory_bytes: 536870912 } })
    assert.equal(reply.status, 200)
    assert.equal((await stateOf(id)).stale, false)
  })

  test('deploying the changed configuration clears CONFIG_CHANGED on activation', async () => {
    const id = await activeService('limits-deploy')
    await patchService(id, { limits: { memory_bytes: 268435456 } })
    const deployed = await h.call('POST', `/v1/services/${id}/deployments`, { token: token(), body: {} })
    await waitForDeployment(h, deployed.body.id, 'active')
    assert.equal((await stateOf(id)).stale, false)
  })

  test('variables and configuration reasons are reported together', async () => {
    const id = await activeService('both', [{ key: 'FOO', kind: 'literal', value: 'a' }])
    await setVariable(id, 'b')
    await patchService(id, { limits: { memory_bytes: 268435456 } })
    const codes = (await stateOf(id)).stale_reasons.map(r => r.code).sort()
    assert.deepEqual(codes, ['CONFIG_CHANGED', 'VARIABLES_CHANGED'])
  })
})
