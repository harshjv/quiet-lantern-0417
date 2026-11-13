import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { eq } from 'drizzle-orm'

import { service } from '../src/db/schema.ts'
import { emitEvent, serviceSubject } from '../src/station/events.ts'

import { startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import { FakeRegistry } from './helpers/registry.ts'
import { createProject, createService, seedLockfile } from './helpers/seed.ts'

let h: Dispatch
let registry: FakeRegistry
let environmentId: string

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

const view = async (seed: Omit<Parameters<typeof createService>[2], 'ref'>) => {
  const made = await createService(h, environmentId, {
    ...seed,
    ref: 'nginx:1.27',
  })

  return (
    await h.call('GET', `/v1/services/${made.id}?fields=health,health_default`, {
      token: h.admin.token,
    })
  ).body
}

describe('a service returns the health check that runs', () => {
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

  test('a cron service has no check and the default stands', async () => {
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

describe('a service that is not green says why', () => {
  const change = async (
    name: string,
    status: 'amber' | 'red',
    payload: Record<string, unknown>,
  ) => {
    const made = await createService(h, environmentId, {
      name,
      ref: 'nginx:1.27',
      ports: [
        {
          port: 8080,
        },
      ],
    })

    h.db
      .update(service)
      .set({
        status,
      })
      .where(eq(service.id, made.id))
      .run()
    emitEvent(h.db, 'health.changed', serviceSubject(h.db, made.id), {
      from: 'green',
      to: status,
      ...payload,
    })

    return (
      await h.call('GET', `/v1/services/${made.id}?fields=status,last_health_change`, {
        token: h.admin.token,
      })
    ).body
  }

  test('a failing check returns its state and count from the latest health.changed event', async () => {
    const body = await change('flaky', 'amber', {
      state: 'failing',
      consecutive: 2,
      last_check: '2026-11-13T10:00:00.000Z',
    })

    assert.equal(body.last_health_change.to, 'amber')
    assert.equal(body.last_health_change.state, 'failing')
    assert.equal(body.last_health_change.consecutive, 2)
    assert.equal(body.last_health_change.last_check, '2026-11-13T10:00:00.000Z')
  })

  test('a heartbeat change returns the health it reported and the status hint', async () => {
    const body = await change('stopped', 'red', {
      source: 'heartbeat',
      status_hint: 'stopped',
      health: 'none',
    })

    assert.equal(body.last_health_change.state, 'none')
    assert.equal(body.last_health_change.status_hint, 'stopped')
  })

  test('a green service returns null', async () => {
    const made = await createService(h, environmentId, {
      name: 'fine',
      ref: 'nginx:1.27',
      ports: [
        {
          port: 8080,
        },
      ],
    })
    const body = (
      await h.call('GET', `/v1/services/${made.id}?fields=last_health_change`, {
        token: h.admin.token,
      })
    ).body

    assert.equal(body.last_health_change, null)
  })
})
