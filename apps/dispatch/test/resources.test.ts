import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { virtual_ip } from '../src/db/schema.ts'
import { startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import { FakeRegistry } from './helpers/registry.ts'
import { createEnvironment, createProject, createService, pinPlatform, waitForActive } from './helpers/seed.ts'

let h: Dispatch
let registry: FakeRegistry
let token: string

const api = (method: string, path: string, body?: unknown, headers?: Record<string, string>) => h.call(method, path, { token, body, headers })

before(async () => {
  registry = FakeRegistry.install()
  registry.publish('traefik/whoami:v1')
  registry.publish('postgres:16')
  h = await startDispatch()
  token = h.admin.token
  pinPlatform(h)
  await startFakeStation(h)
})

after(async () => {
  await h?.close()
  registry?.restore()
})

const addresses = () => h.db.select().from(virtual_ip).all()

describe('virtual IPs', () => {
  test('services with the same name in two environments get different virtual IPs', async () => {
    const project = await createProject(h, 'vip')
    const staging = await createEnvironment(h, project.name, 'staging')
    const prod = await createService(h, project.default_environment_id, { name: 'web', ref: 'traefik/whoami:v1', ports: [{ port: 3000 }], deploy: true })
    const stage = await createService(h, staging.id, { name: 'web', ref: 'traefik/whoami:v1', ports: [{ port: 3000 }], deploy: true })
    const prodMap = (await api('GET', `/v1/environments/${project.default_environment_id}/network`)).body
    const stageMap = (await api('GET', `/v1/environments/${staging.id}/network`)).body
    const prodVip = prodMap.services.find((s: any) => s.id === prod.id).virtual_ip
    const stageVip = stageMap.services.find((s: any) => s.id === stage.id).virtual_ip
    assert.match(prodVip, /^100\.64\./)
    assert.match(stageVip, /^100\.64\./)
    assert.notEqual(prodVip, stageVip)
    assert.equal(prodMap.services.find((s: any) => s.id === prod.id).dns, 'web.internal')
    assert.equal(stageMap.services.find((s: any) => s.id === stage.id).dns, 'web.internal')
  })

  test('every virtual IP row is unique across the instance after deletes and new services', async () => {
    const project = await createProject(h, 'vip-churn')
    const envs = [project.default_environment_id, (await createEnvironment(h, project.name, 'qa')).id]
    const created: any[] = []
    for (const env of envs) for (const name of ['a', 'b', 'c']) created.push(await createService(h, env, { name, ref: 'traefik/whoami:v1', ports: [{ port: 80 }], deploy: true }))
    const doomed = created[1]
    const deleted = await api('DELETE', `/v1/services/${doomed.id}`)
    assert.equal(deleted.status, 200)
    for (const env of envs) await createService(h, env, { name: 'late', ref: 'traefik/whoami:v1', ports: [{ port: 80 }], deploy: true })
    const rows = addresses()
    assert.equal(new Set(rows.map(r => r.address)).size, rows.length)
    assert.ok(rows.every(r => r.address.startsWith('100.64.')))
  })
})

describe('ports', () => {
  test('changing a port protocol keeps the port row and its id', async () => {
    const project = await createProject(h, 'ports')
    const svc = await createService(h, project.default_environment_id, { name: 'db', ref: 'postgres:16', ports: [{ port: 5432, protocol: 'tcp' }], deploy: true })
    const before = svc.ports[0]
    const patched = await api('PATCH', `/v1/services/${svc.id}`, { ports: [{ port: 5432, protocol: 'http' }] })
    assert.equal(patched.status, 200)
    assert.equal(patched.body.ports.length, 1)
    assert.equal(patched.body.ports[0].id, before.id)
    assert.equal(patched.body.ports[0].protocol, 'http')
    const listed = (await api('GET', `/v1/services/${svc.id}/ports`)).body.items
    assert.deepEqual(listed.map((p: any) => [p.id, p.protocol]), [[before.id, 'http']])
  })

  test('a port with a TCP exposure cannot become http and one with a domain cannot become tcp', async () => {
    pinPlatform(h, { gateway: true })
    const project = await createProject(h, 'ports-dependents')
    const env = project.default_environment_id
    const tcp = await createService(h, env, { name: 'db', ref: 'postgres:16', ports: [{ port: 5432, protocol: 'tcp' }], deploy: true })
    const web = await createService(h, env, { name: 'web', ref: 'traefik/whoami:v1', ports: [{ port: 3000 }], deploy: true })
    const allocation = await api('POST', `/v1/ports/${tcp.ports[0].id}/port-allocations`, {})
    assert.equal(allocation.status, 201)
    const toHttp = await api('PATCH', `/v1/services/${tcp.id}`, { ports: [{ port: 5432, protocol: 'http' }] })
    assert.equal(toHttp.status, 409)
    assert.equal(toHttp.body.error.code, 'DELETE_HAS_DEPENDENTS')
    assert.equal(toHttp.body.error.details.dependents[0].id, allocation.body.id)
    const domain = await api('POST', `/v1/ports/${web.ports[0].id}/domains`, { hostname: 'web.shop.example.com' })
    assert.equal(domain.status, 201)
    const toTcp = await api('PATCH', `/v1/services/${web.id}`, { ports: [{ port: 3000, protocol: 'tcp' }] })
    assert.equal(toTcp.status, 409)
    assert.equal(toTcp.body.error.code, 'DELETE_HAS_DEPENDENTS')
    assert.equal(toTcp.body.error.details.dependents[0].id, domain.body.id)
    const still = (await api('GET', `/v1/services/${web.id}/ports`)).body.items[0]
    assert.equal(still.protocol, 'http')
    assert.equal(still.id, web.ports[0].id)
  })

  test('removing a port that a domain uses is refused with DELETE_HAS_DEPENDENTS', async () => {
    const project = await createProject(h, 'ports-delete')
    const web = await createService(h, project.default_environment_id, { name: 'web', ref: 'traefik/whoami:v1', ports: [{ port: 3000 }], deploy: true })
    const domain = await api('POST', `/v1/ports/${web.ports[0].id}/domains`, { hostname: 'delete.shop.example.com' })
    assert.equal(domain.status, 201)
    const removed = await api('DELETE', `/v1/ports/${web.ports[0].id}`)
    assert.equal(removed.status, 409)
    assert.equal(removed.body.error.code, 'DELETE_HAS_DEPENDENTS')
    const dropped = await api('DELETE', `/v1/domains/${domain.body.id}`)
    assert.equal(dropped.status, 200)
    const retry = await api('DELETE', `/v1/ports/${web.ports[0].id}`)
    assert.equal(retry.status, 200)
  })
})

describe('service dependents', () => {
  test('deleting a service that another service references is refused until the reference goes', async () => {
    const project = await createProject(h, 'dependents')
    const env = project.default_environment_id
    const db = await createService(h, env, { name: 'db', ref: 'postgres:16', ports: [{ port: 5432, protocol: 'tcp' }] })
    const web = await createService(h, env, {
      name: 'web',
      ref: 'traefik/whoami:v1',
      ports: [{ port: 3000 }],
      variables: [{ key: 'DATABASE_URL', kind: 'reference', reference: 'postgres://app@${{db.HOST}}:5432/app' }]
    })
    const refused = await api('DELETE', `/v1/services/${db.id}`)
    assert.equal(refused.status, 409)
    assert.equal(refused.body.error.code, 'DELETE_HAS_DEPENDENTS')
    assert.deepEqual(refused.body.error.details.dependents.map((d: any) => [d.entity, d.key, d.service_id]), [['variable', 'DATABASE_URL', web.id]])
    assert.equal((await api('GET', `/v1/services/${db.id}`)).status, 200)
    const cleared = await api('PATCH', `/v1/services/${web.id}`, { variables: [], deploy: false })
    assert.equal(cleared.status, 200)
    assert.equal((await api('DELETE', `/v1/services/${db.id}`)).status, 200)
  })
})

describe('no current deployment', () => {
  test('restart, redeploy and start answer NO_CURRENT_DEPLOYMENT for a service that never deployed', async () => {
    const project = await createProject(h, 'nocurrent')
    const svc = await createService(h, project.default_environment_id, { name: 'web', ref: 'traefik/whoami:v1', ports: [{ port: 3000 }] })
    for (const action of ['restart', 'redeploy', 'start']) {
      const reply = await api('POST', `/v1/services/${svc.id}/${action}`)
      assert.equal(reply.status, 409, action)
      assert.equal(reply.body.error.code, 'NO_CURRENT_DEPLOYMENT', action)
    }
    assert.equal((await api('GET', `/v1/services/${svc.id}/deployments`)).body.items.length, 0)
  })

  test('a configuration change on a service with no current deployment creates a manual deployment', async () => {
    const project = await createProject(h, 'nocurrent-config')
    const svc = await createService(h, project.default_environment_id, { name: 'web', ref: 'traefik/whoami:v1', ports: [{ port: 3000 }] })
    const patched = await api('PATCH', `/v1/services/${svc.id}`, { limits: { cpu_millis: 500 } })
    assert.equal(patched.status, 200)
    assert.equal(patched.body.deployments.length, 1)
    assert.equal(patched.body.deployments[0].trigger.type, 'manual')
    const current = await waitForActive(h, svc.id)
    assert.equal(current.current_deployment_id, patched.body.deployments[0].id)
  })

  test('the same change with deploy = false creates nothing', async () => {
    const project = await createProject(h, 'nocurrent-hold')
    const svc = await createService(h, project.default_environment_id, { name: 'web', ref: 'traefik/whoami:v1', ports: [{ port: 3000 }] })
    const patched = await api('PATCH', `/v1/services/${svc.id}`, { limits: { cpu_millis: 500 }, deploy: false })
    assert.equal(patched.status, 200)
    assert.deepEqual(patched.body.deployments, [])
  })
})

describe('domains and the Gateway pin', () => {
  test('a domain is refused with GATEWAY_NOT_PINNED while the lockfile pins no gateway, then accepted once it does', async () => {
    pinPlatform(h, { gateway: false })
    const project = await createProject(h, 'gateway')
    const web = await createService(h, project.default_environment_id, { name: 'web', ref: 'traefik/whoami:v1', ports: [{ port: 3000 }] })
    const refused = await api('POST', `/v1/ports/${web.ports[0].id}/domains`, { hostname: 'gate.shop.example.com' })
    assert.equal(refused.status, 409)
    assert.equal(refused.body.error.code, 'GATEWAY_NOT_PINNED')
    assert.equal(refused.body.error.details.release, '0.0.0-test')
    assert.equal((await api('GET', `/v1/services/${web.id}/domains`)).body.items.length, 0)
    pinPlatform(h, { gateway: true })
    const accepted = await api('POST', `/v1/ports/${web.ports[0].id}/domains`, { hostname: 'gate.shop.example.com' })
    assert.equal(accepted.status, 201)
    assert.equal(accepted.body.hostname, 'gate.shop.example.com')
  })

  test('a domain on a tcp port is refused as invalid, not as an unpinned gateway', async () => {
    const project = await createProject(h, 'gateway-tcp')
    const db = await createService(h, project.default_environment_id, { name: 'db', ref: 'postgres:16', ports: [{ port: 5432, protocol: 'tcp' }] })
    const refused = await api('POST', `/v1/ports/${db.ports[0].id}/domains`, { hostname: 'db.shop.example.com' })
    assert.equal(refused.status, 400)
    assert.equal(refused.body.error.code, 'VALIDATION_FAILED')
  })
})
