import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { eq } from 'drizzle-orm'

import { bytesText, gibibyte } from '@stationly/protocol'

import { machine, server as serverTable } from '../src/db/schema.ts'
import { requestDeletion, runRetention, systemActor } from '../src/sandboxes/lifecycle.ts'
import { fittingMemory, machineMemory } from '../src/sandboxes/limits.ts'

import { localOrigin, startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import type { FakeStation } from './helpers/fake-station.ts'
import {
  createMachine,
  createPreview,
  createProject,
  machineRowOf,
  pinPlatform,
  productionId,
  rows,
  toolchainImageDigest,
  tryCreateMachine,
  waitForMachine,
} from './helpers/seed.ts'

let h: Dispatch
let station: FakeStation
let project: any
let envId: string
let productionTarget: string

const api = (method: string, path: string, body?: unknown) =>
  h.call(method, path, {
    token: h.admin.token,
    body,
  })

const human = (method: string, path: string, body?: unknown) =>
  h.call(method, path, {
    cookie: h.admin.cookie,
    origin: localOrigin,
    body,
  })

const events = async (types: string) =>
  ((await api('GET', `/v1/events?types=${types}&limit=200`)).body.items as any[])
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((e) => ({
      type: e.type,
      subject: e.subject,
      payload: e.payload,
    }))

const stationRow = () =>
  h.db.select().from(serverTable).where(eq(serverTable.id, station.stationId)).get()!

const withCapabilities = async <T>(
  change: (
    capabilities: NonNullable<ReturnType<typeof stationRow>['capabilities']>,
  ) => ReturnType<typeof stationRow>['capabilities'],
  run: () => Promise<T>,
) => {
  const original = stationRow().capabilities!
  const setCapabilities = (capabilities: ReturnType<typeof stationRow>['capabilities']) =>
    h.db
      .update(serverTable)
      .set({
        capabilities,
      })
      .where(eq(serverTable.id, station.stationId))
      .run()

  setCapabilities(change(structuredClone(original)))

  try {
    return await run()
  } finally {
    setCapabilities(original)
  }
}

const deleteMachine = async (id: string) => {
  requestDeletion(h.db, machineRowOf(h, id), {
    actor: systemActor,
    reason: 'user',
  })
  h.deps.stations.reconcile()
  await station.waitFor(() => !machineRowOf(h, id), 5000, `machine ${id} to be removed`)
}

const setRetention = async (value: number) => {
  const reply = await api('PATCH', '/v1/settings', {
    'machine.stopped_retention_s': value,
  })

  assert.equal(reply.status, 200, reply.text)
}

before(async () => {
  h = await startDispatch()
  pinPlatform(h, {
    machines: true,
  })
  station = await startFakeStation(h, 'station-1', {
    machines: {},
  })
  project = await createProject(h, 'alpha')
  envId = (await createPreview(h, 'alpha', 'dev')).id
  productionTarget = productionId(h, project.id)
})

after(async () => {
  await h.close()
})

describe('create on a station', () => {
  test('a machine is created with the workspace defaults, runs on the station and reports its state', async () => {
    const box = await createMachine(h, envId)

    assert.match(box.id, /^sbx_[0-9A-HJKMNP-TV-Z]{26}$/)
    assert.equal(box.status, 'creating')
    assert.equal(box.desired_state, 'running')
    assert.deepEqual(box.size, {
      cpu_millis: 2000,
      memory_bytes: 2 * gibibyte,
      disk_bytes: 21474836480,
    })
    assert.equal(box.network, 'isolated')
    assert.equal(box.docker, false)
    assert.equal(box.ttl_s, null)
    assert.equal(box.stop_at, null)
    assert.equal(box.command, null)
    assert.equal(box.runtime, 'gvisor')
    assert.deepEqual(box.image, {
      ref: null,
      digest: toolchainImageDigest,
    })
    assert.ok(box.workspace)
    const running = await waitForMachine(h, box.id, 'running')

    assert.ok(running.address)
    assert.ok(running.started_at)
    assert.equal(running.status_reason, null)
    assert.equal(running.disk_used_bytes, 734003200)
    const started = (await events('machine.started')).find((e) => e.payload.machine === box.id)!

    assert.equal(started.payload.reason, 'create')
    assert.equal(started.subject.project_id, project.id)
  })

  test('a name is unique in its preview', async () => {
    const first = await createMachine(h, envId, {
      name: 'unique-name',
    })

    await waitForMachine(h, first.id, 'running')
    const again = await tryCreateMachine(h, envId, {
      name: 'unique-name',
    })

    assert.equal(again.status, 409)
    assert.equal(again.body.error.code, 'NAME_TAKEN')
  })

  test('a station that offers no machine runtime answers MACHINE_RUNTIME_UNAVAILABLE', async () => {
    const reply = await withCapabilities(
      (capabilities) => ({
        ...capabilities,
        sandboxes: {
          ...capabilities.sandboxes!,
          runtimes: [],
        },
      }),
      () => tryCreateMachine(h, envId),
    )

    assert.equal(reply.status, 422, reply.text)
    assert.equal(reply.body.error.code, 'MACHINE_RUNTIME_UNAVAILABLE')
    assert.equal(reply.body.error.details.server, station.stationId)
    assert.deepEqual(reply.body.error.details.offered, [])
  })

  test('a station reports its host probe and the runtime advice built from it', async () => {
    const reply = await api(
      'GET',
      '/v1/servers/station-1?fields=capabilities,default_machine_runtime,machine_runtime_advice',
    )

    assert.equal(reply.status, 200, reply.text)
    assert.equal(reply.body.capabilities.host.kvm_usable, false)
    assert.equal(reply.body.default_machine_runtime, null)
    assert.deepEqual(reply.body.machine_runtime_advice, {
      default: 'gvisor',
      reasons: [
        'This host is a kvm virtual machine without nested virtualization, so machines run on gVisor',
      ],
      options: [
        {
          runtime: 'gvisor',
          installed: true,
          recommended: true,
          pros: reply.body.machine_runtime_advice.options[0].pros,
          cons: reply.body.machine_runtime_advice.options[0].cons,
        },
      ],
    })
  })

  test('a KVM host lists micro-VMs as recommended but not installed, and the default stays gVisor', async () => {
    const metal = await startFakeStation(h, 'station-metal', {
      machines: {
        host: {
          kvm_present: true,
          kvm_usable: true,
          cpu_virtualization: 'svm',
          hypervisor: null,
        },
      },
    })
    const reply = await api('GET', '/v1/servers/station-metal?fields=machine_runtime_advice')
    const advice = reply.body.machine_runtime_advice

    assert.equal(advice.default, 'gvisor')
    assert.deepEqual(
      advice.options.map((o: any) => [o.runtime, o.installed, o.recommended]),
      [
        ['gvisor', true, false],
        ['microvm', false, true],
      ],
    )
    await metal.close()
    const removed = await api('DELETE', '/v1/servers/station-metal')

    assert.equal(removed.status, 200, removed.text)
  })

  test('default_machine_runtime is stored for a station that offers it and refused elsewhere', async () => {
    const set = await api('PATCH', '/v1/servers/station-1', {
      default_machine_runtime: 'gvisor',
    })

    assert.equal(set.status, 200, set.text)
    assert.equal(set.body.default_machine_runtime, 'gvisor')
    const cleared = await api('PATCH', '/v1/servers/station-1', {
      default_machine_runtime: null,
    })

    assert.equal(cleared.status, 200, cleared.text)
    assert.equal(cleared.body.default_machine_runtime, null)
    const unknown = await api('PATCH', '/v1/servers/station-1', {
      default_machine_runtime: 'firecracker',
    })

    assert.equal(unknown.status, 400, unknown.text)
    const plain = await startFakeStation(h, 'station-runtime-less')
    const refused = await api('PATCH', '/v1/servers/station-runtime-less', {
      default_machine_runtime: 'gvisor',
    })

    assert.equal(refused.status, 400, refused.text)
    assert.equal(refused.body.error.code, 'VALIDATION_FAILED')
    assert.deepEqual(
      refused.body.error.details.issues.map((i: any) => i.path),
      ['/default_machine_runtime'],
    )
    await plain.close()
  })

  test('under platform.protected a token stages default_machine_runtime and a human applies it', async () => {
    const on = await human('PATCH', '/v1/settings', {
      'platform.protected': true,
    })

    assert.equal(on.status, 200, on.text)
    const waiting = await api('PATCH', '/v1/servers/station-1', {
      default_machine_runtime: 'gvisor',
    })

    assert.equal(waiting.status, 202, waiting.text)
    assert.equal(stationRow().default_machine_runtime, null)
    const approved = await human('POST', `/v1/approvals/${waiting.body.id}/decision`, {
      decision: 'approve',
    })

    assert.equal(approved.status, 200, approved.text)
    assert.equal(stationRow().default_machine_runtime, 'gvisor')
    const off = await human('PATCH', '/v1/settings', {
      'platform.protected': false,
    })

    assert.equal(off.status, 200, off.text)
  })

  test('a station without the machine capability refuses a machine', async () => {
    await startFakeStation(h, 'station-plain')
    const reply = await withCapabilities(
      (capabilities) => ({
        ...capabilities,
        sandboxes: undefined,
      }),
      () => tryCreateMachine(h, envId),
    )

    assert.equal(reply.status, 422, reply.text)
    assert.equal(reply.body.error.code, 'SERVER_CAPABILITY_MISSING')
    assert.equal(reply.body.error.details.missing, 'machines')
  })
})

describe('what the station reports', () => {
  test('a failed start is reported with its diagnosis', async () => {
    const box = await createMachine(h, envId, {
      name: 'flaky',
    })

    await waitForMachine(h, box.id, 'running')
    station.failMachine(box.id, {
      phase: 'start',
      code: 'MACHINE_START_FAILED',
      summary: 'runsc create failed',
      details: {
        step: 'create',
        error: 'boom',
      },
    })
    const failed = await waitForMachine(h, box.id, 'failed')

    assert.equal(failed.failure!.code, 'MACHINE_START_FAILED')
    assert.equal(failed.desired_state, 'stopped')
    assert.equal(failed.address, null)
    const event = (await events('machine.failed')).find((e) => e.payload.machine === box.id)!

    assert.deepEqual([event.payload.phase, event.payload.code], ['start', 'MACHINE_START_FAILED'])
  })

  test('an exited or OOM-killed init stops the machine and nothing restarts it', async () => {
    const exited = await createMachine(h, envId, {
      name: 'exits',
    })

    await waitForMachine(h, exited.id, 'running')
    station.expireMachine(exited.id, 'exited', 3)
    const a = await waitForMachine(h, exited.id, 'stopped')

    assert.deepEqual(
      [a.status_reason, a.exit_code, a.desired_state, a.stop_at],
      ['exited', 3, 'stopped', null],
    )
    const stopped = (await events('machine.stopped')).find((e) => e.payload.machine === exited.id)!

    assert.equal(stopped.payload.reason, 'exited')
    assert.ok(stopped.payload.ran_for_s >= 0)
    const oom = await createMachine(h, envId, {
      name: 'oom',
    })

    await waitForMachine(h, oom.id, 'running')
    station.expireMachine(oom.id, 'oom', 137)
    const b = await waitForMachine(h, oom.id, 'stopped')

    assert.deepEqual([b.status_reason, b.exit_code, b.desired_state], ['oom', 137, 'stopped'])
  })
})

describe('retention of stopped machines', () => {
  test('machine.stopped_retention_s is 604800 by default, 0 or at least 86400 otherwise', async () => {
    const value = (await api('GET', '/v1/settings?prefix=machine.')).body
    const entry = (value.items ?? value).find((s: any) => s.key === 'machine.stopped_retention_s')

    assert.equal(entry.value, 604800)

    for (const bad of [86399, -1, 1.5]) {
      const reply = await api('PATCH', '/v1/settings', {
        'machine.stopped_retention_s': bad,
      })

      assert.equal(reply.status, 400, `${bad}`)
    }

    await setRetention(0)
    await setRetention(86400)
    await setRetention(604800)
  })

  test("a task's stopped machine is never expired or deleted by retention", async () => {
    const box = await createMachine(h, envId, {
      name: 'retained',
    })

    await waitForMachine(h, box.id, 'running')
    station.expireMachine(box.id, 'exited', 0)
    await waitForMachine(h, box.id, 'stopped')
    h.db
      .update(machine)
      .set({
        stopped_at: new Date(Date.now() - 30 * 86400_000),
      })
      .where(eq(machine.id, box.id))
      .run()
    const result = runRetention({
      db: h.db,
      stations: h.deps.stations,
    })

    assert.ok(!result.deleted.includes(box.id))
    assert.ok(!result.expiring.includes(box.id))
    assert.equal(machineRowOf(h, box.id).status, 'stopped')
  })
})

describe('production', () => {
  test('a machine in production needs a human actor', async () => {
    const refused = await tryCreateMachine(h, productionTarget, {
      name: 'agent-box',
    })

    assert.equal(refused.status, 403, refused.text)
    assert.equal(refused.body.error.code, 'HUMAN_REQUIRED')
    assert.equal(refused.body.error.details.reason, 'human_required')
    const created = await tryCreateMachine(h, productionTarget, {
      name: 'locked-box',
      human: true,
    })

    assert.equal(created.status, 201, created.text)
    await waitForMachine(h, created.body.id, 'running')
  })
})

describe('station limits', () => {
  test('max_machines, max_running and memory_bytes refuse with MACHINE_QUOTA_EXCEEDED naming limit, used and requested', async () => {
    const limits = async (body: Record<string, unknown>) => {
      const reply = await api('PATCH', '/v1/servers/station-1', {
        machine_limits: body,
      })

      assert.equal(reply.status, 200, reply.text)

      return reply.body.machine_limits
    }
    const total = rows<{ n: number }>(
      h,
      'select count(*) as n from machine where server_id = ?',
      station.stationId,
    )[0]!.n
    const running = rows<{ n: number }>(
      h,
      "select count(*) as n from machine where server_id = ? and desired_state = 'running' and status != 'deleting'",
      station.stationId,
    )[0]!.n

    assert.deepEqual(
      await limits({
        max_machines: total,
      }),
      {
        max_machines: total,
        max_running: 20,
        memory_bytes: null,
        min_free_bytes: null,
      },
    )
    const full = await tryCreateMachine(h, envId)

    assert.equal(full.status, 422, full.text)
    assert.equal(full.body.error.code, 'MACHINE_QUOTA_EXCEEDED')
    assert.deepEqual(
      [
        full.body.error.details.limit,
        full.body.error.details.used,
        full.body.error.details.requested,
      ],
      ['max_machines', total, 1],
    )
    await limits({
      max_machines: 100,
      max_running: running,
    })
    const many = await tryCreateMachine(h, envId)

    assert.equal(many.status, 422, many.text)
    assert.deepEqual(
      [many.body.error.details.limit, many.body.error.details.used],
      ['max_running', running],
    )
    await limits({
      max_running: 20,
      memory_bytes: gibibyte,
    })
    const memory = await tryCreateMachine(h, envId, {
      memoryBytes: 2 * gibibyte,
    })

    assert.equal(memory.status, 422, memory.text)
    assert.equal(memory.body.error.details.limit, 'memory_bytes')
    assert.equal(memory.body.error.details.requested, 2 * gibibyte)
    await limits({
      memory_bytes: null,
    })
    assert.equal(
      (await api('GET', '/v1/servers/station-1?fields=machine_limits')).body.machine_limits
        .memory_bytes,
      null,
    )
  })

  test('a machine gets the free memory rounded down to 256 MiB, and below 512 MiB the 2 GiB workspace default meets the quota', async () => {
    const memory = async () =>
      (await api('GET', '/v1/servers/station-1?fields=machine_memory')).body.machine_memory
    const { used } = await memory()
    const limit = used + 1.5 * gibibyte + 100 * 1024 ** 2

    await api('PATCH', '/v1/servers/station-1', {
      machine_limits: {
        max_running: 100,
        memory_bytes: limit,
      },
    })
    assert.deepEqual(await memory(), {
      limit,
      used,
      free: limit - used,
    })
    const fitted = await createMachine(h, envId, {
      name: 'fitted-memory',
    })

    assert.equal(fitted.size.memory_bytes, 1.5 * gibibyte)
    const busy = used + 1.5 * gibibyte

    assert.deepEqual(await memory(), {
      limit,
      used: busy,
      free: 100 * 1024 ** 2,
    })
    const refused = await tryCreateMachine(h, envId)

    assert.equal(refused.status, 422, refused.text)
    assert.equal(refused.body.error.code, 'MACHINE_QUOTA_EXCEEDED')
    assert.equal(
      refused.body.error.explanation,
      `Server station-1 allows ${bytesText(limit)} for memory_bytes; ${bytesText(busy)} is used and this change needs 2 GiB more.`,
    )
    const { holders, ...details } = refused.body.error.details

    assert.deepEqual(details, {
      server: station.stationId,
      limit: 'memory_bytes',
      allowed: limit,
      used: busy,
      requested: 2 * gibibyte,
    })
    const mine = holders.find((holder: { id: string }) => holder.id === fitted.id)

    assert.equal(mine.memory_bytes, 1.5 * gibibyte)
    assert.equal(mine.workspace, true)
    assert.equal(mine.repository, 'https://github.com/acme/web')
    await deleteMachine(fitted.id)
    await api('PATCH', '/v1/servers/station-1', {
      machine_limits: {
        max_running: 20,
        memory_bytes: null,
      },
    })
  })

  test('a station that reports no memory has no machine memory limit and fits the 4 GiB default', () => {
    const row = stationRow()
    const unreported = {
      ...row,
      resources: null,
      machine_limits: {
        ...row.machine_limits,
        memory_bytes: null,
      },
    }
    const memory = machineMemory(h.db, unreported)

    assert.equal(memory.limit, null)
    assert.equal(memory.free, null)
    assert.equal(fittingMemory(h.db, unreported), 4 * gibibyte)
  })

  test('only an instance admin changes machine_limits', async () => {
    const scoped = await h.call('POST', '/v1/tokens', {
      token: h.admin.token,
      body: {
        name: 'deployer',
        kind: 'scoped',
        scopes: [
          {
            project_id: '*',
            target: '*',
            level: 'deploy',
          },
        ],
      },
    })
    const reply = await h.call('PATCH', '/v1/servers/station-1', {
      token: scoped.body.key,
      body: {
        machine_limits: {
          max_running: 1,
        },
      },
    })

    assert.equal(reply.status, 403)
  })

  test('machine disk below min_free_bytes refuses a new disk with MACHINE_DISK_FULL', async () => {
    await api('PATCH', '/v1/servers/station-1', {
      machine_limits: {
        min_free_bytes: 900000000000,
      },
    })
    const reply = await tryCreateMachine(h, envId)

    assert.equal(reply.status, 422, reply.text)
    assert.equal(reply.body.error.code, 'MACHINE_DISK_FULL')
    assert.ok(reply.body.error.details.free_bytes < reply.body.error.details.min_free_bytes)
    await api('PATCH', '/v1/servers/station-1', {
      machine_limits: {
        min_free_bytes: null,
      },
    })
  })
})

describe('previews that hold machines', () => {
  test('a named preview with a machine cannot be deleted, an expiring one deletes its machines with it', async () => {
    const normal = await createPreview(h, 'alpha', 'holds-box')
    const box = await createMachine(h, normal.id, {
      name: 'resident',
    })
    const blocked = await api('DELETE', `/v1/previews/${normal.id}`)

    assert.equal(blocked.status, 409)
    assert.equal(blocked.body.error.code, 'DELETE_HAS_DEPENDENTS')
    assert.deepEqual(
      blocked.body.error.details.dependents.map((d: any) => d.id),
      [box.id],
    )
    await deleteMachine(box.id)
    assert.equal((await api('DELETE', `/v1/previews/${normal.id}`)).status, 200)

    const temp = await createPreview(h, 'alpha', 'temp', {
      ttl_seconds: 3600,
    })
    const mine = await createMachine(h, temp.id, {
      name: 'temporary',
    })
    const removed = await api('DELETE', `/v1/previews/${temp.id}`)

    assert.equal(removed.status, 200, removed.text)
    await station.waitFor(() => !machineRowOf(h, mine.id), 5000, 'machine removal')
    const gone = (await events('machine.deleted')).find((e) => e.payload.machine === mine.id)!

    assert.equal(gone.payload.reason, 'preview')
    assert.equal(gone.payload.actor.type, 'system')
  })

  test('a station that still holds a machine cannot be removed', async () => {
    const reply = await api('DELETE', '/v1/servers/station-1')

    assert.equal(reply.status, 409)
    assert.equal(reply.body.error.code, 'DELETE_HAS_DEPENDENTS')
    assert.ok(reply.body.error.details.dependents.some((d: any) => d.entity === 'machine'))
  })
})
