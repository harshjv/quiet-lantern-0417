import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { eq } from 'drizzle-orm'

import { bytesText, gibibyte } from '@stationly/protocol'

import { sandbox, station as stationTable } from '../src/db/schema.ts'
import { runRetention } from '../src/sandboxes/lifecycle.ts'
import { fittingMemory, sandboxMemory } from '../src/sandboxes/limits.ts'

import { localOrigin, startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import type { FakeStation } from './helpers/fake-station.ts'
import { FakeRegistry } from './helpers/registry.ts'
import {
  createEnvironment,
  createProject,
  createSandbox,
  pinPlatform,
  rows,
  toolchainImageDigest,
  waitForSandbox,
} from './helpers/seed.ts'

let h: Dispatch
let registry: FakeRegistry
let station: FakeStation
let project: any
let envId: string
let protectedId: string

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

const sandboxRow = (id: string) => h.db.select().from(sandbox).where(eq(sandbox.id, id)).get()

const setRetention = async (value: number) => {
  const reply = await api('PATCH', '/v1/settings', {
    'sandbox.stopped_retention_s': value,
  })
  assert.equal(reply.status, 200, reply.text)
}

before(async () => {
  registry = FakeRegistry.install()
  registry.publish('alpine:3.20')
  h = await startDispatch()
  pinPlatform(h, {
    sandboxes: true,
  })
  station = await startFakeStation(h, 'station-1', {
    sandboxes: {},
  })
  project = await createProject(h, 'alpha')
  envId = project.default_environment_id
  protectedId = (
    await createEnvironment(
      h,
      'alpha',
      'locked',
      {
        protected: true,
      },
      true,
    )
  ).id
})

after(async () => {
  await h.close()
  registry.restore()
})

describe('create, list, get', () => {
  test('a sandbox is created with the documented defaults, runs on the station and reports its state', async () => {
    const created = await api('POST', `/v1/environments/${envId}/sandboxes`, {})
    assert.equal(created.status, 201, created.text)
    const box = created.body
    assert.match(box.id, /^sbx_[0-9A-HJKMNP-TV-Z]{26}$/)
    assert.equal(box.name, `sandbox-${box.id.slice(-6).toLowerCase()}`)
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
    const running = await waitForSandbox(h, box.id, 'running')
    assert.ok(running.address)
    assert.ok(running.started_at)
    assert.equal(running.status_reason, null)
    assert.equal(running.disk_used_bytes, 734003200)
    const started = (await events('sandbox.started')).find((e) => e.payload.sandbox === box.id)!
    assert.equal(started.payload.reason, 'create')
    assert.equal(started.subject.project_id, project.id)
    assert.equal(started.subject.environment_id, envId)
  })

  test('list and get honour filters, fields and expansions', async () => {
    const box = await createSandbox(h, envId, {
      name: 'lister',
      network: 'isolated',
    })
    await waitForSandbox(h, box.id, 'running')
    const all = (await api('GET', `/v1/environments/${envId}/sandboxes`)).body
    assert.ok(all.items.some((s: any) => s.id === box.id))
    assert.ok(all.items.every((s: any) => s.egress.domains === undefined))
    const running = (
      await api(
        'GET',
        `/v1/environments/${envId}/sandboxes?status=running&network=isolated&station=station-1`,
      )
    ).body.items
    assert.ok(running.some((s: any) => s.id === box.id))
    assert.deepEqual(
      (await api('GET', `/v1/environments/${envId}/sandboxes?status=failed`)).body.items,
      [],
    )
    assert.deepEqual(
      (
        await api('GET', `/v1/environments/${envId}/sandboxes?network=environment`)
      ).body.items.filter((s: any) => s.id === box.id),
      [],
    )
    const full = (await api('GET', `/v1/sandboxes/${box.id}?fields=*`)).body
    assert.deepEqual(full.egress, {
      mode: 'open',
      domains: [],
    })
    assert.deepEqual(full.snapshots, [])
    assert.deepEqual(full.runs, [])
    assert.equal(full.metrics.sandbox_id, box.id)
    assert.equal(full.command, null)
    assert.equal(full.failure, null)
    const flat = await api('GET', `/v1/projects/alpha/environments/production/sandboxes/lister`)
    assert.equal(flat.status, 200)
    assert.equal(flat.body.id, box.id)
  })

  test('a name is unique in its environment and refuses a bad slug', async () => {
    await createSandbox(h, envId, {
      name: 'unique-name',
      start: false,
    })
    const again = await api('POST', `/v1/environments/${envId}/sandboxes`, {
      name: 'unique-name',
    })
    assert.equal(again.status, 409)
    assert.equal(again.body.error.code, 'NAME_TAKEN')
    const bad = await api('POST', `/v1/environments/${envId}/sandboxes`, {
      name: 'Not A Slug',
    })
    assert.equal(bad.status, 400)
    assert.equal(bad.body.error.code, 'VALIDATION_FAILED')
  })

  test('start = false creates a stopped sandbox that holds no stop_at and no running desire', async () => {
    const box = await createSandbox(h, envId, {
      name: 'cold',
      start: false,
    })
    assert.equal(box.status, 'stopped')
    assert.equal(box.status_reason, 'created_stopped')
    assert.equal(box.desired_state, 'stopped')
    assert.equal(box.stop_at, null)
    assert.ok(box.delete_at)
    assert.equal(
      Date.parse(box.delete_at) - Date.parse(sandboxRow(box.id)!.stopped_at!.toISOString()),
      604800_000,
    )
  })

  test('an image reference is resolved to a digest, and an unreachable one is refused', async () => {
    const box = await createSandbox(h, envId, {
      name: 'alpine-box',
      image: {
        ref: 'alpine:3.20',
      },
      start: false,
    })
    assert.equal(box.image.ref, 'alpine:3.20')
    assert.match(box.image.digest, /^sha256:[0-9a-f]{64}$/)
    const missing = await api('POST', `/v1/environments/${envId}/sandboxes`, {
      name: 'ghost',
      image: {
        ref: 'nowhere.invalid/none:1',
      },
    })
    assert.equal(missing.status, 422)
    assert.equal(missing.body.error.code, 'SOURCE_UNREACHABLE')
  })

  test('egress domains are validated and normalized under /egress/domains', async () => {
    const box = await createSandbox(h, envId, {
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
    const full = (await api('GET', `/v1/sandboxes/${box.id}?fields=egress`)).body
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
    const bad = await api('POST', `/v1/environments/${envId}/sandboxes`, {
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
    const tooMany = await api('POST', `/v1/environments/${envId}/sandboxes`, {
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
    const ports = await api('POST', `/v1/environments/${envId}/sandboxes`, {
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

  test('a station without the sandbox capability refuses a sandbox', async () => {
    await startFakeStation(h, 'station-plain')
    const reply = await api('POST', `/v1/environments/${envId}/sandboxes`, {
      station_id: 'station-plain',
    })
    assert.equal(reply.status, 422)
    assert.equal(reply.body.error.code, 'STATION_CAPABILITY_MISSING')
    assert.equal(reply.body.error.details.missing, 'sandboxes')
  })
})

describe('start, stop, delete', () => {
  test('stop keeps the disk and clears stop_at, start sets a new one and a ttl_s replaces the stored one', async () => {
    const box = await createSandbox(h, envId, {
      name: 'cycle',
    })
    await waitForSandbox(h, box.id, 'running')
    const stopping = await api('POST', `/v1/sandboxes/${box.id}/stop`)
    assert.equal(stopping.status, 200, stopping.text)
    assert.equal(stopping.body.status, 'stopping')
    assert.equal(stopping.body.stop_at, null)
    const stopped = await waitForSandbox(h, box.id, 'stopped')
    assert.equal(stopped.status_reason, 'user')
    assert.ok(stopped.stopped_at)
    assert.equal(Date.parse(stopped.delete_at) - Date.parse(stopped.stopped_at), 604800_000)
    assert.equal(stopped.address, null)
    const stopEvent = (await events('sandbox.stopped')).find((e) => e.payload.sandbox === box.id)!
    assert.equal(stopEvent.payload.reason, 'user')
    assert.ok(stopEvent.payload.ran_for_s >= 0)
    const restarted = await api('POST', `/v1/sandboxes/${box.id}/start`, {
      ttl_s: 120,
    })
    assert.equal(restarted.status, 200, restarted.text)
    assert.equal(restarted.body.status, 'starting')
    assert.equal(restarted.body.ttl_s, 120)
    assert.equal(restarted.body.delete_at, null)
    const left = Date.parse(restarted.body.stop_at) - Date.now()
    assert.ok(left > 110_000 && left <= 120_000)
    await waitForSandbox(h, box.id, 'running')
    const startEvents = (await events('sandbox.started')).filter(
      (e) => e.payload.sandbox === box.id,
    )
    assert.equal(startEvents.at(-1)!.payload.reason, 'user')
  })

  test('delete removes the sandbox after the station reports it deleted and keeps its snapshots', async () => {
    const box = await createSandbox(h, envId, {
      name: 'doomed',
    })
    await waitForSandbox(h, box.id, 'running')
    const snapshot = await api('POST', `/v1/sandboxes/${box.id}/snapshots`, {
      name: 'keep-me',
    })
    assert.equal(snapshot.status, 201)
    const removed = await api('DELETE', `/v1/sandboxes/${box.id}`)
    assert.equal(removed.status, 200, removed.text)
    assert.deepEqual(removed.body, {
      deleted: true,
      snapshots_kept: 1,
    })
    assert.equal(
      sandboxRow(box.id)?.status === 'deleting' || sandboxRow(box.id) === undefined,
      true,
    )
    await station.waitFor(() => !sandboxRow(box.id), 5000, 'the sandbox row to disappear')
    assert.equal((await api('GET', `/v1/sandboxes/${box.id}`)).status, 404)
    const gone = (await events('sandbox.deleted')).find((e) => e.payload.sandbox === box.id)!
    assert.equal(gone.payload.reason, 'user')
    assert.equal(gone.payload.snapshots_kept, 1)
    assert.equal(gone.payload.actor.type, 'token')
    const kept = (await api('GET', `/v1/environments/${envId}/sandbox-snapshots`)).body.items
    assert.ok(kept.some((s: any) => s.id === snapshot.body.id && s.sandbox_id === box.id))
  })

  test('a deleting sandbox refuses start and changes with SANDBOX_STATE_CONFLICT', async () => {
    const box = await createSandbox(h, envId, {
      name: 'dying',
      start: false,
    })
    station.releaseSandboxes()
    h.db
      .update(sandbox)
      .set({
        status: 'deleting',
      })
      .where(eq(sandbox.id, box.id))
      .run()
    const start = await api('POST', `/v1/sandboxes/${box.id}/start`)
    assert.equal(start.status, 409)
    assert.equal(start.body.error.code, 'SANDBOX_STATE_CONFLICT')
    assert.equal(start.body.error.details.status, 'deleting')
    assert.ok(Array.isArray(start.body.error.details.allowed))
    const patch = await api('PATCH', `/v1/sandboxes/${box.id}`, {
      ttl_s: 600,
    })
    assert.equal(patch.status, 409)
    h.db
      .update(sandbox)
      .set({
        status: 'stopped',
      })
      .where(eq(sandbox.id, box.id))
      .run()
  })

  test('a failed start is reported with its diagnosis and can be started again', async () => {
    const box = await createSandbox(h, envId, {
      name: 'flaky',
    })
    await waitForSandbox(h, box.id, 'running')
    station.failSandbox(box.id, {
      phase: 'start',
      code: 'SANDBOX_START_FAILED',
      summary: 'runsc create failed',
      details: {
        step: 'create',
        error: 'boom',
      },
    })
    const failed = await waitForSandbox(h, box.id, 'failed')
    assert.equal(failed.failure.code, 'SANDBOX_START_FAILED')
    assert.equal(failed.desired_state, 'stopped')
    const event = (await events('sandbox.failed')).find((e) => e.payload.sandbox === box.id)!
    assert.deepEqual([event.payload.phase, event.payload.code], ['start', 'SANDBOX_START_FAILED'])
    const again = await api('POST', `/v1/sandboxes/${box.id}/start`)
    assert.equal(again.status, 200)
    await waitForSandbox(h, box.id, 'running')
  })
})

describe('time to live', () => {
  test('changing ttl_s on a running sandbox extends stop_at from now, on a stopped one it only stores the value', async () => {
    const box = await createSandbox(h, envId, {
      name: 'extend',
      ttl_s: 600,
    })
    await waitForSandbox(h, box.id, 'running')
    const patched = await api('PATCH', `/v1/sandboxes/${box.id}`, {
      ttl_s: 7200,
    })
    assert.equal(patched.status, 200, patched.text)
    const left = Date.parse(patched.body.stop_at) - Date.now()
    assert.ok(left > 7190_000 && left <= 7200_000)
    assert.deepEqual(patched.body.warnings, [])
    await api('POST', `/v1/sandboxes/${box.id}/stop`)
    await waitForSandbox(h, box.id, 'stopped')
    const stored = await api('PATCH', `/v1/sandboxes/${box.id}`, {
      ttl_s: 900,
    })
    assert.equal(stored.body.ttl_s, 900)
    assert.equal(stored.body.stop_at, null)
  })

  test('ttl_s outside 60 to 2592000 is refused', async () => {
    for (const ttl_s of [59, 2592001]) {
      const reply = await api('POST', `/v1/environments/${envId}/sandboxes`, {
        ttl_s,
        start: false,
      })
      assert.equal(reply.status, 400)
      assert.equal(reply.body.error.code, 'VALIDATION_FAILED')
    }
  })

  test('the station stopping at ttl sets desired_state to stopped, clears stop_at and emits the event', async () => {
    const box = await createSandbox(h, envId, {
      name: 'expiring-ttl',
      ttl_s: 60,
    })
    await waitForSandbox(h, box.id, 'running')
    station.expireSandbox(box.id, 'ttl')
    const stopped = await waitForSandbox(h, box.id, 'stopped')
    assert.equal(stopped.status_reason, 'ttl')
    assert.equal(stopped.desired_state, 'stopped')
    assert.equal(stopped.stop_at, null)
    const event = (await events('sandbox.stopped')).find((e) => e.payload.sandbox === box.id)!
    assert.equal(event.payload.reason, 'ttl')
    const generation = await station.waitForGeneration(
      (doc) => doc.sandboxes?.[box.id]?.desired_state === 'stopped',
    )
    assert.equal(generation.sandboxes![box.id]!.stop_at, null)
  })

  test('an exited or OOM-killed init stops the sandbox and nothing restarts it', async () => {
    const exited = await createSandbox(h, envId, {
      name: 'exits',
    })
    await waitForSandbox(h, exited.id, 'running')
    station.expireSandbox(exited.id, 'exited', 3)
    const a = await waitForSandbox(h, exited.id, 'stopped')
    assert.deepEqual([a.status_reason, a.exit_code, a.desired_state], ['exited', 3, 'stopped'])
    const oom = await createSandbox(h, envId, {
      name: 'oom',
    })
    await waitForSandbox(h, oom.id, 'running')
    station.expireSandbox(oom.id, 'oom', 137)
    const b = await waitForSandbox(h, oom.id, 'stopped')
    assert.deepEqual([b.status_reason, b.exit_code], ['oom', 137])
  })
})

describe('retention of stopped sandboxes', () => {
  test('sandbox.stopped_retention_s is 604800 by default, 0 or at least 86400 otherwise', async () => {
    const value = (await api('GET', '/v1/settings?prefix=sandbox.')).body
    const entry = (value.items ?? value).find((s: any) => s.key === 'sandbox.stopped_retention_s')
    assert.equal(entry.value, 604800)
    for (const bad of [86399, -1, 1.5]) {
      const reply = await api('PATCH', '/v1/settings', {
        'sandbox.stopped_retention_s': bad,
      })
      assert.equal(reply.status, 400, `${bad}`)
    }
    await setRetention(0)
    await setRetention(86400)
    await setRetention(604800)
  })

  test('one day before delete_at the sandbox.expiring event is emitted once per stop, and the deletion keeps snapshots', async () => {
    const box = await createSandbox(h, envId, {
      name: 'retained',
    })
    await waitForSandbox(h, box.id, 'running')
    const snapshot = (
      await api('POST', `/v1/sandboxes/${box.id}/snapshots`, {
        name: 'survivor',
      })
    ).body
    await api('POST', `/v1/sandboxes/${box.id}/stop`)
    await waitForSandbox(h, box.id, 'stopped')
    const stoppedAt = sandboxRow(box.id)!.stopped_at!
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
    const expiring = (await events('sandbox.expiring')).filter((e) => e.payload.sandbox === box.id)
    assert.equal(expiring.length, 1)
    assert.equal(
      expiring[0]!.payload.delete_at,
      new Date(stoppedAt.getTime() + 7 * day).toISOString(),
    )
    assert.equal(sandboxRow(box.id)!.status, 'stopped')
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
    assert.equal(sandboxRow(box.id)?.deletion?.reason ?? 'removed', 'retention')
    await station.waitFor(() => !sandboxRow(box.id), 5000, 'retention deletion to finish')
    const deleted = (await events('sandbox.deleted')).find((e) => e.payload.sandbox === box.id)!
    assert.equal(deleted.payload.reason, 'retention')
    assert.equal(deleted.payload.actor.type, 'system')
    assert.equal(deleted.payload.snapshots_kept, 1)
    assert.equal((await api('GET', `/v1/sandbox-snapshots/${snapshot.id}`)).status, 200)
  })

  test('a start resets the clock, only stopped sandboxes are deleted and 0 disables the sweep', async () => {
    const box = await createSandbox(h, envId, {
      name: 'reset-clock',
    })
    await waitForSandbox(h, box.id, 'running')
    const failed = await createSandbox(h, envId, {
      name: 'failed-keeps',
    })
    await waitForSandbox(h, failed.id, 'running')
    station.failSandbox(failed.id, {
      phase: 'start',
      code: 'SANDBOX_START_FAILED',
      summary: 'x',
    })
    await waitForSandbox(h, failed.id, 'failed')
    await api('POST', `/v1/sandboxes/${box.id}/stop`)
    await waitForSandbox(h, box.id, 'stopped')
    const old = new Date(Date.now() - 30 * 86400_000)
    h.db
      .update(sandbox)
      .set({
        stopped_at: old,
      })
      .where(eq(sandbox.id, box.id))
      .run()
    h.db
      .update(sandbox)
      .set({
        stopped_at: old,
      })
      .where(eq(sandbox.id, failed.id))
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
    await api('POST', `/v1/sandboxes/${box.id}/start`)
    await waitForSandbox(h, box.id, 'running')
    const result = runRetention({
      db: h.db,
      stations: h.deps.stations,
    })
    assert.ok(!result.deleted.includes(box.id))
    assert.ok(!result.deleted.includes(failed.id))
    assert.ok(!result.expiring.includes(failed.id))
    assert.equal((await api('GET', `/v1/sandboxes/${box.id}`)).body.delete_at, null)
  })

  test('the system deletes in a protected environment without an actor', async () => {
    const box = (
      await human('POST', `/v1/environments/${protectedId}/sandboxes`, {
        name: 'locked-retention',
        start: false,
      })
    ).body
    h.db
      .update(sandbox)
      .set({
        stopped_at: new Date(Date.now() - 8 * 86400_000),
      })
      .where(eq(sandbox.id, box.id))
      .run()
    const result = runRetention({
      db: h.db,
      stations: h.deps.stations,
    })
    assert.ok(result.deleted.includes(box.id))
  })
})

describe('protected environments', () => {
  test('every sandbox operation but a read needs a human actor', async () => {
    const created = await human('POST', `/v1/environments/${protectedId}/sandboxes`, {
      name: 'locked-box',
    })
    assert.equal(created.status, 201, created.text)
    const id = created.body.id
    await waitForSandbox(h, id, 'running')
    const attempts: [string, string, unknown][] = [
      [
        'POST',
        `/v1/environments/${protectedId}/sandboxes`,
        {
          name: 'agent-box',
        },
      ],
      [
        'PATCH',
        `/v1/sandboxes/${id}`,
        {
          ttl_s: 600,
        },
      ],
      ['POST', `/v1/sandboxes/${id}/start`, undefined],
      ['POST', `/v1/sandboxes/${id}/stop`, undefined],
      [
        'POST',
        `/v1/sandboxes/${id}/exec`,
        {
          command: ['true'],
        },
      ],
      ['POST', `/v1/sandboxes/${id}/shells`, {}],
      ['POST', `/v1/sandboxes/${id}/snapshots`, {}],
      [
        'PATCH',
        `/v1/sandboxes/${id}/variables`,
        {
          set: [
            {
              key: 'A',
              kind: 'literal',
              value: 'b',
            },
          ],
        },
      ],
      ['DELETE', `/v1/sandboxes/${id}`, undefined],
    ]
    for (const [method, path, body] of attempts) {
      const reply = await api(method, path, body)
      assert.equal(reply.status, 403, `${method} ${path}: ${reply.text}`)
      assert.equal(reply.body.error.code, 'PROTECTED_ENVIRONMENT')
      assert.equal(reply.body.error.details.reason, 'human_required')
    }
    assert.equal((await api('GET', `/v1/sandboxes/${id}`)).status, 200)
    assert.equal((await api('GET', `/v1/environments/${protectedId}/sandboxes`)).status, 200)
    assert.equal((await api('GET', `/v1/sandboxes/${id}/runs`)).status, 200)
    const exec = await human('POST', `/v1/sandboxes/${id}/exec`, {
      command: ['true'],
    })
    assert.equal(exec.status, 201, exec.text)
    const snapshot = await human('POST', `/v1/sandboxes/${id}/snapshots`, {})
    assert.equal(snapshot.status, 201)
    const deleted = await human('DELETE', `/v1/sandbox-snapshots/${snapshot.body.id}`)
    assert.equal(deleted.status, 200)
    assert.equal((await api('DELETE', `/v1/sandbox-snapshots/${snapshot.body.id}`)).status, 403)
    assert.equal(
      rows(
        h,
        "select id from staged_change where status = 'staged' and environment_id = ?",
        protectedId,
      ).length,
      0,
    )
  })
})

describe('station limits', () => {
  test('max_sandboxes, max_running and memory_bytes refuse with SANDBOX_QUOTA_EXCEEDED naming limit, used and requested', async () => {
    const limits = async (body: Record<string, unknown>) => {
      const reply = await api('PATCH', '/v1/stations/station-1', {
        sandbox_limits: body,
      })
      assert.equal(reply.status, 200, reply.text)
      return reply.body.sandbox_limits
    }
    const total = rows<{ n: number }>(h, 'select count(*) as n from sandbox')[0]!.n
    const running = rows<{ n: number }>(
      h,
      "select count(*) as n from sandbox where desired_state = 'running'",
    )[0]!.n
    assert.deepEqual(
      await limits({
        max_sandboxes: total,
      }),
      {
        max_sandboxes: total,
        max_running: 20,
        memory_bytes: null,
        min_free_bytes: null,
      },
    )
    const full = await api('POST', `/v1/environments/${envId}/sandboxes`, {
      start: false,
    })
    assert.equal(full.status, 422)
    assert.equal(full.body.error.code, 'SANDBOX_QUOTA_EXCEEDED')
    assert.deepEqual(
      [
        full.body.error.details.limit,
        full.body.error.details.used,
        full.body.error.details.requested,
      ],
      ['max_sandboxes', total, 1],
    )
    await limits({
      max_sandboxes: 100,
      max_running: running,
    })
    const many = await api('POST', `/v1/environments/${envId}/sandboxes`, {})
    assert.equal(many.body.error.details.limit, 'max_running')
    const cold = await createSandbox(h, envId, {
      name: 'cold-quota',
      start: false,
    })
    const start = await api('POST', `/v1/sandboxes/${cold.id}/start`)
    assert.equal(start.status, 422)
    assert.equal(start.body.error.details.limit, 'max_running')
    await limits({
      max_running: 20,
      memory_bytes: 1073741824,
    })
    const memory = await api('POST', `/v1/environments/${envId}/sandboxes`, {
      size: {
        memory_bytes: 2147483648,
      },
    })
    assert.equal(memory.body.error.details.limit, 'memory_bytes')
    assert.equal(memory.body.error.details.requested, 2147483648)
    assert.equal(
      (
        await api('POST', `/v1/environments/${envId}/sandboxes`, {
          size: {
            memory_bytes: 2147483648,
          },
          start: false,
        })
      ).status,
      201,
    )
    const resize = await api('PATCH', `/v1/sandboxes/${cold.id}`, {
      size: {
        memory_bytes: 2147483648,
      },
    })
    assert.equal(resize.status, 200)
    await limits({
      memory_bytes: null,
    })
    assert.deepEqual(
      (await api('GET', '/v1/stations/station-1?fields=sandbox_limits')).body.sandbox_limits
        .memory_bytes,
      null,
    )
  })

  test('a create without memory_bytes gets the free memory rounded down to 256 MiB, and below 512 MiB the 4 GiB default meets the quota', async () => {
    const memory = async () =>
      (await api('GET', '/v1/stations/station-1?fields=sandbox_memory')).body.sandbox_memory
    const { used } = await memory()
    const limit = used + 3 * gibibyte + 100 * 1024 ** 2
    await api('PATCH', '/v1/stations/station-1', {
      sandbox_limits: {
        max_running: 100,
        memory_bytes: limit,
      },
    })
    assert.deepEqual(await memory(), {
      limit,
      used,
      free: limit - used,
    })
    const fitted = await createSandbox(h, envId, {
      name: 'fitted-memory',
    })
    assert.equal(fitted.size.memory_bytes, 3 * gibibyte)
    const busy = used + 3 * gibibyte
    assert.deepEqual(await memory(), {
      limit,
      used: busy,
      free: 100 * 1024 ** 2,
    })
    const refused = await api('POST', `/v1/environments/${envId}/sandboxes`, {})
    assert.equal(refused.status, 422)
    assert.equal(refused.body.error.code, 'SANDBOX_QUOTA_EXCEEDED')
    assert.equal(
      refused.body.error.explanation,
      `Station station-1 allows ${bytesText(limit)} for memory_bytes; ${bytesText(busy)} is used and this change needs 4 GiB more.`,
    )
    assert.deepEqual(refused.body.error.details, {
      station: station.stationId,
      limit: 'memory_bytes',
      allowed: limit,
      used: busy,
      requested: 4 * gibibyte,
    })
    assert.equal((await api('DELETE', `/v1/sandboxes/${fitted.id}`)).status, 200)
    await api('PATCH', '/v1/stations/station-1', {
      sandbox_limits: {
        max_running: 20,
        memory_bytes: null,
      },
    })
  })

  test('a station that reports no memory has no sandbox memory limit and fits the 4 GiB default', () => {
    const row = h.db
      .select()
      .from(stationTable)
      .where(eq(stationTable.id, station.stationId))
      .get()!
    const unreported = {
      ...row,
      resources: null,
      sandbox_limits: {
        ...row.sandbox_limits,
        memory_bytes: null,
      },
    }
    const memory = sandboxMemory(h.db, unreported)
    assert.equal(memory.limit, null)
    assert.equal(memory.free, null)
    assert.equal(fittingMemory(h.db, unreported), 4 * gibibyte)
  })

  test('only an instance admin changes sandbox_limits', async () => {
    const scoped = await h.call('POST', '/v1/tokens', {
      token: h.admin.token,
      body: {
        name: 'deployer',
        kind: 'scoped',
        scopes: [
          {
            project_id: '*',
            environment_id: '*',
            level: 'deploy',
          },
        ],
      },
    })
    const reply = await h.call('PATCH', '/v1/stations/station-1', {
      token: scoped.body.key,
      body: {
        sandbox_limits: {
          max_running: 1,
        },
      },
    })
    assert.equal(reply.status, 403)
  })

  test('sandbox disk below min_free_bytes refuses a new disk with SANDBOX_DISK_FULL', async () => {
    await api('PATCH', '/v1/stations/station-1', {
      sandbox_limits: {
        min_free_bytes: 900000000000,
      },
    })
    const reply = await api('POST', `/v1/environments/${envId}/sandboxes`, {
      start: false,
    })
    assert.equal(reply.status, 422)
    assert.equal(reply.body.error.code, 'SANDBOX_DISK_FULL')
    assert.ok(reply.body.error.details.free_bytes < reply.body.error.details.min_free_bytes)
    await api('PATCH', '/v1/stations/station-1', {
      sandbox_limits: {
        min_free_bytes: null,
      },
    })
  })
})

describe('patch', () => {
  test('egress and disk size apply at once, restart-bound fields on a running sandbox carry a warning, network is refused while running', async () => {
    const box = await createSandbox(h, envId, {
      name: 'patching',
    })
    await waitForSandbox(h, box.id, 'running')
    const egress = await api('PATCH', `/v1/sandboxes/${box.id}`, {
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
    const restart = await api('PATCH', `/v1/sandboxes/${box.id}`, {
      docker: true,
      size: {
        memory_bytes: 8589934592,
      },
      command: ['sleep', 'infinity'],
    })
    assert.equal(restart.body.warnings.length, 1)
    assert.equal(restart.body.warnings[0].code, 'SANDBOX_RESTART_REQUIRED')
    assert.match(restart.body.warnings[0].explanation, /docker/)
    assert.equal(restart.body.docker, true)
    const network = await api('PATCH', `/v1/sandboxes/${box.id}`, {
      network: 'environment',
    })
    assert.equal(network.status, 409)
    assert.equal(network.body.error.code, 'SANDBOX_STATE_CONFLICT')
    assert.equal(network.body.error.details.status, 'running')
    await api('POST', `/v1/sandboxes/${box.id}/stop`)
    await waitForSandbox(h, box.id, 'stopped')
    const joined = await api('PATCH', `/v1/sandboxes/${box.id}`, {
      network: 'environment',
    })
    assert.equal(joined.status, 200)
    assert.equal(joined.body.network, 'environment')
    assert.equal((await api('PATCH', `/v1/sandboxes/${box.id}`, {})).status, 400)
  })

  test('lowering the disk below the used bytes is refused', async () => {
    const box = await createSandbox(h, envId, {
      name: 'shrinking',
    })
    await waitForSandbox(h, box.id, 'running')
    h.db
      .update(sandbox)
      .set({
        disk_used_bytes: 5368709120,
      })
      .where(eq(sandbox.id, box.id))
      .run()
    const reply = await api('PATCH', `/v1/sandboxes/${box.id}`, {
      size: {
        disk_bytes: 1073741824,
      },
    })
    assert.equal(reply.status, 400)
    assert.equal(reply.body.error.details.issues[0].path, '/size/disk_bytes')
  })
})

describe('snapshots and forks', () => {
  test('a snapshot of a running sandbox is crash consistent, ready within 10 s, listable and forkable into another environment', async () => {
    const source = await createSandbox(h, envId, {
      name: 'forkable',
      size: {
        cpu_millis: 1000,
      },
    })
    await waitForSandbox(h, source.id, 'running')
    const snapshot = await api('POST', `/v1/sandboxes/${source.id}/snapshots`, {
      name: 'base',
    })
    assert.equal(snapshot.status, 201, snapshot.text)
    assert.equal(snapshot.body.status, 'ready')
    assert.equal(snapshot.body.source_state, 'running')
    assert.deepEqual(
      snapshot.body.warnings.map((w: any) => w.code),
      ['SANDBOX_SNAPSHOT_CRASH_CONSISTENT'],
    )
    assert.ok(snapshot.body.taken_at)
    const named = await api('POST', `/v1/sandboxes/${source.id}/snapshots`, {
      name: 'base',
    })
    assert.equal(named.body.error.code, 'NAME_TAKEN')
    const listed = (await api('GET', `/v1/sandboxes/${source.id}/snapshots?status=ready`)).body
      .items
    assert.deepEqual(
      listed.map((s: any) => s.id),
      [snapshot.body.id],
    )
    const detail = (await api('GET', `/v1/sandbox-snapshots/${snapshot.body.id}?fields=image,size`))
      .body
    assert.equal(detail.size.cpu_millis, 1000)
    const other = await createEnvironment(h, 'alpha', 'pr-12')
    const fork = await api('POST', `/v1/environments/${other.id}/sandboxes`, {
      name: 'fork-b',
      from: {
        snapshot: snapshot.body.id,
      },
      start: false,
    })
    assert.equal(fork.status, 201, fork.text)
    assert.deepEqual(fork.body.forked_from, {
      sandbox_id: null,
      snapshot_id: snapshot.body.id,
    })
    assert.equal(fork.body.size.cpu_millis, 1000)
    assert.equal(fork.body.station_id, source.station_id)
    const doc = await station.waitForGeneration((d) => d.sandboxes?.[fork.body.id] !== undefined)
    assert.deepEqual((doc.sandboxes![fork.body.id]!.disk as any).from, {
      snapshot_id: snapshot.body.id,
    })
    const live = await api('POST', `/v1/environments/${envId}/sandboxes`, {
      name: 'fork-live',
      from: {
        sandbox: source.id,
      },
      ttl_s: 300,
      start: false,
    })
    assert.equal(live.status, 201, live.text)
    assert.equal(live.body.ttl_s, 300)
    assert.deepEqual(live.body.forked_from, {
      sandbox_id: source.id,
      snapshot_id: null,
    })
    assert.deepEqual(
      live.body.warnings.map((w: any) => w.code),
      ['SANDBOX_SNAPSHOT_CRASH_CONSISTENT'],
    )
    const named2 = await api('POST', `/v1/environments/${other.id}/sandboxes`, {
      name: 'fork-by-name',
      from: {
        sandbox: 'forkable',
      },
      start: false,
    })
    assert.equal(named2.status, 404)
    const wrongStation = await api('POST', `/v1/environments/${envId}/sandboxes`, {
      from: {
        sandbox: source.id,
      },
      station_id: 'station-plain',
    })
    assert.equal(wrongStation.status, 400)
    assert.equal(wrongStation.body.error.details.issues[0].path, '/station_id')
  })

  test('a fork inherits network, allowlist, docker, command and ttl from a snapshot and from a live sandbox, and takes no variables', async () => {
    const egress = {
      mode: 'allowlist',
      domains: [
        {
          domain: 'example.com',
          ports: [443],
        },
      ],
    }
    const source = await createSandbox(h, envId, {
      name: 'joined-source',
      network: 'environment',
      docker: true,
      egress,
      command: ['/sbin/init'],
      ttl_s: 900,
      size: {
        cpu_millis: 1500,
      },
      variables: [
        {
          key: 'TOKEN',
          kind: 'sealed',
          value: 'hunter2hunter2',
        },
      ],
    })
    await waitForSandbox(h, source.id, 'running')
    const snapshot = (await api('POST', `/v1/sandboxes/${source.id}/snapshots`, {})).body
    const other = await createEnvironment(h, 'alpha', 'fork-inherit')
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
    const fromSnapshot = await api('POST', `/v1/environments/${other.id}/sandboxes`, {
      name: 'from-snapshot',
      from: {
        snapshot: snapshot.id,
      },
      start: false,
    })
    assert.equal(fromSnapshot.status, 201, fromSnapshot.text)
    expectInherited((await api('GET', `/v1/sandboxes/${fromSnapshot.body.id}?fields=*`)).body)
    const fromLive = await api('POST', `/v1/environments/${envId}/sandboxes`, {
      name: 'from-live',
      from: {
        sandbox: source.id,
      },
      start: false,
    })
    assert.equal(fromLive.status, 201, fromLive.text)
    expectInherited((await api('GET', `/v1/sandboxes/${fromLive.body.id}?fields=*`)).body)
    const variables = (await api('GET', `/v1/sandboxes/${fromSnapshot.body.id}/variables`)).body
    assert.deepEqual(variables.items ?? variables, [])
    const doc = await station.waitForGeneration(
      (d) => d.sandboxes?.[fromSnapshot.body.id] !== undefined,
    )
    assert.equal((doc.sandboxes![fromSnapshot.body.id] as any).network, 'environment')
    const overridden = await api('POST', `/v1/environments/${other.id}/sandboxes`, {
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
    const deletedSource = await api('DELETE', `/v1/sandboxes/${source.id}`)
    assert.equal(deletedSource.status, 200)
    const later = await api('POST', `/v1/environments/${other.id}/sandboxes`, {
      name: 'after-delete',
      from: {
        snapshot: snapshot.id,
      },
      start: false,
    })
    assert.equal(later.body.network, 'environment')
  })

  test('a fork of a creating or deleting sandbox, and a snapshot of one, is a state conflict', async () => {
    const hold = await startFakeStation(h, 'station-hold', {
      sandboxes: {
        hold: true,
      },
    })
    const box = await createSandbox(h, envId, {
      name: 'creating-fork',
      station_id: 'station-hold',
    })
    assert.equal(box.status, 'creating')
    const fork = await api('POST', `/v1/environments/${envId}/sandboxes`, {
      from: {
        sandbox: box.id,
      },
    })
    assert.equal(fork.status, 409)
    assert.equal(fork.body.error.code, 'SANDBOX_STATE_CONFLICT')
    const snapshot = await api('POST', `/v1/sandboxes/${box.id}/snapshots`, {})
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
    const source = await createSandbox(h, envId, {
      name: 'snapshot-owner',
      start: false,
    })
    const snapshot = (await api('POST', `/v1/sandboxes/${source.id}/snapshots`, {})).body
    assert.equal(snapshot.status, 'ready')
    assert.deepEqual(snapshot.warnings, [])
    assert.equal(snapshot.source_state, 'stopped')
    const removed = await api('DELETE', `/v1/sandbox-snapshots/${snapshot.id}`)
    assert.deepEqual(removed.body, {
      deleted: true,
    })
    await station.waitFor(
      () => rows(h, 'select id from sandbox_snapshot where id = ?', snapshot.id).length === 0,
      5000,
      'the snapshot row to disappear',
    )
    assert.equal((await api('GET', `/v1/sandbox-snapshots/${snapshot.id}`)).status, 404)
  })
})

describe('environments that hold sandboxes', () => {
  test('a normal environment with a sandbox cannot be deleted, an ephemeral one deletes its sandboxes and snapshots with it', async () => {
    const normal = await createEnvironment(h, 'alpha', 'holds-box')
    const box = await createSandbox(h, normal.id, {
      name: 'resident',
      start: false,
    })
    const blocked = await api('DELETE', `/v1/environments/${normal.id}`)
    assert.equal(blocked.status, 409)
    assert.equal(blocked.body.error.code, 'DELETE_HAS_DEPENDENTS')
    assert.deepEqual(
      blocked.body.error.details.dependents.map((d: any) => d.id),
      [box.id],
    )
    await api('DELETE', `/v1/sandboxes/${box.id}`)
    await station.waitFor(() => !sandboxRow(box.id), 5000, 'the sandbox to be removed')
    assert.equal((await api('DELETE', `/v1/environments/${normal.id}`)).status, 200)

    const temp = await createEnvironment(h, 'alpha', 'temp', {
      ephemeral: true,
      ttl_seconds: 3600,
    })
    const mine = await createSandbox(h, temp.id, {
      name: 'temporary',
      start: false,
    })
    const snapshot = (await api('POST', `/v1/sandboxes/${mine.id}/snapshots`, {})).body
    const removed = await api('DELETE', `/v1/environments/${temp.id}`)
    assert.equal(removed.status, 200, removed.text)
    await station.waitFor(
      () =>
        !sandboxRow(mine.id) &&
        rows(h, 'select id from sandbox_snapshot where id = ?', snapshot.id).length === 0,
      5000,
      'sandbox and snapshot removal',
    )
    const gone = (await events('sandbox.deleted')).find((e) => e.payload.sandbox === mine.id)!
    assert.equal(gone.payload.reason, 'environment')
  })

  test('a station that still holds a sandbox cannot be removed', async () => {
    const reply = await api('DELETE', '/v1/stations/station-1')
    assert.equal(reply.status, 409)
    assert.equal(reply.body.error.code, 'DELETE_HAS_DEPENDENTS')
  })
})
