import { and, eq, isNull } from 'drizzle-orm'

import {
  deploymentTerminalStatuses,
  type MessageBody,
  type OutboxedMessageType,
} from '@stationly/protocol'

import { refreshStale } from '../api/stale.ts'
import { recordAudit } from '../db/audit.ts'
import type { Db } from '../db/client.ts'
import {
  attestation,
  build,
  component,
  deployment,
  deployment_step,
  run,
  service,
  station,
  station_outbox,
} from '../db/schema.ts'
import { isPinned } from '../platform/image-source.ts'
import { effectivePins } from '../platform/lockfile.ts'
import { upgradeOnComponent } from '../platform/upgrade.ts'
import { applySnapshotStatus, applyStatus } from '../sandboxes/lifecycle.ts'
import { activateDeployment } from '../secrets/deploy.ts'
import type { Keyring } from '../secrets/keyring.ts'
import { recordBackupResult, recordRestoreResult } from '../volumes/backups.ts'

import { emitEvent, serviceSubject } from './events.ts'
import { setServiceStatus } from './signal.ts'

export type IngestResult = { status: 'applied' | 'duplicate'; seq: number; reconcile: boolean }

const terminalDeployment = new Set<string>(deploymentTerminalStatuses)

const stepStatus: Record<string, (typeof deployment.$inferSelect)['status']> = {
  pull: 'starting',
  pre_deploy: 'pre_deploy',
  namespace: 'starting',
  baseline: 'starting',
  guard: 'starting',
  service: 'starting',
  health: 'waiting_health',
  cutover: 'cutover',
  drain: 'draining',
  cleanup: 'draining',
}

const date = (value: string | null | undefined) => (value ? new Date(value) : null)

type RunStatus = (typeof run.$inferInsert)['status']

export const failedPayload = (
  deploymentId: string,
  number: number,
  failure: { phase?: string; code?: string; summary?: string } | null | undefined,
) => ({
  deployment: deploymentId,
  number,
  summary: failure?.summary ?? null,
  phase: failure?.phase ?? null,
  code: failure?.code ?? null,
  diagnosis_url: `/v1/deployments/${deploymentId}/diagnosis`,
})

export const deploymentSubject = (db: Db, deploymentId: string) => {
  const dep = db
    .select({
      service_id: deployment.service_id,
    })
    .from(deployment)
    .where(eq(deployment.id, deploymentId))
    .get()

  return dep
    ? {
        ...serviceSubject(db, dep.service_id),
        entity: 'deployment',
        id: deploymentId,
        service_id: dep.service_id,
      }
    : {
        entity: 'deployment',
        id: deploymentId,
      }
}

const terminalBuild = new Set<string>(['succeeded', 'failed', 'cancelled'])

export const emitBuildFinished = (
  db: Db,
  buildId: string,
  deploymentId: string,
  status: 'succeeded' | 'failed' | 'cancelled',
  durationS: number | null,
  code: string | null,
) => {
  const subject = deploymentSubject(db, deploymentId)

  emitEvent(
    db,
    'build.finished',
    {
      ...subject,
      entity: 'build',
      id: buildId,
    },
    {
      build: buildId,
      deployment: deploymentId,
      service: 'service_id' in subject ? subject.service_id : null,
      status,
      duration_s: durationS,
      code,
    },
  )
}

const effects: {
  [T in OutboxedMessageType]?: (
    db: Db,
    keyring: Keyring,
    stationId: string,
    body: MessageBody<T>,
  ) => boolean
} = {
  'sandbox.status': (db, _k, stationId, body) => applyStatus(db, stationId, body),
  'sandbox.snapshot.status': (db, _k, stationId, body) => applySnapshotStatus(db, stationId, body),
  'volume.backup.result': (db, _k, stationId, body) => recordBackupResult(db, stationId, body),
  'volume.restore.result': (db, _k, stationId, body) => recordRestoreResult(db, stationId, body),
  'deployment.step': (db, _k, _s, body) => {
    const dep = db.select().from(deployment).where(eq(deployment.id, body.deployment_id)).get()

    if (!dep) {
      return false
    }

    const values = {
      status: body.status,
      detail: body.detail,
      started_at: date(body.started_at),
      finished_at: date(body.finished_at),
    }

    db.insert(deployment_step)
      .values({
        deployment_id: body.deployment_id,
        step: body.step,
        attempt: body.attempt,
        ...values,
      })
      .onConflictDoUpdate({
        target: [deployment_step.deployment_id, deployment_step.step, deployment_step.attempt],
        set: values,
      })
      .run()

    if (body.status !== 'running' || terminalDeployment.has(dep.status)) {
      return false
    }

    const next = stepStatus[body.step]

    if (!next || next === dep.status) {
      return false
    }

    db.update(deployment)
      .set({
        status: next,
        started_at: dep.started_at ?? date(body.started_at) ?? new Date(),
      })
      .where(eq(deployment.id, dep.id))
      .run()

    if (dep.status === 'queued' || dep.status === 'building') {
      const subject: { entity: string; id: string; environment_id?: string; project_id?: string } =
        deploymentSubject(db, dep.id)

      emitEvent(db, 'deployment.started', subject, {
        deployment: dep.id,
        number: dep.number,
        trigger: dep.trigger.type,
        service: dep.service_id,
        environment: subject.environment_id ?? null,
        project: subject.project_id ?? null,
      })
    }

    return false
  },
  'deployment.finished': (db, _k, _s, body) => {
    const dep = db.select().from(deployment).where(eq(deployment.id, body.deployment_id)).get()

    if (!dep || terminalDeployment.has(dep.status)) {
      return true
    }

    const subject = deploymentSubject(db, dep.id)

    if (body.status === 'active') {
      const previous = db
        .select({
          current: service.current_deployment_id,
        })
        .from(service)
        .where(eq(service.id, dep.service_id))
        .get()?.current

      activateDeployment(db, dep.id)

      if (previous && previous !== dep.id) {
        db.update(deployment)
          .set({
            status: 'superseded',
          })
          .where(eq(deployment.id, previous))
          .run()
      }

      refreshStale(db, [dep.service_id])
      const began = dep.started_at ?? dep.created_at

      emitEvent(db, 'deployment.active', subject, {
        deployment: dep.id,
        number: dep.number,
        duration_s: Math.round((Date.now() - began.getTime()) / 1000),
        previous_deployment: previous ?? null,
      })

      return true
    }

    db.update(deployment)
      .set({
        status: body.status,
        failure: body.failure,
        cancel_reason: body.cancel_reason,
        finished_at: new Date(),
      })
      .where(eq(deployment.id, dep.id))
      .run()

    if (body.status === 'failed') {
      emitEvent(db, 'deployment.failed', subject, failedPayload(dep.id, dep.number, body.failure))
    } else {
      emitEvent(db, 'deployment.cancelled', subject, {
        deployment: dep.id,
        number: dep.number,
        cancel_reason: body.cancel_reason,
        actor: null,
      })
    }

    return true
  },
  'run.created': (db, _k, _s, body) => {
    const r = body.run

    db.insert(run)
      .values({
        id: r.id,
        service_id: r.service_id,
        deployment_id: r.deployment_id,
        kind: r.kind,
        command: r.command,
        status: r.status as RunStatus,
        exit_code: r.exit_code,
        failure: r.failure,
        log_ref: r.log_ref,
        started_at: date(r.started_at),
        finished_at: date(r.finished_at),
      })
      .onConflictDoNothing()
      .run()

    return false
  },
  'run.status': (db, _k, _s, body) => {
    db.update(run)
      .set({
        status: body.status,
        exit_code: body.exit_code,
        failure: body.failure,
        started_at: date(body.started_at),
        finished_at: date(body.finished_at),
      })
      .where(eq(run.id, body.run_id))
      .run()

    return false
  },
  'run.exited': (db, _k, _s, body) => {
    db.update(run)
      .set({
        status: body.status,
        exit_code: body.exit_code,
        failure: body.failure,
        started_at: date(body.started_at),
        finished_at: date(body.finished_at),
      })
      .where(eq(run.id, body.run_id))
      .run()
    const full = db.select().from(run).where(eq(run.id, body.run_id)).get()

    if (body.status === 'failed' && full && full.sandbox_id === null) {
      emitEvent(
        db,
        'run.failed',
        full.service_id
          ? {
              ...serviceSubject(db, full.service_id),
              entity: 'run',
              id: body.run_id,
            }
          : {
              entity: 'run',
              id: body.run_id,
            },
        {
          run: body.run_id,
          kind: full.kind,
          exit_code: body.exit_code,
          service: full.service_id,
          deployment: full.deployment_id,
          code: body.failure?.code ?? null,
          summary: body.failure?.summary ?? null,
        },
      )
    }

    return false
  },
  'build.status': (db, _k, _s, body) => {
    const b = db.select().from(build).where(eq(build.id, body.build_id)).get()

    if (!b || b.status === 'succeeded' || b.status === 'failed' || b.status === 'cancelled') {
      return false
    }

    db.update(build)
      .set({
        status: body.status,
        detail: {
          ...b.detail,
          ...body.detail,
        },
      })
      .where(eq(build.id, b.id))
      .run()

    return false
  },
  'build.result': (db, _k, _s, body) => {
    const b = db.select().from(build).where(eq(build.id, body.build_id)).get()

    if (!b) {
      return false
    }

    db.update(build)
      .set({
        status: body.status,
        image_ref: body.image_ref,
        index_digest: body.index_digest,
        duration_s: body.duration_s,
        railpack_version: body.railpack_version,
        failure: body.failure,
      })
      .where(eq(build.id, b.id))
      .run()
    const finished =
      body.status === 'succeeded' || body.status === 'failed' || body.status === 'cancelled'

    if (finished && !terminalBuild.has(b.status)) {
      emitBuildFinished(
        db,
        b.id,
        b.deployment_id,
        body.status as 'succeeded' | 'failed' | 'cancelled',
        body.duration_s,
        body.status === 'succeeded'
          ? null
          : (body.failure?.code ?? (body.status === 'failed' ? 'BUILD_FAILED' : null)),
      )
    }

    for (const a of body.attestations) {
      db.insert(attestation)
        .values({
          build_id: b.id,
          kind: a.kind,
          platform: a.platform,
          digest: a.digest,
          predicate_ref: a.predicate_ref,
          base_images: a.base_images,
        })
        .run()
    }

    const dep = db.select().from(deployment).where(eq(deployment.id, b.deployment_id)).get()

    if (!dep || terminalDeployment.has(dep.status)) {
      return true
    }

    if (body.status === 'succeeded' && body.image_ref && isPinned(body.image_ref)) {
      db.update(deployment)
        .set({
          image_ref: body.image_ref,
          status: 'queued',
          base_images: body.base_images.map((bi) => ({
            ...bi,
            check: 'current' as const,
          })),
        })
        .where(eq(deployment.id, dep.id))
        .run()

      return true
    }

    const failure =
      body.status === 'succeeded'
        ? {
            phase: 'build' as const,
            code: 'BUILD_FAILED',
            summary: `build ${b.id} succeeded but reported image_ref ${body.image_ref ?? 'null'}, which is not a digest reference (<name>@sha256:<hex>), so nothing can be deployed from it.`,
          }
        : (body.failure ?? {
            phase: 'build' as const,
            code: 'BUILD_FAILED',
            summary: `build ${b.id} ended ${body.status}`,
          })

    db.update(deployment)
      .set({
        status: 'failed',
        failure,
        finished_at: new Date(),
      })
      .where(eq(deployment.id, dep.id))
      .run()
    emitEvent(
      db,
      'deployment.failed',
      deploymentSubject(db, dep.id),
      failedPayload(dep.id, dep.number, failure),
    )

    return true
  },
  'health.result': (db, _k, _s, body) => {
    const status = body.state === 'passing' ? 'green' : body.state === 'failed' ? 'red' : 'amber'

    setServiceStatus(db, body.service_id, status, {
      deployment_id: body.deployment_id,
      state: body.state,
      consecutive: body.consecutive,
      last_check: body.last_check,
    })

    return false
  },
  'disk.pressure': (db, _k, stationId, body) => {
    emitEvent(
      db,
      'disk.pressure',
      {
        entity: 'station',
        id: stationId,
      },
      body,
    )

    return false
  },
  'component.status': (db, _k, stationId, body) => {
    const name = body.name as (typeof component.$inferSelect)['name']
    const st = db
      .select({
        arch: station.arch,
      })
      .from(station)
      .where(eq(station.id, stationId))
      .get()
    const pin = effectivePins(db, st?.arch)[name]
    const values = {
      version: body.version,
      digest: body.digest,
      container_id: body.container_id,
      status: body.status,
      signature: body.signature,
      failure: body.failure,
      lockfile_version: pin?.version ?? body.lockfile_version,
      lockfile_digest: pin?.digest ?? null,
      since: new Date(body.since),
    }
    const scope =
      name === 'dispatch' ? isNull(component.station_id) : eq(component.station_id, stationId)
    const row = db
      .select()
      .from(component)
      .where(and(scope, eq(component.name, name)))
      .get()

    if (row) {
      db.update(component).set(values).where(eq(component.id, row.id)).run()
    } else {
      db.insert(component)
        .values({
          station_id: name === 'dispatch' ? null : stationId,
          name,
          ...values,
        })
        .run()
    }

    if (body.status === 'failed' && body.failure) {
      emitEvent(
        db,
        'doctor.finding',
        {
          entity: 'station',
          id: stationId,
        },
        {
          check: body.failure.code === 'UNSIGNED_ARTIFACT' ? 'signatures' : 'platform_upgrade',
          component: name,
          digest: body.digest,
          failure: body.failure,
        },
      )
    }

    return upgradeOnComponent(db, stationId, body)
  },
  'registry.maintenance': (db, _k, stationId, body) => {
    emitEvent(
      db,
      'registry.maintenance',
      {
        entity: 'station',
        id: stationId,
      },
      body,
    )

    return false
  },
  'audit.record': (db, _k, stationId, body) => {
    recordAudit(db, {
      actor: {
        ...body.actor,
        type: 'station',
        id: stationId,
      },
      action: body.action,
      target: body.target,
      requestId: `station:${stationId}:${body.seq}`,
      purpose: body.purpose,
    })

    return false
  },
}

export const ingest = (
  db: Db,
  keyring: Keyring,
  stationId: string,
  epoch: string,
  type: string,
  body: { seq: number },
): IngestResult =>
  db.transaction(() => {
    const row = db
      .select()
      .from(station_outbox)
      .where(and(eq(station_outbox.station_id, stationId), eq(station_outbox.epoch, epoch)))
      .get()
    const committed = row?.committed_seq ?? 0

    if (body.seq <= committed) {
      return {
        status: 'duplicate' as const,
        seq: body.seq,
        reconcile: false,
      }
    }

    const effect = effects[type as OutboxedMessageType] as
      ((db: Db, keyring: Keyring, stationId: string, body: unknown) => boolean) | undefined
    const reconcile = effect ? effect(db, keyring, stationId, body) : false

    if (row) {
      db.update(station_outbox)
        .set({
          committed_seq: body.seq,
        })
        .where(eq(station_outbox.id, row.id))
        .run()
    } else {
      db.insert(station_outbox)
        .values({
          station_id: stationId,
          epoch,
          committed_seq: body.seq,
        })
        .run()
    }

    return {
      status: 'applied' as const,
      seq: body.seq,
      reconcile,
    }
  })

export const committedSeq = (db: Db, stationId: string, epoch: string) =>
  db
    .select({
      committed: station_outbox.committed_seq,
    })
    .from(station_outbox)
    .where(and(eq(station_outbox.station_id, stationId), eq(station_outbox.epoch, epoch)))
    .get()?.committed ?? null
