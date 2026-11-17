import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import type { FakeStation } from './helpers/fake-station.ts'
import { FakeRegistry } from './helpers/registry.ts'
import {
  createApp,
  createPreview,
  createProject,
  rows,
  seedLockfile,
  waitForDeployment,
} from './helpers/seed.ts'

let h: Dispatch
let registry: FakeRegistry
let station: FakeStation
let projectId: string
let web1: string
let web2: string

const token = () => h.admin.token

before(async () => {
  registry = FakeRegistry.install()
  registry.publish('nginx:1.27')
  h = await startDispatch()
  seedLockfile(h)
  station = await startFakeStation(h, 'station-1', {
    hold: ['web1', 'web2'],
  })
  const project = await createProject(h, 'rotation')
  const stage = await createPreview(h, 'rotation', 'stage')

  projectId = project.id
  const seeded = await h.call('PATCH', `/v1/projects/${projectId}/keys`, {
    token: token(),
    body: {
      target: 'preview',
      set: [
        {
          name: 'SHARED',
          kind: 'literal',
          value: 'one',
        },
      ],
      apply: false,
    },
  })

  assert.equal(seeded.status, 200, seeded.text)
  const reference = [
    {
      name: 'SHARED_REF',
      kind: 'reference',
      reference: '${{project.SHARED}}',
    },
  ]
  const first = await createApp(h, stage.id, {
    name: 'web1',
    ref: 'nginx:1.27',
    ports: [
      {
        port: 80,
      },
    ],
    keys: reference,
    deploy: true,
  })

  await waitForDeployment(h, first.deployments[0].id, 'active')
  const second = await createApp(h, stage.id, {
    name: 'web2',
    ref: 'nginx:1.27',
    ports: [
      {
        port: 80,
      },
    ],
    keys: reference,
    deploy: true,
  })

  await waitForDeployment(h, second.deployments[0].id, 'active')
  web1 = first.id
  web2 = second.id
})

after(async () => {
  await h.close()
  registry.restore()
})

const deploymentRows = (appId: string) =>
  rows<{ id: string; status: string }>(
    h,
    "select id, status from deployment where app_id = ? and trigger like '%key_change%'",
    appId,
  )

describe('secret rotation', () => {
  test('apply creates every dependent deployment but starts the second only after the first is active', async () => {
    const changed = await h.call('PATCH', `/v1/projects/${projectId}/keys`, {
      token: token(),
      body: {
        target: 'preview',
        set: [
          {
            name: 'SHARED',
            kind: 'literal',
            value: 'two',
          },
        ],
        apply: false,
      },
    })

    assert.equal(changed.status, 200, changed.text)
    const key = changed.body.keys[0].id as string
    const applied = await h.call('POST', `/v1/keys/${key}/apply`, {
      token: token(),
      body: {},
    })

    assert.equal(applied.status, 200, applied.text)
    assert.equal(applied.body.deployments.length, 2)

    const [firstId, secondId] = applied.body.deployments as [string, string]
    const firstApp = rows<{ app_id: string }>(
      h,
      'select app_id from deployment where id = ?',
      firstId,
    )[0]!.app_id
    const secondApp = rows<{ app_id: string }>(
      h,
      'select app_id from deployment where id = ?',
      secondId,
    )[0]!.app_id

    assert.notEqual(firstApp, secondApp)

    await station.waitFor(
      () =>
        station.heldDeployments().includes(firstId) &&
        deploymentRows(firstApp).find((d) => d.id === firstId && d.status === 'draining'),
      5000,
      'the first dependent draining',
    )
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(
      station.generations.some((g) => secondId in g.deployments),
      false,
      'the second dependent was sent to the station while the first was still draining',
    )
    assert.equal(deploymentRows(secondApp).find((d) => d.id === secondId)!.status, 'queued')

    station.release(firstId)
    await waitForDeployment(h, firstId, 'active')
    await station.waitFor(
      () => station.generations.some((g) => secondId in g.deployments),
      5000,
      'the second dependent sent after the first is active',
    )
    await station.waitFor(
      () => station.heldDeployments().includes(secondId),
      5000,
      'the second dependent draining',
    )
    station.release(secondId)
    await waitForDeployment(h, secondId, 'active')
    assert.ok([web1, web2].includes(firstApp) && [web1, web2].includes(secondApp))
  })
})
