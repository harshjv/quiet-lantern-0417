import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import { FakeRegistry } from './helpers/registry.ts'
import { createProject, createService, seedLockfile, waitForDeployment } from './helpers/seed.ts'

let h: Dispatch
let registry: FakeRegistry
let serviceId: string
let environmentId: string

before(async () => {
  registry = FakeRegistry.install()
  registry.publish('nginx:1.27')
  h = await startDispatch()
  seedLockfile(h)
  await startFakeStation(h)
  environmentId = (await createProject(h)).default_environment_id
  const created = await createService(h, environmentId, {
    name: 'web',
    ref: 'nginx:1.27',
    ports: [
      {
        port: 80,
      },
    ],
    deploy: true,
  })

  await waitForDeployment(h, created.deployments[0].id, 'active')
  serviceId = created.id
})

after(async () => {
  await h.close()
  registry.restore()
})

const get = (path: string) =>
  h.call('GET', path, {
    token: h.admin.token,
  })

describe('since and until grammar', () => {
  const forms = ['10m', '-10m', '2h', '-1d', '45s', new Date(Date.now() - 600_000).toISOString()]

  for (const form of forms) {
    test(`logs, deployments, runs and audit accept ${form}`, async () => {
      const encoded = encodeURIComponent(form)

      assert.equal(
        (
          await get(
            `/v1/logs?service=${serviceId}&since=${encoded}&until=${encodeURIComponent('-1s')}`,
          )
        ).status,
        200,
      )
      assert.equal(
        (await get(`/v1/services/${serviceId}/deployments?since=${encoded}`)).status,
        200,
      )
      assert.equal(
        (await get(`/v1/environments/${environmentId}/deployments?since=${encoded}`)).status,
        200,
      )
      assert.equal((await get(`/v1/services/${serviceId}/runs?since=${encoded}`)).status, 200)
      assert.equal((await get(`/v1/audit?since=${encoded}`)).status, 200)
    })
  }

  test('a bare relative duration means the same instant as its negative form', async () => {
    const bare = await get(`/v1/services/${serviceId}/deployments?since=10m`)
    const negative = await get(`/v1/services/${serviceId}/deployments?since=-10m`)

    assert.deepEqual(
      bare.body.items.map((d: { id: string }) => d.id),
      negative.body.items.map((d: { id: string }) => d.id),
    )
    assert.ok(bare.body.items.length > 0)
  })

  for (const bad of ['10', 'm10', '10x', 'yesterday', '--10m']) {
    test(`${bad} is VALIDATION_FAILED`, async () => {
      const reply = await get(`/v1/logs?service=${serviceId}&since=${encodeURIComponent(bad)}`)

      assert.equal(reply.status, 400)
      assert.equal(reply.body.error.code, 'VALIDATION_FAILED')
    })
  }
})
