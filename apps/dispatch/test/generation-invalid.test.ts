import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { eq } from 'drizzle-orm'

import { newId } from '../src/db/ids.ts'
import { deployment, service } from '../src/db/schema.ts'
import { snapshotOf } from '../src/secrets/deploy.ts'

import { startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import type { FakeStation } from './helpers/fake-station.ts'
import { FakeRegistry } from './helpers/registry.ts'
import { createProject, createService, seedLockfile, waitForDeployment } from './helpers/seed.ts'

let h: Dispatch
let registry: FakeRegistry
let station: FakeStation
let environmentId: string

before(async () => {
  registry = FakeRegistry.install()
  registry.publish('nginx:1.27')
  h = await startDispatch()
  seedLockfile(h)
  station = await startFakeStation(h)
  environmentId = (await createProject(h)).default_environment_id
})

after(async () => {
  await h.close()
  registry.restore()
})

const plantQueuedDeployment = (serviceId: string, imageRef: string | null) => {
  const svc = h.db.select().from(service).where(eq(service.id, serviceId)).get()!
  const { id: _id, created_at: _c, updated_at: _u, ...config } = svc
  const id = newId('deployment')
  h.db
    .insert(deployment)
    .values({
      id,
      service_id: serviceId,
      number: 1,
      trigger: {
        type: 'manual',
        actor: {
          type: 'system',
          id: null,
          client: 'test',
        },
        source_sha: null,
        rollback_of: null,
      },
      image_ref: imageRef,
      env_snapshot: snapshotOf(h.db, serviceId) as never,
      config_snapshot: config as never,
      strategy: svc.strategy,
      base_images: [],
    })
    .run()
  return id
}

const failureOf = async (deploymentId: string) =>
  (
    await h.call('GET', `/v1/deployments/${deploymentId}/diagnosis`, {
      token: h.admin.token,
    })
  ).body

describe('an undeliverable deployment', () => {
  test('fails with GENERATION_INVALID naming the image_ref path and never reaches the station', async () => {
    const healthy = await createService(h, environmentId, {
      name: 'healthy',
      ref: 'nginx:1.27',
      ports: [
        {
          port: 80,
        },
      ],
      deploy: true,
    })
    await waitForDeployment(h, healthy.deployments[0].id, 'active')
    const broken = await createService(h, environmentId, {
      name: 'broken',
      ref: 'nginx:1.27',
      ports: [
        {
          port: 80,
        },
      ],
      deploy: false,
    })
    const planted = plantQueuedDeployment(broken.id, 'docker.io/library/nginx:1.27')
    h.deps.stations.reconcile(station.stationId)
    const failed = await waitForDeployment(h, planted, 'failed')
    assert.equal(failed.status, 'failed')
    const diagnosis = await failureOf(planted)
    assert.equal(diagnosis.code, 'GENERATION_INVALID')
    assert.equal(diagnosis.phase, 'preflight')
    assert.match(diagnosis.summary, /image_ref/)
    assert.equal(diagnosis.fixes[0].code, 'RESOLVE_IMAGE')
    await station.waitFor(() => station.generations.length > 0)
    for (const doc of station.generations) assert.equal(planted in doc.deployments, false)
  })

  test('the station keeps receiving every other change, and later deployments run', async () => {
    const before = station.generations.length
    const later = await createService(h, environmentId, {
      name: 'later',
      ref: 'nginx:1.27',
      ports: [
        {
          port: 80,
        },
      ],
      deploy: true,
    })
    const doc = await station.waitForGeneration((d) => later.id in d.services)
    assert.ok(station.generations.length > before)
    assert.equal(
      Object.values(doc.deployments).some((d) => d.service_id === later.id),
      true,
    )
    await waitForDeployment(h, later.deployments[0].id, 'active')
  })

  test('the failed deployment is not retried or resent on later generations', () => {
    const planted = h.db
      .select()
      .from(deployment)
      .all()
      .filter((d) => d.image_ref === 'docker.io/library/nginx:1.27')
    assert.equal(planted.length, 1)
    assert.equal(planted[0]!.status, 'failed')
    const last = station.generations.at(-1)!
    assert.equal(planted[0]!.id in last.deployments, false)
  })

  test('a container spec that fails its schema elsewhere than image_ref fails with a configuration fix', async () => {
    const svc = await createService(h, environmentId, {
      name: 'bad-limits',
      ref: 'nginx:1.27',
      ports: [
        {
          port: 80,
        },
      ],
      deploy: false,
    })
    const row = h.db.select().from(service).where(eq(service.id, svc.id)).get()!
    h.db
      .update(service)
      .set({
        limits: {
          cpu_millis: -5,
          memory_bytes: row.limits.memory_bytes,
        },
      })
      .where(eq(service.id, svc.id))
      .run()
    const planted = plantQueuedDeployment(
      svc.id,
      `docker.io/library/nginx@${registry.publish('nginx:1.27')}`,
    )
    h.deps.stations.reconcile(station.stationId)
    await waitForDeployment(h, planted, 'failed')
    const diagnosis = await failureOf(planted)
    assert.equal(diagnosis.code, 'GENERATION_INVALID')
    assert.equal(diagnosis.fixes[0].code, 'FIX_CONFIGURATION')
  })
})
