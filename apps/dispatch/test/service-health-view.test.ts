import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { eq } from 'drizzle-orm'

import { app } from '../src/db/schema.ts'
import { appSubject, emitEvent } from '../src/station/events.ts'

import { startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import type { FakeStation } from './helpers/fake-station.ts'
import { FakeRegistry } from './helpers/registry.ts'
import {
  createApp,
  createPreview,
  createProject,
  seedLockfile,
  waitForActive,
} from './helpers/seed.ts'

let h: Dispatch
let registry: FakeRegistry
let station: FakeStation
let previewId: string

before(async () => {
  registry = FakeRegistry.install()
  registry.publish('nginx:1.27')
  h = await startDispatch()
  seedLockfile(h)
  station = await startFakeStation(h)
  previewId = (await createPreview(h, (await createProject(h)).id, 'staging')).id
})

after(async () => {
  await h.close()
  registry.restore()
})

const view = async (seed: Omit<Parameters<typeof createApp>[2], 'ref'>) => {
  const made = await createApp(h, previewId, {
    ...seed,
    ref: 'nginx:1.27',
  })

  return (
    await h.call('GET', `/v1/apps/${made.id}?fields=health,health_default`, {
      token: h.admin.token,
    })
  ).body
}

describe('an app returns the health check that runs', () => {
  test('an http port with no health set returns the default http check', async () => {
    const body = await view({
      name: 'web',
      ports: [
        {
          port: 8080,
        },
      ],
    })

    assert.equal(body.health_default, true)
    assert.deepEqual(body.health, {
      type: 'http',
      path: '/',
      port: 8080,
      interval_s: 5,
      timeout_s: 3,
      passes: 2,
      failures: 3,
      startup_timeout_s: 120,
    })
  })

  test('only tcp ports return the tcp check on the first port', async () => {
    const body = await view({
      name: 'db',
      ports: [
        {
          port: 5432,
          protocol: 'tcp',
        },
      ],
    })

    assert.equal(body.health_default, true)
    assert.equal(body.health.type, 'tcp')
    assert.equal(body.health.port, 5432)
  })

  test('a worker returns the alive check', async () => {
    const body = await view({
      name: 'jobs',
      kind: 'worker',
    })

    assert.equal(body.health_default, true)
    assert.deepEqual(body.health, {
      type: 'alive',
      seconds: 10,
    })
  })

  test('a cron app has no check and the default stands', async () => {
    const body = await view({
      name: 'nightly',
      kind: 'cron',
      extra: {
        schedule: {
          cron: '0 3 * * *',
          timezone: 'UTC',
          concurrency: 'skip',
        },
      },
    })

    assert.equal(body.health, null)
    assert.equal(body.health_default, true)
  })

  test('a check the operator set returns as set and is not the default', async () => {
    const body = await view({
      name: 'api',
      ports: [
        {
          port: 8080,
        },
        {
          port: 9000,
        },
      ],
      extra: {
        health: {
          type: 'http',
          path: '/ready',
          port: 9000,
          interval_s: 10,
        },
      },
    })

    assert.equal(body.health_default, false)
    assert.equal(body.health.port, 9000)
    assert.equal(body.health.path, '/ready')
    assert.equal(body.health.interval_s, 10)
    assert.equal(body.health.timeout_s, 3)
  })
})

const appBody = async (id: string) =>
  (
    await h.call('GET', `/v1/apps/${id}?fields=status,current_deployment_id,last_health_change`, {
      token: h.admin.token,
    })
  ).body

const waitForStatus = async (id: string, status: string) => {
  const deadline = Date.now() + 8000

  for (;;) {
    const body = await appBody(id)

    if (body.status === status) {
      return body
    }

    if (Date.now() > deadline) {
      throw new Error(`app ${id} is ${body.status}, never ${status}`)
    }

    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const deployed = async (name: string) => {
  const made = await createApp(h, previewId, {
    name,
    ref: 'nginx:1.27',
    ports: [
      {
        port: 8080,
      },
    ],
    deploy: true,
  })
  const active = await waitForActive(h, made.id)

  return {
    id: made.id as string,
    deployment: active.current_deployment_id as string,
  }
}

describe('Dispatch derives the app status', () => {
  test('an active deployment whose check passes is healthy and says nothing about health', async () => {
    const made = await deployed('fine')
    const body = await waitForStatus(made.id, 'healthy')

    assert.equal(body.last_health_change, null)
  })

  test('a check failing within its tolerance stays healthy; beyond it the app is failing and says why', async () => {
    const made = await deployed('flaky')

    await waitForStatus(made.id, 'healthy')
    station.reportHealth({
      service_id: made.id,
      deployment_id: made.deployment,
      state: 'failing',
      consecutive: 2,
    })
    station.reportHealth({
      service_id: made.id,
      deployment_id: made.deployment,
      state: 'failed',
      consecutive: 3,
    })

    const body = await waitForStatus(made.id, 'failing')

    assert.equal(body.last_health_change.from, 'healthy')
    assert.equal(body.last_health_change.to, 'failing')
    assert.equal(body.last_health_change.state, 'failed')
    assert.equal(body.last_health_change.consecutive, 3)

    station.reportHealth({
      service_id: made.id,
      deployment_id: made.deployment,
      state: 'passing',
      consecutive: 2,
    })

    assert.equal((await waitForStatus(made.id, 'healthy')).last_health_change, null)
  })

  test('a stopped app is stopped, and starts again from a passing check', async () => {
    const made = await deployed('paused')

    station.reportHealth({
      service_id: made.id,
      deployment_id: made.deployment,
      state: 'failed',
      consecutive: 3,
    })
    await waitForStatus(made.id, 'failing')
    await h.call('POST', `/v1/apps/${made.id}/stop`, {
      token: h.admin.token,
    })

    assert.equal((await appBody(made.id)).status, 'stopped')

    await h.call('POST', `/v1/apps/${made.id}/start`, {
      token: h.admin.token,
    })

    assert.equal((await appBody(made.id)).status, 'healthy')
  })

  test('an app that should run with nothing deployed is not deployed', async () => {
    const made = await createApp(h, previewId, {
      name: 'undeployed',
      ref: 'nginx:1.27',
      ports: [
        {
          port: 8080,
        },
      ],
    })

    assert.equal((await appBody(made.id)).status, 'not_deployed')
  })

  test('a heartbeat change returns the health it reported and the status hint', async () => {
    const made = await createApp(h, previewId, {
      name: 'gone',
      ref: 'nginx:1.27',
      ports: [
        {
          port: 8080,
        },
      ],
    })

    h.db
      .update(app)
      .set({
        status: 'failing',
      })
      .where(eq(app.id, made.id))
      .run()
    emitEvent(h.db, 'health.changed', appSubject(h.db, made.id), {
      from: 'healthy',
      to: 'failing',
      source: 'heartbeat',
      status_hint: 'stopped',
      health: 'none',
    })

    const body = await appBody(made.id)

    assert.equal(body.last_health_change.state, 'none')
    assert.equal(body.last_health_change.status_hint, 'stopped')
  })
})
