import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { Value } from '@sinclair/typebox/value'
import { eq } from 'drizzle-orm'

import { Generation } from '@stationly/protocol'
import { releaseRepositories } from '@stationly/protocol/release-config'

import { sandbox } from '../src/db/schema.ts'

import { startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import type { FakeStation } from './helpers/fake-station.ts'
import { FakeRegistry } from './helpers/registry.ts'
import {
  createEnvironment,
  createProject,
  createSandbox,
  createService,
  pinPlatform,
  rows,
  toolchainImageDigest,
  waitForSandbox,
} from './helpers/seed.ts'

let h: Dispatch
let registry: FakeRegistry
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
  registry = FakeRegistry.install()
  registry.publish('nginx:1.27')
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
})

after(async () => {
  await h.close()
  registry.restore()
})

describe('what a generation holds for sandboxes', () => {
  test('a station that reports no sandbox capability gets no sandbox keys at all', async () => {
    const plain = await startFakeStation(h, 'station-plain')
    const doc = await plain.waitForGeneration()
    assert.equal(doc.sandboxes, undefined)
    assert.equal(doc.sandbox_snapshots, undefined)
    assert.equal(doc.station.sandbox_network, undefined)
  })

  test('an isolated sandbox with Docker and an allowlist carries every field of the Sandbox object, and the station gets its sandbox network', async () => {
    const box = await createSandbox(h, envId, {
      name: 'full',
      docker: true,
      command: ['sleep', 'infinity'],
      size: {
        cpu_millis: 4000,
        memory_bytes: 8589934592,
        disk_bytes: 42949672960,
      },
      ttl_s: 7200,
      egress: {
        mode: 'allowlist',
        domains: [
          {
            domain: 'github.com',
            ports: [443, 22],
          },
          {
            domain: 'githubusercontent.com',
            wildcard: true,
          },
        ],
      },
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
        disk: entry.disk,
        reach: entry.reach,
      },
      {
        environment_id: envId,
        project_id: project.id,
        name: 'full',
        status: 'active',
        desired_state: 'running',
        command: ['sleep', 'infinity'],
        size: {
          cpu_millis: 4000,
          memory_bytes: 8589934592,
          disk_bytes: 42949672960,
        },
        docker: true,
        network: 'isolated',
        egress: {
          mode: 'allowlist',
          domains: [
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
          ],
        },
        disk: {
          from: null,
        },
        reach: [],
      },
    )
    assert.deepEqual(entry.image, {
      ref: null,
      digest: toolchainImageDigest,
      image_ref: `${releaseRepositories.sandbox_toolchain}@${toolchainImageDigest}`,
    })
    assert.match(entry.env_digest, /^sha256:[0-9a-f]{64}$/)
    const left = Date.parse(entry.stop_at) - Date.now()
    assert.ok(left > 7190_000 && left <= 7200_000)
    const net = doc.station.sandbox_network!
    assert.equal(net.bridge_name, 'sly-sandbox')
    assert.match(net.subnet, /^10\.200\.\d+\.0\/24$/)
    assert.equal(net.gateway, net.subnet.replace('.0/24', '.1'))
    const taken = new Set(Object.values(doc.environments).map((e) => e.network.subnet))
    assert.ok(!taken.has(net.subnet))
    assert.deepEqual(doc.sandbox_snapshots, {})
    assert.equal(Value.Check(Generation, doc), true)
    assert.equal(
      rows<{ sandbox_subnet: string }>(
        h,
        'select sandbox_subnet from station where name = ?',
        'station-1',
      )[0]!.sandbox_subnet,
      net.subnet,
    )
  })

  test('a sandbox that joins the environment brings the environment and its virtual IPs into the generation', async () => {
    const env = await createEnvironment(h, 'alpha', 'joined')
    const web = await createService(h, env.id, {
      name: 'web',
      ref: 'nginx:1.27',
      ports: [
        {
          port: 80,
        },
      ],
      extra: {
        station_id: station.stationId,
      },
    })
    const box = await createSandbox(h, env.id, {
      name: 'joiner',
      network: 'environment',
      start: false,
    })
    const doc = await station.waitForGeneration(
      (d) => d.sandboxes?.[box.id] !== undefined && d.environments[env.id] !== undefined,
    )
    const entry = doc.sandboxes![box.id] as any
    assert.equal(entry.network, 'environment')
    const vips = rows<{ id: string }>(
      h,
      'select id from virtual_ip where environment_id = ? and service_id = ?',
      env.id,
      web.id,
    )
    assert.deepEqual(
      entry.reach,
      vips.map((v) => v.id),
    )
    assert.ok((doc.environments[env.id] as any).network.subnet)
    assert.equal(entry.desired_state, 'stopped')
    assert.equal(entry.stop_at, null)
    const network = (await api('GET', `/v1/environments/${env.id}/network`)).body
    assert.deepEqual(
      network.sandboxes.map((s: any) => [s.id, s.name, s.status, s.egress.mode]),
      [[box.id, 'joiner', 'stopped', 'open']],
    )
    assert.ok(
      network.paths.some((p: any) => p.path === 'sandbox_inbound' && p.verdict === 'blocked'),
    )
    assert.ok(!network.paths.some((p: any) => p.path === 'domain_not_allowed'))
    await api('PATCH', `/v1/sandboxes/${box.id}`, {
      egress: {
        mode: 'allowlist',
        domains: [
          {
            domain: 'example.com',
          },
        ],
      },
    })
    const withList = (await api('GET', `/v1/environments/${env.id}/network`)).body
    assert.ok(withList.paths.some((p: any) => p.path === 'domain_not_allowed'))
    const isolatedElsewhere = (await api('GET', `/v1/environments/${envId}/network`)).body
    assert.deepEqual(isolatedElsewhere.sandboxes, [])
  })

  test('a custom image is pinned by digest as a registry reference', async () => {
    const box = await createSandbox(h, envId, {
      name: 'pinned',
      image: {
        ref: 'alpine:3.20',
      },
      start: false,
    })
    const doc = await station.waitForGeneration((d) => d.sandboxes?.[box.id] !== undefined)
    const image = (doc.sandboxes![box.id] as any).image
    assert.equal(image.ref, 'alpine:3.20')
    assert.equal(image.digest, box.image.digest)
    assert.equal(image.image_ref, `docker.io/library/alpine@${box.image.digest}`)
  })

  test('stop_at, desired_state and a changed ttl_s follow the row from one generation to the next', async () => {
    const box = await createSandbox(h, envId, {
      name: 'moving',
      ttl_s: 600,
    })
    await waitForSandbox(h, box.id, 'running')
    const before = (await station.waitForGeneration((d) => d.sandboxes?.[box.id] !== undefined))
      .sandboxes![box.id] as any
    await api('PATCH', `/v1/sandboxes/${box.id}`, {
      ttl_s: 7200,
    })
    const extended = (
      await station.waitForGeneration(
        (d) =>
          d.sandboxes?.[box.id] !== undefined &&
          (d.sandboxes[box.id] as any).stop_at !== before.stop_at,
      )
    ).sandboxes![box.id] as any
    assert.ok(Date.parse(extended.stop_at) - Date.parse(before.stop_at) > 6000_000)
    assert.notEqual(extended.hash, before.hash)
    await api('POST', `/v1/sandboxes/${box.id}/stop`)
    const stopped = (
      await station.waitForGeneration(
        (d) => (d.sandboxes?.[box.id] as any)?.desired_state === 'stopped',
      )
    ).sandboxes![box.id] as any
    assert.equal(stopped.stop_at, null)
    assert.equal(stopped.status, 'active')
  })

  test('a deleted sandbox is sent with status destroy and leaves the generation once the station reports it deleted', async () => {
    const box = await createSandbox(h, envId, {
      name: 'vanishing',
      start: false,
    })
    await station.waitForGeneration((d) => d.sandboxes?.[box.id] !== undefined)
    await api('DELETE', `/v1/sandboxes/${box.id}`)
    const destroyedDoc = await station.waitForGeneration(
      (d) => (d.sandboxes?.[box.id] as any)?.status === 'destroy',
    )
    const destroyed = destroyedDoc.sandboxes![box.id] as any
    assert.equal(destroyed.desired_state, 'stopped')
    assert.equal(destroyed.stop_at, null)
    await station.waitFor(
      () => rows(h, 'select id from sandbox where id = ?', box.id).length === 0,
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

  test('snapshots are sent active, then destroy, then dropped', async () => {
    const box = await createSandbox(h, envId, {
      name: 'snapped',
      start: false,
    })
    const snapshot = (await api('POST', `/v1/sandboxes/${box.id}/snapshots`, {})).body
    const active = (
      await station.waitForGeneration((d) => d.sandbox_snapshots?.[snapshot.id] !== undefined)
    ).sandbox_snapshots![snapshot.id] as any
    assert.deepEqual([active.sandbox_id, active.status], [box.id, 'active'])
    assert.match(active.hash, /^sha256:/)
    await api('DELETE', `/v1/sandbox-snapshots/${snapshot.id}`)
    const gone = await station.waitForGeneration(
      (d) => (d.sandbox_snapshots?.[snapshot.id] as any)?.status === 'destroy',
    )
    assert.equal((gone.sandbox_snapshots![snapshot.id] as any).status, 'destroy')
    await station.waitFor(
      () => rows(h, 'select id from sandbox_snapshot where id = ?', snapshot.id).length === 0,
      5000,
      'the snapshot row to be removed',
    )
  })

  test('a sandbox whose object does not match the schema keeps its last applied version and raises a generation finding', async () => {
    const box = await createSandbox(h, envId, {
      name: 'invalid-later',
    })
    const good = (await station.waitForGeneration((d) => d.sandboxes?.[box.id] !== undefined))
      .sandboxes![box.id] as any
    const row = h.db.select().from(sandbox).where(eq(sandbox.id, box.id)).get()!
    h.db
      .update(sandbox)
      .set({
        image: {
          ref: null,
          digest: 'sha256:short',
        },
        ttl_s: 1,
      })
      .where(eq(sandbox.id, box.id))
      .run()
    h.deps.stations.reconcile()
    await new Promise((resolve) => setTimeout(resolve, 300))
    const findings = (
      (await api('GET', '/v1/events?types=doctor.finding&limit=100')).body.items as any[]
    ).filter((e) => e.payload.check === 'generation')
    assert.ok(
      findings.some((f) => String(f.payload.detail).includes(box.id)),
      'a generation finding names the sandbox',
    )
    assert.equal((latest().sandboxes![box.id] as any).hash, good.hash)
    h.db
      .update(sandbox)
      .set({
        image: row.image,
        ttl_s: row.ttl_s,
      })
      .where(eq(sandbox.id, box.id))
      .run()
  })

  test('every generation the station received is a valid Generation', () => {
    for (const doc of station.generations)
      assert.equal(Value.Check(Generation, doc), true, `generation ${doc.number}`)
  })
})
