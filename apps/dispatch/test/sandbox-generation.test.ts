import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { Value } from '@sinclair/typebox/value'
import { eq } from 'drizzle-orm'

import { Generation, machineSizeDefaults, workspaceEgress } from '@stationly/protocol'
import { releaseRepositories } from '@stationly/protocol/release-config'

import { machine } from '../src/db/schema.ts'
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
  toolchainImageDigest,
  waitForMachine,
} from './helpers/seed.ts'

let h: Dispatch
let station: FakeStation
let envId: string
let project: any

const api = (method: string, path: string, body?: unknown) =>
  h.call(method, path, {
    token: h.admin.token,
    body,
  })

const latest = () => station.generations.at(-1)!

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
})

after(async () => {
  await h.close()
})

describe('what a generation holds for machines', () => {
  test('a station that reports no machine capability gets no machine entries at all', async () => {
    const plain = await startFakeStation(h, 'station-plain')
    const doc = await plain.waitForGeneration()

    assert.equal(doc.sandboxes, undefined)
    assert.equal(doc.station.sandbox_network, undefined)
  })

  test('a workspace machine carries every field of its entry, and the station gets its machine network', async () => {
    const box = await createMachine(h, envId, {
      name: 'full',
    })
    const doc = await station.waitForGeneration((d) => d.sandboxes?.[box.id] !== undefined)
    const entry = doc.sandboxes![box.id] as any

    assert.match(entry.hash, /^sha256:[0-9a-f]{64}$/)
    assert.deepEqual(
      {
        environment_id: entry.environment_id,
        project_id: entry.project_id,
        name: entry.name,
        status: entry.status,
        desired_state: entry.desired_state,
        command: entry.command,
        size: entry.size,
        docker: entry.docker,
        network: entry.network,
        egress: entry.egress,
        reach: entry.reach,
        api_relay: entry.api_relay,
      },
      {
        environment_id: envId,
        project_id: project.id,
        name: 'full',
        status: 'active',
        desired_state: 'running',
        command: null,
        size: box.size,
        docker: false,
        network: 'isolated',
        egress: box.egress,
        reach: [],
        api_relay: true,
      },
    )
    assert.equal(entry.size.cpu_millis, machineSizeDefaults.cpu_millis)
    assert.deepEqual(
      entry.egress.domains.map((d: { domain: string }) => d.domain),
      workspaceEgress('claude').domains.map((d) => d.domain),
    )
    assert.equal(entry.egress.mode, 'allowlist')
    assert.equal(entry.stop_at, null)
    assert.deepEqual(entry.image, {
      ref: null,
      digest: toolchainImageDigest,
      image_ref: `${releaseRepositories.sandbox_toolchain}@${toolchainImageDigest}`,
    })
    assert.match(entry.env_digest, /^sha256:[0-9a-f]{64}$/)
    const net = doc.station.sandbox_network!

    assert.equal(net.bridge_name, 'sly-sandbox')
    assert.match(net.subnet, /^10\.200\.\d+\.0\/24$/)
    assert.equal(net.gateway, net.subnet.replace('.0/24', '.1'))
    const taken = new Set(Object.values(doc.environments).map((e) => e.network.subnet))

    assert.ok(!taken.has(net.subnet))
    assert.equal(Value.Check(Generation, doc), true)
    assert.equal(
      rows<{ machine_subnet: string }>(
        h,
        'select machine_subnet from server where name = ?',
        'station-1',
      )[0]!.machine_subnet,
      net.subnet,
    )
  })

  test('desired_state and stop_at follow the row from one generation to the next', async () => {
    const box = await createMachine(h, envId, {
      name: 'moving',
    })

    await waitForMachine(h, box.id, 'running')
    const running = (await station.waitForGeneration((d) => d.sandboxes?.[box.id] !== undefined))
      .sandboxes![box.id] as any

    assert.equal(running.desired_state, 'running')
    stopMachine(h.db, machineRowOf(h, box.id))
    h.deps.stations.reconcile()
    const stopped = (
      await station.waitForGeneration(
        (d) => (d.sandboxes?.[box.id] as any)?.desired_state === 'stopped',
      )
    ).sandboxes![box.id] as any

    assert.equal(stopped.stop_at, null)
    assert.equal(stopped.status, 'active')
    assert.notEqual(stopped.hash, running.hash)
  })

  test('a deleted machine is sent with status destroy and leaves the generation once the station reports it deleted', async () => {
    const box = await createMachine(h, envId, {
      name: 'vanishing',
    })

    await station.waitForGeneration((d) => d.sandboxes?.[box.id] !== undefined)
    requestDeletion(h.db, machineRowOf(h, box.id), {
      actor: systemActor,
      reason: 'user',
    })
    h.deps.stations.reconcile()
    const destroyedDoc = await station.waitForGeneration(
      (d) => (d.sandboxes?.[box.id] as any)?.status === 'destroy',
    )
    const destroyed = destroyedDoc.sandboxes![box.id] as any

    assert.equal(destroyed.desired_state, 'stopped')
    assert.equal(destroyed.stop_at, null)
    await station.waitFor(
      () => rows(h, 'select id from machine where id = ?', box.id).length === 0,
      5000,
      'the row to be removed',
    )
    h.deps.stations.reconcile()
    await station.waitForGeneration(
      (d) =>
        d.sandboxes !== undefined &&
        d.sandboxes[box.id] === undefined &&
        d.number > destroyedDoc.number,
    )
  })

  test('a machine whose object does not match the schema keeps its last applied version and raises a generation finding', async () => {
    const box = await createMachine(h, envId, {
      name: 'invalid-later',
    })
    const good = (await station.waitForGeneration((d) => d.sandboxes?.[box.id] !== undefined))
      .sandboxes![box.id] as any
    const row = machineRowOf(h, box.id)

    h.db
      .update(machine)
      .set({
        image: {
          ref: null,
          digest: 'sha256:short',
        },
      })
      .where(eq(machine.id, box.id))
      .run()
    h.deps.stations.reconcile()
    await new Promise((resolve) => setTimeout(resolve, 300))
    const findings = (
      (await api('GET', '/v1/events?types=doctor.finding&limit=100')).body.items as any[]
    ).filter((e) => e.payload.check === 'generation')

    assert.ok(
      findings.some((f) => String(f.payload.detail).includes(box.id)),
      'a generation finding names the machine',
    )
    assert.equal((latest().sandboxes![box.id] as any).hash, good.hash)
    h.db
      .update(machine)
      .set({
        image: row.image,
      })
      .where(eq(machine.id, box.id))
      .run()
  })

  test('every generation the station received is a valid Generation', () => {
    for (const doc of station.generations) {
      assert.equal(Value.Check(Generation, doc), true, `generation ${doc.number}`)
    }
  })
})
