import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { eq } from 'drizzle-orm'

import { bytesText, gibibyte } from '@stationly/protocol'

import { machine, server as serverTable } from '../src/db/schema.ts'
import { runRetention } from '../src/sandboxes/lifecycle.ts'
import { fittingMemory, machineMemory } from '../src/sandboxes/limits.ts'

import { localOrigin, startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import type { FakeStation } from './helpers/fake-station.ts'
import { FakeRegistry } from './helpers/registry.ts'
import {
  createMachine,
  createPreview,
  createProject,
  pinPlatform,
  placed,
  productionId,
  rows,
  toolchainImageDigest,
  waitForMachine,
} from './helpers/seed.ts'

let h: Dispatch
let registry: FakeRegistry
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

const machineRow = (id: string) => h.db.select().from(machine).where(eq(machine.id, id)).get()

const setRetention = async (value: number) => {
  const reply = await api('PATCH', '/v1/settings', {
    'machine.stopped_retention_s': value,
  })

  assert.equal(reply.status, 200, reply.text)
}

before(async () => {
  registry = FakeRegistry.install()
  registry.publish('alpine:3.20')
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
  registry.restore()
})

describe('create, list, get', () => {
  test('a machine is created with the documented defaults, runs on the station and reports its state', async () => {
    const created = await api('POST', placed(h, envId, `machines`), {})

    assert.equal(created.status, 201, created.text)
    const box = created.body

    assert.match(box.id, /^sbx_[0-9A-HJKMNP-TV-Z]{26}$/)
    assert.equal(box.name, `machine-${box.id.slice(-6).toLowerCase()}`)
    assert.equal(box.status, 'creating')
    assert.equal(box.desired_state, 'running')
    assert.deepEqual(box.size, {
      cpu_millis: 2000,
      memory_bytes: 4294967296,
      disk_bytes: 21474836480,
    })
    assert.equal(box.network, 'isolated')
    assert.equal(box.docker, false)
    assert.deepEqual(box.egress, {
      mode: 'open',
    })
    assert.equal(box.ttl_s, 3600)
    assert.deepEqual(box.image, {
      ref: null,
      digest: toolchainImageDigest,
    })
    assert.equal(box.forked_from, null)
    assert.equal(box.delete_at, null)
    assert.deepEqual(box.warnings, [])
    const left = Date.parse(box.stop_at) - Date.now()

    assert.ok(left > 3590_000 && left <= 3600_000, `stop_at is ${box.stop_at}`)
    const running = await waitForMachine(h, box.id, 'running')

    assert.ok(running.address)
    assert.ok(running.started_at)
    assert.equal(running.status_reason, null)
    assert.equal(running.disk_used_bytes, 734003200)
    const started = (await events('machine.started')).find((e) => e.payload.machine === box.id)!

    assert.equal(started.payload.reason, 'create')
    assert.equal(started.subject.project_id, project.id)
  })

  test('list and get honour filters, fields and expansions', async () => {
    const box = await createMachine(h, envId, {
      name: 'lister',
      network: 'isolated',
    })

    await waitForMachine(h, box.id, 'running')
    const all = (await api('GET', placed(h, envId, `machines`))).body

    assert.ok(all.items.some((s: any) => s.id === box.id))
    assert.ok(all.items.every((s: any) => s.egress.domains === undefined))
    const running = (
      await api(
        'GET',
        placed(h, envId, `machines?status=running&network=isolated&server=station-1`),
      )
    ).body.items

    assert.ok(running.some((s: any) => s.id === box.id))
    assert.deepEqual((await api('GET', placed(h, envId, `machines?status=failed`))).body.items, [])
    assert.deepEqual(
      (await api('GET', placed(h, envId, `machines?network=environment`))).body.items.filter(
        (s: any) => s.id === box.id,
      ),
      [],
    )
    const full = (await api('GET', `/v1/machines/${box.id}?fields=*`)).body

    assert.deepEqual(full.egress, {
      mode: 'open',
      domains: [],
    })
    assert.deepEqual(full.snapshots, [])
    assert.deepEqual(full.runs, [])
    assert.equal(full.metrics.machine_id, box.id)
    assert.equal(full.command, null)
    assert.equal(full.failure, null)
    const flat = await api('GET', `/v1/projects/alpha/previews/dev/machines/lister`)

    assert.equal(flat.status, 200)
    assert.equal(flat.body.id, box.id)
  })

  test('a name is unique in its preview and refuses a bad slug', async () => {
    await createMachine(h, envId, {
      name: 'unique-name',
      start: false,
    })
    const again = await api('POST', placed(h, envId, `machines`), {
      name: 'unique-name',
    })

    assert.equal(again.status, 409)
    assert.equal(again.body.error.code, 'NAME_TAKEN')
    const bad = await api('POST', placed(h, envId, `machines`), {
      name: 'Not A Slug',
    })

    assert.equal(bad.status, 400)
    assert.equal(bad.body.error.code, 'VALIDATION_FAILED')
  })

  test('start = false creates a stopped machine that holds no stop_at and no running desire', async () => {
    const box = await createMachine(h, envId, {
      name: 'cold',
      start: false,
    })

    assert.equal(box.status, 'stopped')
    assert.equal(box.status_reason, 'created_stopped')
    assert.equal(box.desired_state, 'stopped')
    assert.equal(box.stop_at, null)
    assert.ok(box.delete_at)
    assert.equal(
      Date.parse(box.delete_at) - Date.parse(machineRow(box.id)!.stopped_at!.toISOString()),
      604800_000,
    )
  })

  test('an image reference is resolved to a digest, and an unreachable one is refused', async () => {
    const box = await createMachine(h, envId, {
      name: 'alpine-box',
      image: {
        ref: 'alpine:3.20',
      },
      start: false,
    })

    assert.equal(box.image.ref, 'alpine:3.20')
    assert.match(box.image.digest, /^sha256:[0-9a-f]{64}$/)
    const missing = await api('POST', placed(h, envId, `machines`), {
      name: 'ghost',
      image: {
        ref: 'nowhere.invalid/none:1',
      },
    })

    assert.equal(missing.status, 422)
    assert.equal(missing.body.error.code, 'SOURCE_UNREACHABLE')
  })

  test('egress domains are validated and normalized under /egress/domains', async () => {
    const box = await createMachine(h, envId, {
      name: 'allowlisted',
      start: false,
      egress: {
        mode: 'allowlist',
        domains: [
          {
            domain: 'GitHub.com',
            ports: [443, 22],
          },
          {
            domain: 'githubusercontent.com',
            wildcard: true,
          },
        ],
      },
    })

    assert.equal(box.egress.mode, 'allowlist')
    const full = (await api('GET', `/v1/machines/${box.id}?fields=egress`)).body

    assert.deepEqual(full.egress.domains, [
      {
        domain: 'github.com',
        wildcard: false,
        ports: [443, 22],
      },
      {
        domain: 'githubusercontent.com',
        wildcard: true,
        ports: [443],
      },
    ])
    const bad = await api('POST', placed(h, envId, `machines`), {
      egress: {
        mode: 'allowlist',
        domains: [
          {
            domain: 'not a name',
          },
        ],
      },
    })

    assert.equal(bad.status, 400)
    assert.equal(bad.body.error.details.issues[0].path, '/egress/domains/0/domain')
    const tooMany = await api('POST', placed(h, envId, `machines`), {
      egress: {
        mode: 'allowlist',
        domains: Array.from(
          {
            length: 257,
          },
          (_, i) => ({
            domain: `d${i}.example.com`,
          }),
        ),
      },
    })

    assert.equal(tooMany.status, 400)
    assert.equal(tooMany.body.error.details.issues[0].path, '/egress/domains')
    const ports = await api('POST', placed(h, envId, `machines`), {
      egress: {
        mode: 'allowlist',
        domains: [
          {
            domain: 'a.example.com',
            ports: [1, 2, 3, 4, 5, 6, 7, 8, 9],
          },
        ],
      },
    })

    assert.equal(ports.status, 400)
    assert.equal(ports.body.error.details.issues[0].path, '/egress/domains')
  })

  test('a machine takes the station default runtime and a fork keeps its source runtime', async () => {
    const box = await createMachine(h, envId, {
      name: 'runtime-default',
      start: false,
    })

    assert.equal(box.runtime, 'gvisor')
    const fork = await api('POST', placed(h, envId, `machines`), {
      name: 'runtime-fork',
      from: {
        machine: box.id,
      },
      start: false,
    })

    assert.equal(fork.status, 201, fork.text)
    assert.equal(fork.body.runtime, 'gvisor')
    assert.equal(machineRow(fork.body.id)!.runtime, 'gvisor')
  })

  test('a station that offers no machine runtime answers MACHINE_RUNTIME_UNAVAILABLE', async () => {
    const bare = await startFakeStation(h, 'station-no-runtime', {
      machines: {
        runtimes: [],
      },
    })
    const reply = await api('POST', placed(h, envId, `machines`), {
      server_id: 'station-no-runtime',
      runtime: 'gvisor',
    })

    assert.equal(reply.status, 422, reply.text)
    assert.equal(reply.body.error.code, 'MACHINE_RUNTIME_UNAVAILABLE')
    assert.equal(reply.body.error.details.runtime, 'gvisor')
    assert.deepEqual(reply.body.error.details.offered, [])
    const unnamed = await api('POST', placed(h, envId, `machines`), {
      server_id: 'station-no-runtime',
    })

    assert.equal(unnamed.status, 422, unnamed.text)
    assert.equal(unnamed.body.error.code, 'MACHINE_RUNTIME_UNAVAILABLE')
    assert.equal(unnamed.body.error.details.runtime, null)
    await bare.close()
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
    assert.equal(
      h.db.select().from(serverTable).where(eq(serverTable.name, 'station-1')).get()!
        .default_machine_runtime,
      null,
    )
    const approved = await human('POST', `/v1/approvals/${waiting.body.id}/decision`, {
      decision: 'approve',
    })

    assert.equal(approved.status, 200, approved.text)
    assert.equal(
      h.db.select().from(serverTable).where(eq(serverTable.name, 'station-1')).get()!
        .default_machine_runtime,
      'gvisor',
    )
    const off = await human('PATCH', '/v1/settings', {
      'platform.protected': false,
    })

    assert.equal(off.status, 200, off.text)
  })

  test('a station without the machine capability refuses a machine', async () => {
    await startFakeStation(h, 'station-plain')
    const reply = await api('POST', placed(h, envId, `machines`), {
      server_id: 'station-plain',
    })

    assert.equal(reply.status, 422)
    assert.equal(reply.body.error.code, 'SERVER_CAPABILITY_MISSING')
    assert.equal(reply.body.error.details.missing, 'machines')
  })
})

describe('start, stop, delete', () => {
  test('stop keeps the disk and clears stop_at, start sets a new one and a ttl_s replaces the stored one', async () => {
    const box = await createMachine(h, envId, {
      name: 'cycle',
    })

    await waitForMachine(h, box.id, 'running')
    const stopping = await api('POST', `/v1/machines/${box.id}/stop`)

    assert.equal(stopping.status, 200, stopping.text)
    assert.equal(stopping.body.status, 'stopping')
    assert.equal(stopping.body.stop_at, null)
    const stopped = await waitForMachine(h, box.id, 'stopped')

    assert.equal(stopped.status_reason, 'user')
    assert.ok(stopped.stopped_at)
    assert.equal(Date.parse(stopped.delete_at) - Date.parse(stopped.stopped_at), 604800_000)
    assert.equal(stopped.address, null)
    const stopEvent = (await events('machine.stopped')).find((e) => e.payload.machine === box.id)!

    assert.equal(stopEvent.payload.reason, 'user')
    assert.ok(stopEvent.payload.ran_for_s >= 0)
    const restarted = await api('POST', `/v1/machines/${box.id}/start`, {
      ttl_s: 120,
    })

    assert.equal(restarted.status, 200, restarted.text)
    assert.equal(restarted.body.status, 'starting')
    assert.equal(restarted.body.ttl_s, 120)
    assert.equal(restarted.body.delete_at, null)
    const left = Date.parse(restarted.body.stop_at) - Date.now()

    assert.ok(left > 110_000 && left <= 120_000)
    await waitForMachine(h, box.id, 'running')
    const startEvents = (await events('machine.started')).filter(
      (e) => e.payload.machine === box.id,
    )

    assert.equal(startEvents.at(-1)!.payload.reason, 'user')
  })

  test('delete removes the machine after the station reports it deleted and keeps its snapshots', async () => {
    const box = await createMachine(h, envId, {
      name: 'doomed',
    })

    await waitForMachine(h, box.id, 'running')
    const snapshot = await api('POST', `/v1/machines/${box.id}/snapshots`, {
      name: 'keep-me',
    })

    assert.equal(snapshot.status, 201)
    const removed = await api('DELETE', `/v1/machines/${box.id}`)

    assert.equal(removed.status, 200, removed.text)
    assert.deepEqual(removed.body, {
      deleted: true,
      snapshots_kept: 1,
    })
    assert.equal(
      machineRow(box.id)?.status === 'deleting' || machineRow(box.id) === undefined,
      true,
    )
    await station.waitFor(() => !machineRow(box.id), 5000, 'the machine row to disappear')
    assert.equal((await api('GET', `/v1/machines/${box.id}`)).status, 404)
    const gone = (await events('machine.deleted')).find((e) => e.payload.machine === box.id)!

    assert.equal(gone.payload.reason, 'user')
    assert.equal(gone.payload.snapshots_kept, 1)
    assert.equal(gone.payload.actor.type, 'token')
    const kept = (await api('GET', placed(h, envId, `machine-snapshots`))).body.items

    assert.ok(kept.some((s: any) => s.id === snapshot.body.id && s.machine_id === box.id))
  })

  test('a deleting machine refuses start and changes with MACHINE_STATE_CONFLICT', async () => {
    const box = await createMachine(h, envId, {
      name: 'dying',
      start: false,
    })

    station.releaseMachines()
    h.db
      .update(machine)
      .set({
        status: 'deleting',
      })
      .where(eq(machine.id, box.id))
      .run()
    const start = await api('POST', `/v1/machines/${box.id}/start`)

    assert.equal(start.status, 409)
    assert.equal(start.body.error.code, 'MACHINE_STATE_CONFLICT')
    assert.equal(start.body.error.details.status, 'deleting')
    assert.ok(Array.isArray(start.body.error.details.allowed))
    const patch = await api('PATCH', `/v1/machines/${box.id}`, {
      ttl_s: 600,
    })

    assert.equal(patch.status, 409)
    h.db
      .update(machine)
      .set({
        status: 'stopped',
      })
      .where(eq(machine.id, box.id))
      .run()
  })

  test('a failed start is reported with its diagnosis and can be started again', async () => {
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

    assert.equal(failed.failure.code, 'MACHINE_START_FAILED')
    assert.equal(failed.desired_state, 'stopped')
    const event = (await events('machine.failed')).find((e) => e.payload.machine === box.id)!

    assert.deepEqual([event.payload.phase, event.payload.code], ['start', 'MACHINE_START_FAILED'])
    const again = await api('POST', `/v1/machines/${box.id}/start`)

    assert.equal(again.status, 200)
    await waitForMachine(h, box.id, 'running')
  })
})

describe('time to live', () => {
  test('changing ttl_s on a running machine extends stop_at from now, on a stopped one it only stores the value', async () => {
    const box = await createMachine(h, envId, {
      name: 'extend',
      ttl_s: 600,
    })

    await waitForMachine(h, box.id, 'running')
    const patched = await api('PATCH', `/v1/machines/${box.id}`, {
      ttl_s: 7200,
    })

    assert.equal(patched.status, 200, patched.text)
    const left = Date.parse(patched.body.stop_at) - Date.now()

    assert.ok(left > 7190_000 && left <= 7200_000)
    assert.deepEqual(patched.body.warnings, [])
    await api('POST', `/v1/machines/${box.id}/stop`)
    await waitForMachine(h, box.id, 'stopped')
    const stored = await api('PATCH', `/v1/machines/${box.id}`, {
      ttl_s: 900,
    })

    assert.equal(stored.body.ttl_s, 900)
    assert.equal(stored.body.stop_at, null)
  })

  test('ttl_s outside 60 to 2592000 is refused', async () => {
    for (const ttl_s of [59, 2592001]) {
      const reply = await api('POST', placed(h, envId, `machines`), {
        ttl_s,
        start: false,
      })

      assert.equal(reply.status, 400)
      assert.equal(reply.body.error.code, 'VALIDATION_FAILED')
    }
  })

  test('the station stopping at ttl sets desired_state to stopped, clears stop_at and emits the event', async () => {
    const box = await createMachine(h, envId, {
      name: 'expiring-ttl',
      ttl_s: 60,
    })

    await waitForMachine(h, box.id, 'running')
    station.expireMachine(box.id, 'ttl')
    const stopped = await waitForMachine(h, box.id, 'stopped')

    assert.equal(stopped.status_reason, 'ttl')
    assert.equal(stopped.desired_state, 'stopped')
    assert.equal(stopped.stop_at, null)
    const event = (await events('machine.stopped')).find((e) => e.payload.machine === box.id)!

    assert.equal(event.payload.reason, 'ttl')
    const generation = await station.waitForGeneration(
      (doc) => doc.sandboxes?.[box.id]?.desired_state === 'stopped',
    )

    assert.equal(generation.sandboxes![box.id]!.stop_at, null)
  })

  test('an exited or OOM-killed init stops the machine and nothing restarts it', async () => {
    const exited = await createMachine(h, envId, {
      name: 'exits',
    })

    await waitForMachine(h, exited.id, 'running')
    station.expireMachine(exited.id, 'exited', 3)
    const a = await waitForMachine(h, exited.id, 'stopped')

    assert.deepEqual([a.status_reason, a.exit_code, a.desired_state], ['exited', 3, 'stopped'])
    const oom = await createMachine(h, envId, {
      name: 'oom',
    })

    await waitForMachine(h, oom.id, 'running')
    station.expireMachine(oom.id, 'oom', 137)
    const b = await waitForMachine(h, oom.id, 'stopped')

    assert.deepEqual([b.status_reason, b.exit_code], ['oom', 137])
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

  test('one day before delete_at the machine.expiring event is emitted once per stop, and the deletion keeps snapshots', async () => {
    const box = await createMachine(h, envId, {
      name: 'retained',
    })

    await waitForMachine(h, box.id, 'running')
    const snapshot = (
      await api('POST', `/v1/machines/${box.id}/snapshots`, {
        name: 'survivor',
      })
    ).body

    await api('POST', `/v1/machines/${box.id}/stop`)
    await waitForMachine(h, box.id, 'stopped')
    const stoppedAt = machineRow(box.id)!.stopped_at!
    const day = 86400_000

    assert.deepEqual(
      runRetention(
        {
          db: h.db,
          stations: h.deps.stations,
        },
        new Date(stoppedAt.getTime() + 5 * day),
      ).expiring.filter((id) => id === box.id),
      [],
    )
    const soon = runRetention(
      {
        db: h.db,
        stations: h.deps.stations,
      },
      new Date(stoppedAt.getTime() + 6 * day + 1000),
    )

    assert.deepEqual(
      soon.expiring.filter((id) => id === box.id),
      [box.id],
    )
    assert.deepEqual(
      runRetention(
        {
          db: h.db,
          stations: h.deps.stations,
        },
        new Date(stoppedAt.getTime() + 6.5 * day),
      ).expiring.filter((id) => id === box.id),
      [],
    )
    const expiring = (await events('machine.expiring')).filter((e) => e.payload.machine === box.id)

    assert.equal(expiring.length, 1)
    assert.equal(
      expiring[0]!.payload.delete_at,
      new Date(stoppedAt.getTime() + 7 * day).toISOString(),
    )
    assert.equal(machineRow(box.id)!.status, 'stopped')
    const due = runRetention(
      {
        db: h.db,
        stations: h.deps.stations,
      },
      new Date(stoppedAt.getTime() + 7 * day),
    )

    assert.deepEqual(
      due.deleted.filter((id) => id === box.id),
      [box.id],
    )
    assert.equal(machineRow(box.id)?.deletion?.reason ?? 'removed', 'retention')
    await station.waitFor(() => !machineRow(box.id), 5000, 'retention deletion to finish')
    const deleted = (await events('machine.deleted')).find((e) => e.payload.machine === box.id)!

    assert.equal(deleted.payload.reason, 'retention')
    assert.equal(deleted.payload.actor.type, 'system')
    assert.equal(deleted.payload.snapshots_kept, 1)
    assert.equal((await api('GET', `/v1/machine-snapshots/${snapshot.id}`)).status, 200)
  })

  test('a start resets the clock, only stopped machines are deleted and 0 disables the sweep', async () => {
    const box = await createMachine(h, envId, {
      name: 'reset-clock',
    })

    await waitForMachine(h, box.id, 'running')
    const failed = await createMachine(h, envId, {
      name: 'failed-keeps',
    })

    await waitForMachine(h, failed.id, 'running')
    station.failMachine(failed.id, {
      phase: 'start',
      code: 'MACHINE_START_FAILED',
      summary: 'x',
    })
    await waitForMachine(h, failed.id, 'failed')
    await api('POST', `/v1/machines/${box.id}/stop`)
    await waitForMachine(h, box.id, 'stopped')
    const old = new Date(Date.now() - 30 * 86400_000)

    h.db
      .update(machine)
      .set({
        stopped_at: old,
      })
      .where(eq(machine.id, box.id))
      .run()
    h.db
      .update(machine)
      .set({
        stopped_at: old,
      })
      .where(eq(machine.id, failed.id))
      .run()
    await setRetention(0)
    assert.deepEqual(
      runRetention({
        db: h.db,
        stations: h.deps.stations,
      }).deleted,
      [],
    )
    await setRetention(604800)
    await api('POST', `/v1/machines/${box.id}/start`)
    await waitForMachine(h, box.id, 'running')
    const result = runRetention({
      db: h.db,
      stations: h.deps.stations,
    })

    assert.ok(!result.deleted.includes(box.id))
    assert.ok(!result.deleted.includes(failed.id))
    assert.ok(!result.expiring.includes(failed.id))
    assert.equal((await api('GET', `/v1/machines/${box.id}`)).body.delete_at, null)
  })

  test('the system deletes in production without an actor', async () => {
    const box = (
      await human('POST', placed(h, productionTarget, `machines`), {
        name: 'locked-retention',
        start: false,
      })
    ).body

    h.db
      .update(machine)
      .set({
        stopped_at: new Date(Date.now() - 8 * 86400_000),
      })
      .where(eq(machine.id, box.id))
      .run()
    const result = runRetention({
      db: h.db,
      stations: h.deps.stations,
    })

    assert.ok(result.deleted.includes(box.id))
  })
})

describe('production', () => {
  test('every machine operation but a read needs a human actor', async () => {
    const created = await human('POST', placed(h, productionTarget, `machines`), {
      name: 'locked-box',
    })

    assert.equal(created.status, 201, created.text)
    const id = created.body.id

    await waitForMachine(h, id, 'running')
    const attempts: [string, string, unknown][] = [
      [
        'POST',
        placed(h, productionTarget, `machines`),
        {
          name: 'agent-box',
        },
      ],
      [
        'PATCH',
        `/v1/machines/${id}`,
        {
          ttl_s: 600,
        },
      ],
      ['POST', `/v1/machines/${id}/start`, undefined],
      ['POST', `/v1/machines/${id}/stop`, undefined],
      [
        'POST',
        `/v1/machines/${id}/exec`,
        {
          command: ['true'],
        },
      ],
      ['POST', `/v1/machines/${id}/shells`, {}],
      ['POST', `/v1/machines/${id}/snapshots`, {}],
      [
        'PATCH',
        `/v1/machines/${id}/environment-variables`,
        {
          set: [
            {
              name: 'A',
              kind: 'literal',
              value: 'b',
            },
          ],
        },
      ],
      ['DELETE', `/v1/machines/${id}`, undefined],
    ]

    for (const [method, path, body] of attempts) {
      const reply = await api(method, path, body)

      assert.equal(reply.status, 403, `${method} ${path}: ${reply.text}`)
      assert.equal(reply.body.error.code, 'HUMAN_REQUIRED')
      assert.equal(reply.body.error.details.reason, 'human_required')
    }

    assert.equal((await api('GET', `/v1/machines/${id}`)).status, 200)
    assert.equal((await api('GET', placed(h, productionTarget, `machines`))).status, 200)
    assert.equal((await api('GET', `/v1/machines/${id}/runs`)).status, 200)
    const exec = await human('POST', `/v1/machines/${id}/exec`, {
      command: ['true'],
    })

    assert.equal(exec.status, 201, exec.text)
    const snapshot = await human('POST', `/v1/machines/${id}/snapshots`, {})

    assert.equal(snapshot.status, 201)
    assert.equal((await api('DELETE', `/v1/machine-snapshots/${snapshot.body.id}`)).status, 403)
    const deleted = await human('DELETE', `/v1/machine-snapshots/${snapshot.body.id}`)

    assert.equal(deleted.status, 200)
    assert.equal(
      rows(h, "select id from approval where status = 'waiting' and project_id = ?", project.id)
        .length,
      0,
    )
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
    const total = rows<{ n: number }>(h, 'select count(*) as n from machine')[0]!.n
    const running = rows<{ n: number }>(
      h,
      "select count(*) as n from machine where desired_state = 'running'",
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
    const full = await api('POST', placed(h, envId, `machines`), {
      start: false,
    })

    assert.equal(full.status, 422)
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
    const many = await api('POST', placed(h, envId, `machines`), {})

    assert.equal(many.body.error.details.limit, 'max_running')
    const cold = await createMachine(h, envId, {
      name: 'cold-quota',
      start: false,
    })
    const start = await api('POST', `/v1/machines/${cold.id}/start`)

    assert.equal(start.status, 422)
    assert.equal(start.body.error.details.limit, 'max_running')
    await limits({
      max_running: 20,
      memory_bytes: 1073741824,
    })
    const memory = await api('POST', placed(h, envId, `machines`), {
      size: {
        memory_bytes: 2147483648,
      },
    })

    assert.equal(memory.body.error.details.limit, 'memory_bytes')
    assert.equal(memory.body.error.details.requested, 2147483648)
    assert.equal(
      (
        await api('POST', placed(h, envId, `machines`), {
          size: {
            memory_bytes: 2147483648,
          },
          start: false,
        })
      ).status,
      201,
    )
    const resize = await api('PATCH', `/v1/machines/${cold.id}`, {
      size: {
        memory_bytes: 2147483648,
      },
    })

    assert.equal(resize.status, 200)
    await limits({
      memory_bytes: null,
    })
    assert.deepEqual(
      (await api('GET', '/v1/servers/station-1?fields=machine_limits')).body.machine_limits
        .memory_bytes,
      null,
    )
  })

  test('a create without memory_bytes gets the free memory rounded down to 256 MiB, and below 512 MiB the 4 GiB default meets the quota', async () => {
    const memory = async () =>
      (await api('GET', '/v1/servers/station-1?fields=machine_memory')).body.machine_memory
    const { used } = await memory()
    const limit = used + 3 * gibibyte + 100 * 1024 ** 2

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

    assert.equal(fitted.size.memory_bytes, 3 * gibibyte)
    const busy = used + 3 * gibibyte

    assert.deepEqual(await memory(), {
      limit,
      used: busy,
      free: 100 * 1024 ** 2,
    })
    const refused = await api('POST', placed(h, envId, `machines`), {})

    assert.equal(refused.status, 422)
    assert.equal(refused.body.error.code, 'MACHINE_QUOTA_EXCEEDED')
    assert.equal(
      refused.body.error.explanation,
      `Server station-1 allows ${bytesText(limit)} for memory_bytes; ${bytesText(busy)} is used and this change needs 4 GiB more.`,
    )
    const { holders, ...details } = refused.body.error.details

    assert.deepEqual(details, {
      server: station.stationId,
      limit: 'memory_bytes',
      allowed: limit,
      used: busy,
      requested: 4 * gibibyte,
    })
    const mine = holders.find((holder: { id: string }) => holder.id === fitted.id)

    assert.equal(mine.memory_bytes, 3 * gibibyte)
    assert.equal(mine.workspace, false)
    assert.equal((await api('DELETE', `/v1/machines/${fitted.id}`)).status, 200)
    await api('PATCH', '/v1/servers/station-1', {
      machine_limits: {
        max_running: 20,
        memory_bytes: null,
      },
    })
  })

  test('a station that reports no memory has no machine memory limit and fits the 4 GiB default', () => {
    const row = h.db.select().from(serverTable).where(eq(serverTable.id, station.stationId)).get()!
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
    const reply = await api('POST', placed(h, envId, `machines`), {
      start: false,
    })

    assert.equal(reply.status, 422)
    assert.equal(reply.body.error.code, 'MACHINE_DISK_FULL')
    assert.ok(reply.body.error.details.free_bytes < reply.body.error.details.min_free_bytes)
    await api('PATCH', '/v1/servers/station-1', {
      machine_limits: {
        min_free_bytes: null,
      },
    })
  })
})

describe('patch', () => {
  test('egress and disk size apply at once, restart-bound fields on a running machine carry a warning, network is refused while running', async () => {
    const box = await createMachine(h, envId, {
      name: 'patching',
    })

    await waitForMachine(h, box.id, 'running')
    const egress = await api('PATCH', `/v1/machines/${box.id}`, {
      egress: {
        mode: 'allowlist',
        domains: [
          {
            domain: 'example.com',
          },
        ],
      },
      size: {
        disk_bytes: 32212254720,
      },
    })

    assert.equal(egress.status, 200, egress.text)
    assert.deepEqual(egress.body.warnings, [])
    assert.equal(egress.body.egress.mode, 'allowlist')
    assert.equal(egress.body.size.disk_bytes, 32212254720)
    const restart = await api('PATCH', `/v1/machines/${box.id}`, {
      docker: true,
      size: {
        memory_bytes: 8589934592,
      },
      command: ['sleep', 'infinity'],
    })

    assert.equal(restart.body.warnings.length, 1)
    assert.equal(restart.body.warnings[0].code, 'MACHINE_RESTART_REQUIRED')
    assert.match(restart.body.warnings[0].explanation, /docker/)
    assert.equal(restart.body.docker, true)
    const network = await api('PATCH', `/v1/machines/${box.id}`, {
      network: 'environment',
    })

    assert.equal(network.status, 409)
    assert.equal(network.body.error.code, 'MACHINE_STATE_CONFLICT')
    assert.equal(network.body.error.details.status, 'running')
    await api('POST', `/v1/machines/${box.id}/stop`)
    await waitForMachine(h, box.id, 'stopped')
    const joined = await api('PATCH', `/v1/machines/${box.id}`, {
      network: 'environment',
    })

    assert.equal(joined.status, 200)
    assert.equal(joined.body.network, 'environment')
    assert.equal((await api('PATCH', `/v1/machines/${box.id}`, {})).status, 400)
  })

  test('lowering the disk below the used bytes is refused', async () => {
    const box = await createMachine(h, envId, {
      name: 'shrinking',
    })

    await waitForMachine(h, box.id, 'running')
    h.db
      .update(machine)
      .set({
        disk_used_bytes: 5368709120,
      })
      .where(eq(machine.id, box.id))
      .run()
    const reply = await api('PATCH', `/v1/machines/${box.id}`, {
      size: {
        disk_bytes: 1073741824,
      },
    })

    assert.equal(reply.status, 400)
    assert.equal(reply.body.error.details.issues[0].path, '/size/disk_bytes')
  })
})

describe('snapshots and forks', () => {
  test('a snapshot of a running machine is crash consistent, ready within 10 s, listable and forkable into another preview', async () => {
    const source = await createMachine(h, envId, {
      name: 'forkable',
      size: {
        cpu_millis: 1000,
      },
    })

    await waitForMachine(h, source.id, 'running')
    const snapshot = await api('POST', `/v1/machines/${source.id}/snapshots`, {
      name: 'base',
    })

    assert.equal(snapshot.status, 201, snapshot.text)
    assert.equal(snapshot.body.status, 'ready')
    assert.equal(snapshot.body.source_state, 'running')
    assert.deepEqual(
      snapshot.body.warnings.map((w: any) => w.code),
      ['MACHINE_SNAPSHOT_CRASH_CONSISTENT'],
    )
    assert.ok(snapshot.body.taken_at)
    const named = await api('POST', `/v1/machines/${source.id}/snapshots`, {
      name: 'base',
    })

    assert.equal(named.body.error.code, 'NAME_TAKEN')
    const listed = (await api('GET', `/v1/machines/${source.id}/snapshots?status=ready`)).body.items

    assert.deepEqual(
      listed.map((s: any) => s.id),
      [snapshot.body.id],
    )
    const detail = (await api('GET', `/v1/machine-snapshots/${snapshot.body.id}?fields=image,size`))
      .body

    assert.equal(detail.size.cpu_millis, 1000)
    const other = await createPreview(h, 'alpha', 'pr-12')
    const fork = await api('POST', placed(h, other.id, `machines`), {
      name: 'fork-b',
      from: {
        snapshot: snapshot.body.id,
      },
      start: false,
    })

    assert.equal(fork.status, 201, fork.text)
    assert.deepEqual(fork.body.forked_from, {
      machine_id: null,
      snapshot_id: snapshot.body.id,
    })
    assert.equal(fork.body.size.cpu_millis, 1000)
    assert.equal(fork.body.server_id, source.server_id)
    const doc = await station.waitForGeneration((d) => d.sandboxes?.[fork.body.id] !== undefined)

    assert.deepEqual((doc.sandboxes![fork.body.id]!.disk as any).from, {
      snapshot_id: snapshot.body.id,
    })
    const live = await api('POST', placed(h, envId, `machines`), {
      name: 'fork-live',
      from: {
        machine: source.id,
      },
      ttl_s: 300,
      start: false,
    })

    assert.equal(live.status, 201, live.text)
    assert.equal(live.body.ttl_s, 300)
    assert.deepEqual(live.body.forked_from, {
      machine_id: source.id,
      snapshot_id: null,
    })
    assert.deepEqual(
      live.body.warnings.map((w: any) => w.code),
      ['MACHINE_SNAPSHOT_CRASH_CONSISTENT'],
    )
    const named2 = await api('POST', placed(h, other.id, `machines`), {
      name: 'fork-by-name',
      from: {
        machine: 'forkable',
      },
      start: false,
    })

    assert.equal(named2.status, 404)
    const wrongStation = await api('POST', placed(h, envId, `machines`), {
      from: {
        machine: source.id,
      },
      server_id: 'station-plain',
    })

    assert.equal(wrongStation.status, 400)
    assert.equal(wrongStation.body.error.details.issues[0].path, '/server_id')
  })

  test('a fork inherits network, allowlist, docker, command and ttl from a snapshot and from a live machine, and takes no environment variables', async () => {
    const egress = {
      mode: 'allowlist',
      domains: [
        {
          domain: 'example.com',
          ports: [443],
        },
      ],
    }
    const source = await createMachine(h, envId, {
      name: 'joined-source',
      network: 'environment',
      docker: true,
      egress,
      command: ['/sbin/init'],
      ttl_s: 900,
      size: {
        cpu_millis: 1500,
      },
      environment_variables: [
        {
          name: 'TOKEN',
          kind: 'secret',
          value: 'hunter2hunter2',
        },
      ],
    })

    await waitForMachine(h, source.id, 'running')
    const snapshot = (await api('POST', `/v1/machines/${source.id}/snapshots`, {})).body
    const other = await createPreview(h, 'alpha', 'fork-inherit')
    const expectInherited = (box: any) => {
      assert.equal(box.network, 'environment')
      assert.equal(box.docker, true)
      assert.deepEqual(box.egress.mode, 'allowlist')
      assert.deepEqual(box.egress.domains, [
        {
          domain: 'example.com',
          wildcard: false,
          ports: [443],
        },
      ])
      assert.deepEqual(box.command, ['/sbin/init'])
      assert.equal(box.ttl_s, 900)
      assert.equal(box.size.cpu_millis, 1500)
    }
    const fromSnapshot = await api('POST', placed(h, other.id, `machines`), {
      name: 'from-snapshot',
      from: {
        snapshot: snapshot.id,
      },
      start: false,
    })

    assert.equal(fromSnapshot.status, 201, fromSnapshot.text)
    expectInherited((await api('GET', `/v1/machines/${fromSnapshot.body.id}?fields=*`)).body)
    const fromLive = await api('POST', placed(h, envId, `machines`), {
      name: 'from-live',
      from: {
        machine: source.id,
      },
      start: false,
    })

    assert.equal(fromLive.status, 201, fromLive.text)
    expectInherited((await api('GET', `/v1/machines/${fromLive.body.id}?fields=*`)).body)
    const keys = (await api('GET', `/v1/machines/${fromSnapshot.body.id}/environment-variables`))
      .body

    assert.deepEqual(keys.items ?? keys, [])
    const doc = await station.waitForGeneration(
      (d) => d.sandboxes?.[fromSnapshot.body.id] !== undefined,
    )

    assert.equal((doc.sandboxes![fromSnapshot.body.id] as any).network, 'environment')
    const overridden = await api('POST', placed(h, other.id, `machines`), {
      name: 'overridden',
      from: {
        snapshot: snapshot.id,
      },
      network: 'isolated',
      egress: {
        mode: 'open',
      },
      start: false,
    })

    assert.equal(overridden.body.network, 'isolated')
    assert.equal(overridden.body.egress.mode, 'open')
    const deletedSource = await api('DELETE', `/v1/machines/${source.id}`)

    assert.equal(deletedSource.status, 200)
    const later = await api('POST', placed(h, other.id, `machines`), {
      name: 'after-delete',
      from: {
        snapshot: snapshot.id,
      },
      start: false,
    })

    assert.equal(later.body.network, 'environment')
  })

  test('a fork of a creating or deleting machine, and a snapshot of one, is a state conflict', async () => {
    const hold = await startFakeStation(h, 'station-hold', {
      machines: {
        hold: true,
      },
    })
    const box = await createMachine(h, envId, {
      name: 'creating-fork',
      server_id: 'station-hold',
    })

    assert.equal(box.status, 'creating')
    const fork = await api('POST', placed(h, envId, `machines`), {
      from: {
        machine: box.id,
      },
    })

    assert.equal(fork.status, 409)
    assert.equal(fork.body.error.code, 'MACHINE_STATE_CONFLICT')
    const snapshot = await api('POST', `/v1/machines/${box.id}/snapshots`, {})

    assert.equal(snapshot.status, 409)
    assert.equal(snapshot.body.error.details.status, 'creating')
    await hold.close()
    await hold.waitFor(
      () => !h.deps.stations.isConnected(hold.stationId),
      5000,
      'the held station to disconnect',
    )
  })

  test('deleting a snapshot sends it to the station as destroy and removes the row once reported', async () => {
    const source = await createMachine(h, envId, {
      name: 'snapshot-owner',
      start: false,
    })
    const snapshot = (await api('POST', `/v1/machines/${source.id}/snapshots`, {})).body

    assert.equal(snapshot.status, 'ready')
    assert.deepEqual(snapshot.warnings, [])
    assert.equal(snapshot.source_state, 'stopped')
    const removed = await api('DELETE', `/v1/machine-snapshots/${snapshot.id}`)

    assert.deepEqual(removed.body, {
      deleted: true,
    })
    await station.waitFor(
      () => rows(h, 'select id from machine_snapshot where id = ?', snapshot.id).length === 0,
      5000,
      'the snapshot row to disappear',
    )
    assert.equal((await api('GET', `/v1/machine-snapshots/${snapshot.id}`)).status, 404)
  })
})

describe('previews that hold machines', () => {
  test('a named preview with a machine cannot be deleted, an expiring one deletes its machines and snapshots with it', async () => {
    const normal = await createPreview(h, 'alpha', 'holds-box')
    const box = await createMachine(h, normal.id, {
      name: 'resident',
      start: false,
    })
    const blocked = await api('DELETE', `/v1/previews/${normal.id}`)

    assert.equal(blocked.status, 409)
    assert.equal(blocked.body.error.code, 'DELETE_HAS_DEPENDENTS')
    assert.deepEqual(
      blocked.body.error.details.dependents.map((d: any) => d.id),
      [box.id],
    )
    await api('DELETE', `/v1/machines/${box.id}`)
    await station.waitFor(() => !machineRow(box.id), 5000, 'the machine to be removed')
    assert.equal((await api('DELETE', `/v1/previews/${normal.id}`)).status, 200)

    const temp = await createPreview(h, 'alpha', 'temp', {
      ttl_seconds: 3600,
    })
    const mine = await createMachine(h, temp.id, {
      name: 'temporary',
      start: false,
    })
    const snapshot = (await api('POST', `/v1/machines/${mine.id}/snapshots`, {})).body
    const removed = await api('DELETE', `/v1/previews/${temp.id}`)

    assert.equal(removed.status, 200, removed.text)
    await station.waitFor(
      () =>
        !machineRow(mine.id) &&
        rows(h, 'select id from machine_snapshot where id = ?', snapshot.id).length === 0,
      5000,
      'machine and snapshot removal',
    )
    const gone = (await events('machine.deleted')).find((e) => e.payload.machine === mine.id)!

    assert.equal(gone.payload.reason, 'preview')
  })

  test('a station that still holds a machine cannot be removed', async () => {
    const reply = await api('DELETE', '/v1/servers/station-1')

    assert.equal(reply.status, 409)
    assert.equal(reply.body.error.code, 'DELETE_HAS_DEPENDENTS')
  })
})
