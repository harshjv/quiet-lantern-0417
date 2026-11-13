import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import { FakeRegistry } from './helpers/registry.ts'
import { createProject, seedLockfile } from './helpers/seed.ts'

let h: Dispatch
let registry: FakeRegistry
let environmentId: string
let count = 0

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

const create = (extra: Record<string, unknown>, ports?: { port: number; protocol?: string }[]) => {
  count += 1

  return h.call('POST', `/v1/environments/${environmentId}/services`, {
    token: h.admin.token,
    body: {
      name: `svc${count}`,
      kind: 'web',
      source: {
        type: 'image',
        ref: 'nginx:1.27',
      },
      ports,
      deploy_on_create: false,
      ...extra,
    },
  })
}

const patch = (id: string, body: Record<string, unknown>) =>
  h.call('PATCH', `/v1/services/${id}`, {
    token: h.admin.token,
    body: {
      deploy: false,
      ...body,
    },
  })

const healthOf = async (id: string) =>
  (
    await h.call('GET', `/v1/services/${id}?fields=health`, {
      token: h.admin.token,
    })
  ).body.health

const issue = (reply: { body: any }) => reply.body.error.details.issues[0]

describe('a health check names a declared port', () => {
  test('a health port that is not declared is refused on create', async () => {
    const reply = await create(
      {
        health: {
          type: 'http',
          path: '/',
          port: 9090,
        },
      },
      [
        {
          port: 8080,
        },
      ],
    )

    assert.equal(reply.status, 400, reply.text)
    assert.equal(issue(reply).code, 'PORT_UNDECLARED')
    assert.equal(issue(reply).path, '/health/port')
  })

  test('a declared health port is stored with the timing defaults', async () => {
    const reply = await create(
      {
        health: {
          type: 'tcp',
          port: 5432,
        },
      },
      [
        {
          port: 5432,
          protocol: 'tcp',
        },
      ],
    )

    assert.equal(reply.status, 201, reply.text)
    const health = await healthOf(reply.body.id)

    assert.equal(health.port, 5432)
    assert.equal(health.interval_s, 5)
  })

  test('an alive check names no port and needs none', async () => {
    const reply = await create(
      {
        kind: 'worker',
        health: {
          type: 'alive',
          seconds: 5,
        },
      },
      undefined,
    )

    assert.equal(reply.status, 201, reply.text)
  })

  test('a patch with an undeclared health port is refused', async () => {
    const made = await create({}, [
      {
        port: 8080,
      },
    ])
    const reply = await patch(made.body.id, {
      health: {
        type: 'http',
        path: '/',
        port: 9090,
      },
    })

    assert.equal(reply.status, 400, reply.text)
    assert.equal(issue(reply).code, 'PORT_UNDECLARED')
    assert.equal(issue(reply).path, '/health/port')
  })

  test('a patch may move the ports and the health port together', async () => {
    const made = await create({}, [
      {
        port: 8080,
      },
    ])
    const moved = await patch(made.body.id, {
      ports: [
        {
          port: 3000,
        },
      ],
      health: {
        type: 'http',
        path: '/',
        port: 3000,
      },
    })

    assert.equal(moved.status, 200, moved.text)
    assert.equal((await healthOf(made.body.id)).port, 3000)
  })

  test('a patch that removes the port the stored health names is refused', async () => {
    const made = await create(
      {
        health: {
          type: 'http',
          path: '/',
          port: 8080,
        },
      },
      [
        {
          port: 8080,
        },
        {
          port: 9000,
        },
      ],
    )
    const reply = await patch(made.body.id, {
      ports: [
        {
          port: 9000,
        },
      ],
    })

    assert.equal(reply.status, 400, reply.text)
    assert.equal(issue(reply).code, 'PORT_UNDECLARED')
    assert.equal(issue(reply).path, '/ports')
  })

  test('a patch that removes a port no health check names is allowed', async () => {
    const made = await create({}, [
      {
        port: 8080,
      },
      {
        port: 9000,
      },
    ])
    const reply = await patch(made.body.id, {
      ports: [
        {
          port: 9000,
        },
      ],
    })

    assert.equal(reply.status, 200, reply.text)
  })
})
