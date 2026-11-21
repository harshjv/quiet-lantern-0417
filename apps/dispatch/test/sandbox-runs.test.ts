import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { eq } from 'drizzle-orm'

import { machineExecLimits, workspaceEnv } from '@stationly/protocol'

import { waitForRun } from '../src/api/runs.ts'
import { newId } from '../src/db/ids.ts'
import { run } from '../src/db/schema.ts'
import { requestDeletion, stopMachine, systemActor } from '../src/sandboxes/lifecycle.ts'

import { startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import type { FakeStation } from './helpers/fake-station.ts'
import {
  createMachine,
  createPreview,
  createProject,
  machineRowOf,
  pinPlatform,
  rows,
  waitForMachine,
} from './helpers/seed.ts'

let h: Dispatch
let station: FakeStation
let project: any
let envId: string
let boxId: string
let setupRunId: string

const api = (method: string, path: string, body?: unknown, token = h.admin.token) =>
  h.call(method, path, {
    token,
    body,
  })

const secret = 'ghp_projectsecret0123456789'
const rotated = 'ghp_rotatedsecret9876543210'

const plantRun = (machineId: string, values: Partial<typeof run.$inferInsert> = {}) => {
  const id = newId('run')

  h.db
    .insert(run)
    .values({
      id,
      app_id: null,
      machine_id: machineId,
      deployment_id: null,
      kind: 'exec',
      command: ['bash'],
      status: 'queued',
      log_ref: `logs/${id}`,
      tty: false,
      ...values,
    })
    .run()

  return id
}

const deliveryOf = (machineId: string) =>
  station.waitFor(
    () =>
      station.secrets.filter((s) => s.target.sandbox_id === machineId && s.values.GH_TOKEN).at(-1),
    8000,
    'the machine delivery',
  )

before(async () => {
  h = await startDispatch()
  pinPlatform(h, {
    machines: true,
  })
  station = await startFakeStation(h, 'station-1', {
    machines: {
      runOutput: (command, env) => [`$ ${command.join(' ')}`, `env ${JSON.stringify(env)}`],
    },
  })
  project = await createProject(h, 'alpha')
  envId = (await createPreview(h, 'alpha', 'dev')).id
  const projectVars = await api('PATCH', `/v1/projects/alpha/environment-variables`, {
    target: 'preview',
    set: [
      {
        name: 'GH_TOKEN',
        kind: 'secret',
        value: secret,
      },
    ],
  })

  assert.equal(projectVars.status, 200, projectVars.text)
  const box = await createMachine(h, envId, {
    name: 'worker',
  })

  boxId = box.id
  setupRunId = box.workspace!.setup_run_id
  await waitForMachine(h, boxId, 'running')
})

after(async () => {
  await h.close()
})

describe('machine runs', () => {
  test('the workspace setup run goes through stationd and its output is untrusted and redacted', async () => {
    const delivery = await deliveryOf(boxId)
    const key = delivery.values[workspaceEnv.token]!
    const reply = await api('GET', `/v1/runs/${setupRunId}?wait_s=5`)

    assert.equal(reply.status, 200, reply.text)
    const body = reply.body

    assert.deepEqual(
      [body.kind, body.machine_id, body.app_id, body.deployment_id, body.status, body.exit_code],
      ['exec', boxId, null, null, 'succeeded', 0],
    )
    assert.equal(body.output.untrusted.source, 'machine exec output')
    assert.match(body.output.untrusted.text, /^stdout: \$ /)
    const text = body.output.untrusted.text

    for (const value of [key, secret]) {
      assert.ok(!text.includes(value), `${value} leaked: ${text}`)
    }

    assert.match(text, /\[redacted:GH_TOKEN\]/)
    assert.match(text, new RegExp(`\\[redacted:${workspaceEnv.token}\\]`))
    const sent = station.received.find(
      (m) => m.type === 'run.start' && (m.body as any).run_id === setupRunId,
    )!.body as any

    assert.deepEqual(
      [sent.service_id, sent.deployment_id, sent.sandbox_id, sent.kind, sent.attach, sent.tty],
      [null, null, boxId, 'exec', false, false],
    )
    const logs = await api('GET', `/v1/logs?run=${setupRunId}&tail=50`)

    assert.equal(logs.status, 200, logs.text)
    assert.ok(!logs.text.includes(secret) && !logs.text.includes(key))
    assert.match(logs.text, /\[redacted:/)
  })

  test('deadline_at is when the run is killed for its timeout, and null for a run without one', async () => {
    const read = async (id: string) =>
      (await api('GET', `/v1/runs/${id}?fields=created_at,started_at,deadline_at`)).body
    const setup = await read(setupRunId)

    assert.equal(
      setup.deadline_at,
      new Date(
        Date.parse(setup.started_at ?? setup.created_at) +
          machineExecLimits.timeoutS.default * 1000,
      ).toISOString(),
    )
    const id = plantRun(boxId, {
      kind: 'one_off',
      command: ['migrate'],
      status: 'running',
    })

    assert.equal((await read(id)).deadline_at, null)
  })

  test('a failed machine run has a diagnosis', async () => {
    const id = plantRun(boxId, {
      command: ['false'],
      status: 'failed',
      exit_code: 1,
      failure: {
        phase: 'run',
        code: 'EXIT_NONZERO',
        summary: 'exited 1',
      },
    })
    const diagnosis = await api('GET', `/v1/runs/${id}/diagnosis`)

    assert.equal(diagnosis.status, 200, diagnosis.text)
    assert.equal(diagnosis.body.entity.id, id)
    assert.equal(diagnosis.body.code, 'EXIT_NONZERO')
  })

  test('a queued machine run is cancellable through the common route', async () => {
    const id = plantRun(boxId)
    const cancelled = await api('POST', `/v1/runs/${id}/cancel`)

    assert.equal(cancelled.status, 200, cancelled.text)
    assert.equal(cancelled.body.status, 'cancelled')
  })

  test('a missing run is NOT_FOUND on the shared run paths', async () => {
    const missing = newId('run')

    for (const path of [`/v1/runs/${missing}`, `/v1/runs/${missing}?wait_s=2`]) {
      const reply = await api('GET', path)

      assert.equal(reply.status, 404, path)
      assert.equal(reply.body.error.code, 'NOT_FOUND')
    }

    const queued = plantRun(boxId)
    const waiting = waitForRun(h.db, queued, 5, new AbortController().signal)

    h.db.delete(run).where(eq(run.id, queued)).run()
    await assert.rejects(waiting, {
      code: 'NOT_FOUND',
      message: `run ${queued} does not exist or is not visible to this credential.`,
    })
  })

  test('stopping a machine cancels its queued and running runs', async () => {
    const box = await createMachine(h, envId, {
      name: 'stopping-runs',
    })

    await waitForMachine(h, box.id, 'running')
    const queued = plantRun(box.id)

    stopMachine(h.db, machineRowOf(h, box.id))
    await waitForMachine(h, box.id, 'stopped')
    assert.equal((await api('GET', `/v1/runs/${queued}`)).body.status, 'cancelled')
  })
})

describe('environment variables', () => {
  test('workspace variables are machine rows delivered to stationd as purpose sandbox with the project reference resolved', async () => {
    const names = rows<{ name: string; scope: string }>(
      h,
      'select name, scope from environment_variable where machine_id = ?',
      boxId,
    )

    assert.ok(names.every((v) => v.scope === 'machine'))
    assert.ok(names.some((v) => v.name === workspaceEnv.token))
    assert.ok(names.some((v) => v.name === 'GH_TOKEN'))
    const delivery = await deliveryOf(boxId)

    assert.equal(delivery.purpose, 'sandbox')
    assert.equal(delivery.values.GH_TOKEN, secret)
    assert.equal(delivery.values[workspaceEnv.project], project.id)
    assert.equal(delivery.values[workspaceEnv.preview], envId)
    assert.ok(delivery.values[workspaceEnv.token]!.length > 0)
  })

  test('a changed referenced project value is delivered again and the generation env_digest follows it', async () => {
    const before = (
      await station.waitForGeneration((d) => d.sandboxes?.[boxId]?.env_digest !== undefined)
    ).sandboxes![boxId]!.env_digest
    const deliveries = station.secrets.filter((s) => s.target.sandbox_id === boxId).length

    assert.equal(
      (
        await api('PATCH', `/v1/projects/alpha/environment-variables`, {
          target: 'preview',
          set: [
            {
              name: 'GH_TOKEN',
              kind: 'secret',
              value: rotated,
            },
          ],
        })
      ).status,
      200,
    )
    h.deps.stations.reconcile()
    const delivery = await station.waitFor(
      () =>
        station.secrets
          .filter((s) => s.target.sandbox_id === boxId)
          .slice(deliveries)
          .find((s) => s.values.GH_TOKEN === rotated),
      8000,
      'the rotated delivery',
    )

    assert.notEqual(delivery.digest, before)
    const changed = (
      (await api('GET', '/v1/events?types=secret.changed&limit=50')).body.items as any[]
    ).filter((e) => e.payload.machines?.includes(boxId))

    assert.ok(changed.length > 0, 'secret.changed names the machine that reads the value')
    assert.equal(
      rows<{ stale: number }>(h, 'select count(*) as stale from app where stale = 1')[0]!.stale,
      0,
    )
    const after = await station.waitForGeneration(
      (d) => d.sandboxes?.[boxId]?.env_digest === delivery.digest,
    )

    assert.equal(after.sandboxes![boxId]!.env_digest, delivery.digest)
  })

  test('requesting deletion of a machine deletes its environment variable rows', async () => {
    const box = await createMachine(h, envId, {
      name: 'with-variables',
    })

    assert.ok(rows(h, 'select id from environment_variable where machine_id = ?', box.id).length)
    requestDeletion(h.db, machineRowOf(h, box.id), {
      actor: systemActor,
      reason: 'user',
    })
    assert.equal(
      rows(h, 'select id from environment_variable where machine_id = ?', box.id).length,
      0,
    )
    assert.equal(machineRowOf(h, box.id)?.status ?? 'deleting', 'deleting')
  })
})

describe('logs', () => {
  test('GET /v1/logs reads the init and runtime log of a machine', async () => {
    const init = await api('GET', `/v1/logs?machine=${boxId}`)

    assert.equal(init.status, 200, init.text)
    assert.equal(init.body.untrusted.lines[0].role, 'init')
    const runtime = await api('GET', `/v1/logs?machine=${boxId}&role=runtime`)

    assert.equal(runtime.body.untrusted.lines[0].role, 'runtime')
    const sent = station.received
      .filter((m) => m.type === 'logs.query' && (m.body as any).source === 'sandbox')
      .map((m) => m.body as any)

    assert.deepEqual(
      sent.map((b) => [b.sandbox_id, b.role]),
      [
        [boxId, 'init'],
        [boxId, 'runtime'],
      ],
    )
    const bad = await api('GET', `/v1/logs?machine=${boxId}&role=app`)

    assert.equal(bad.status, 400)
    const two = await api('GET', `/v1/logs?machine=${boxId}&run=run_01ARZ3NDEKTSV4RRFFQ69G5FAV`)

    assert.equal(two.status, 400)
  })
})
