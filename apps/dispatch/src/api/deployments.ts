import { and, desc, eq, inArray } from 'drizzle-orm'

import {
  deploymentInFlightStatuses,
  deploymentOpenStatuses,
  deploymentPastCutoverStatuses,
  type deploymentTriggerValues,
} from '@stationly/protocol'

import type { ActorValue } from '../auth/principal.ts'
import type { Db } from '../db/client.ts'
import { newId } from '../db/ids.ts'
import { blob, build, deployment, environment, service, station } from '../db/schema.ts'
import { targetIssue } from '../generation/build.ts'
import { isPinned, pinnedRef } from '../platform/image-source.ts'
import { snapshotOf } from '../secrets/deploy.ts'
import type { StationServer } from '../station/server.ts'

import { fail } from './errors.ts'

export type TriggerType = (typeof deploymentTriggerValues)[number]

export const deployableStationStatuses = new Set(['online', 'asleep'])

export const configFields = [
  'source',
  'station_id',
  'command',
  'build_args',
  'limits',
  'health',
  'strategy',
  'multi_writer_safe',
  'drain_timeout_s',
  'readonly_rootfs',
  'secrets_owner',
  'pre_deploy',
  'schedule',
] as const

const restoredColumns = configFields.filter((c) => c !== 'station_id')

type DeploymentRow = typeof deployment.$inferSelect
type ServiceRow = typeof service.$inferSelect
type Source = {
  type: string
  ref?: string
  digest?: string
  path?: string
  dockerfile?: string
  repo?: string
  branch?: string
  auth?: string
}

export const requireStationReady = (
  db: Db,
  stationId: string,
  options: { placement: boolean } = {
    placement: true,
  },
) => {
  const row = db.select().from(station).where(eq(station.id, stationId)).get()
  if (!row)
    return fail('VALIDATION_FAILED', `station ${stationId} does not exist.`, undefined, {
      issues: [
        {
          path: '/station_id',
          message: 'unknown station',
        },
      ],
    })
  if (row.draining && options.placement) {
    fail(
      'STATION_OFFLINE',
      `Station ${row.name} is draining, so no new deployments are placed on it.`,
      'Place the service on another station, or end the drain with sly stations update --no-draining.',
      {
        station_id: row.id,
        status: row.status,
        draining: true,
      },
    )
  }
  if (row.revoked_at || !deployableStationStatuses.has(row.status)) {
    fail(
      'STATION_OFFLINE',
      `Station ${row.name} is ${row.revoked_at ? 'removed' : row.status}, so nothing can be deployed to it.`,
      undefined,
      {
        station_id: row.id,
        status: row.status,
      },
    )
  }
  if (row.version_skew === 'unsupported')
    fail(
      'STATION_VERSION_SKEW',
      `Station ${row.name} runs a stationd outside the supported version window.`,
      'Upgrade stationd on the station.',
      {
        station_id: row.id,
      },
    )
  return row
}

export const requireLink = (stations: Pick<StationServer, 'isConnected'>, stationId: string) => {
  if (!stations.isConnected(stationId))
    fail('STATION_OFFLINE', `Station ${stationId} is not connected to Dispatch.`, undefined, {
      station_id: stationId,
    })
}

export const requireConnected = (
  deps: { db: Db; stations: Pick<StationServer, 'isConnected'> },
  stationId: string,
) => {
  requireStationReady(deps.db, stationId, {
    placement: false,
  })
  requireLink(deps.stations, stationId)
}

export const usableBlob = (db: Db, blobId: string, serviceId: string) => {
  const row = db.select().from(blob).where(eq(blob.id, blobId)).get()
  if (!row || row.kind !== 'push_tarball' || row.service_id !== serviceId) {
    return fail(
      'VALIDATION_FAILED',
      `blob ${blobId} is not a source upload for this service.`,
      'Upload the directory with POST /v1/blobs and the X-Stationly-Service header naming this service.',
      {
        issues: [
          {
            path: '/blob_id',
            message: 'unknown blob for this service',
          },
        ],
      },
    )
  }
  if (row.expires_at.getTime() <= Date.now())
    fail(
      'SOURCE_UNREACHABLE',
      `blob ${blobId} expired at ${row.expires_at.toISOString()}.`,
      'Run sly push again.',
      {
        blob_id: blobId,
      },
    )
  return row
}

const lastBuildBlob = (db: Db, serviceId: string) => {
  const rows = db
    .select({
      source: build.source,
    })
    .from(build)
    .innerJoin(deployment, eq(deployment.id, build.deployment_id))
    .where(eq(deployment.service_id, serviceId))
    .orderBy(desc(build.id))
    .limit(1)
    .all()
  return (rows[0]?.source as { blob_id?: string } | undefined)?.blob_id
}

export const configDeployTrigger = (
  svc: Pick<ServiceRow, 'current_deployment_id'>,
  source: { type?: unknown },
  sourceChanged = false,
  reuse: 'redeploy' | 'variable_change' = 'redeploy',
): 'manual' | 'redeploy' | 'variable_change' | null => {
  if (!svc.current_deployment_id) return source.type === 'local' ? null : 'manual'
  return sourceChanged ? 'manual' : reuse
}

const planBuild = (
  db: Db,
  svc: ServiceRow,
  input: { blob_id?: string | null; rebuild?: boolean; source_sha?: string | null },
) => {
  const source = svc.source as Source
  if (source.type === 'local') {
    const blobId = input.blob_id ?? (input.rebuild ? lastBuildBlob(db, svc.id) : undefined)
    if (!blobId)
      return fail(
        'SOURCE_UNREACHABLE',
        `${svc.name} has a local source and no uploaded directory to build.`,
        'Run sly push (push_local_source) to upload the directory and deploy it.',
      )
    usableBlob(db, blobId, svc.id)
    return {
      source: {
        type: 'blob',
        blob_id: blobId,
        path: source.path ?? '.',
        dockerfile: source.dockerfile ?? null,
      },
      builder: source.dockerfile ? ('dockerfile' as const) : ('railpack' as const),
    }
  }
  if (input.blob_id)
    fail(
      'VALIDATION_FAILED',
      'blob_id is accepted only for services with a local source.',
      undefined,
      {
        issues: [
          {
            path: '/blob_id',
            message: `source is ${source.type}`,
          },
        ],
      },
    )
  const env = db
    .select({
      pull_request: environment.pull_request,
    })
    .from(environment)
    .where(eq(environment.id, svc.environment_id))
    .get()
  const forkPr =
    env?.pull_request?.fork && env.pull_request.repo === source.repo ? env.pull_request : null
  return {
    source: {
      type: 'git',
      repo: source.repo,
      branch: source.branch,
      auth: source.auth ?? null,
      sha: forkPr ? (input.source_sha ?? forkPr.head_sha) : (input.source_sha ?? null),
      ref: forkPr ? `refs/pull/${forkPr.number}/head` : null,
      fork: Boolean(forkPr),
      path: source.path ?? '.',
      dockerfile: source.type === 'dockerfile' ? (source.dockerfile ?? 'Dockerfile') : null,
    },
    builder: source.type === 'dockerfile' ? ('dockerfile' as const) : ('railpack' as const),
  }
}

export type DeploymentInput = {
  service_id: string
  trigger: TriggerType
  actor: ActorValue
  supersede: boolean
  source_sha?: string | null
  image?: string | null
  blob_id?: string | null
  rebuild?: boolean
  pin_env?: boolean
  rollback_of?: string | null
}

export const createDeploymentRecord = (db: Db, input: DeploymentInput) => {
  const svc = db.select().from(service).where(eq(service.id, input.service_id)).get()
  if (!svc) return fail('NOT_FOUND', `service ${input.service_id} does not exist.`)
  requireStationReady(db, svc.station_id)
  const open = db
    .select()
    .from(deployment)
    .where(
      and(
        eq(deployment.service_id, svc.id),
        inArray(deployment.status, [...deploymentOpenStatuses]),
      ),
    )
    .all()
  const blocking = open.find(
    (d) =>
      (deploymentPastCutoverStatuses as readonly string[]).includes(d.status) ||
      (!input.supersede && (deploymentInFlightStatuses as readonly string[]).includes(d.status)),
  )
  if (blocking) {
    fail(
      'DEPLOY_IN_PROGRESS',
      `Deployment ${blocking.number} of ${svc.name} is ${blocking.status}.`,
      'Wait for it to finish, or send supersede = true while it is before cutover.',
      {
        deployment_id: blocking.id,
      },
    )
  }
  const current: DeploymentRow | undefined = svc.current_deployment_id
    ? db.select().from(deployment).where(eq(deployment.id, svc.current_deployment_id)).get()
    : undefined
  const target: DeploymentRow | undefined = input.rollback_of
    ? db.select().from(deployment).where(eq(deployment.id, input.rollback_of)).get()
    : undefined
  if (input.trigger === 'rollback' && (!target || !target.image_ref))
    fail('VALIDATION_FAILED', `deployment ${input.rollback_of} cannot be rolled back to.`)
  const source = svc.source as Source
  const reuse = input.trigger === 'redeploy' || input.trigger === 'variable_change'
  if (reuse && !current?.image_ref)
    fail(
      'NO_CURRENT_DEPLOYMENT',
      `${svc.name} has no current deployment to redeploy.`,
      'Call deploy (POST /v1/services/{service}/deployments) first.',
    )
  const needsBuild = input.trigger !== 'rollback' && !reuse && source.type !== 'image'
  const plannedBuild = needsBuild ? planBuild(db, svc, input) : null
  const env_snapshot = target
    ? target.env_snapshot
    : input.pin_env && current
      ? current.env_snapshot
      : snapshotOf(db, svc.id)
  const image_ref = target
    ? target.image_ref
    : reuse
      ? current!.image_ref
      : needsBuild
        ? null
        : (input.image ??
          (source.ref && source.digest ? pinnedRef(source.ref, source.digest) : null))
  if (!needsBuild && !isPinned(image_ref)) {
    fail(
      'SOURCE_UNREACHABLE',
      image_ref
        ? `${svc.name} would deploy ${image_ref}, which is not a digest reference.`
        : `${svc.name} has no resolved image digest to deploy.`,
      'Set the image source again (PATCH /v1/services/{service} with source) so Dispatch resolves the tag to its digest, then deploy.',
      {
        image_ref,
        source: svc.source,
      },
    )
  }
  const config_snapshot = target
    ? target.config_snapshot
    : (({ id: _i, created_at: _c, updated_at: _u, ...rest }) => rest)(svc)
  const problem = targetIssue(db, {
    service_id: svc.id,
    image_ref,
    config_snapshot,
    strategy: target
      ? ((target.config_snapshot.strategy as DeploymentRow['strategy']) ?? svc.strategy)
      : svc.strategy,
  })
  if (problem) {
    fail(
      'VALIDATION_FAILED',
      `${svc.name} cannot be deployed: its container spec fails at ${problem.path}: ${problem.message}.`,
      'Correct the service setting at that path, then deploy again.',
      {
        issues: [
          {
            path: problem.path,
            message: problem.message,
          },
        ],
      },
    )
  }
  const now = new Date()
  for (const old of open) {
    db.update(deployment)
      .set({
        status: 'cancelled',
        cancel_reason: 'superseded',
        finished_at: now,
      })
      .where(eq(deployment.id, old.id))
      .run()
  }
  if (target) {
    const restored = Object.fromEntries(
      restoredColumns
        .filter((c) => c in target.config_snapshot)
        .map((c) => [c, target.config_snapshot[c]]),
    )
    db.update(service).set(restored).where(eq(service.id, svc.id)).run()
  }
  const fresh = db.select().from(service).where(eq(service.id, svc.id)).get()!
  const last = db
    .select({
      number: deployment.number,
    })
    .from(deployment)
    .where(eq(deployment.service_id, svc.id))
    .orderBy(desc(deployment.number))
    .limit(1)
    .get()
  const id = newId('deployment')
  const { id: _id, created_at: _c, updated_at: _u, ...config } = fresh
  const buildId = plannedBuild ? newId('build') : null
  db.insert(deployment)
    .values({
      id,
      service_id: svc.id,
      number: (last?.number ?? 0) + 1,
      trigger: {
        type: input.trigger,
        actor: input.actor,
        source_sha:
          input.source_sha ??
          (plannedBuild?.source as { sha?: string | null } | undefined)?.sha ??
          null,
        rollback_of: target?.id ?? null,
      },
      image_ref,
      build_id: buildId,
      env_snapshot,
      config_snapshot: target ? target.config_snapshot : config,
      strategy: target
        ? ((target.config_snapshot.strategy as DeploymentRow['strategy']) ?? fresh.strategy)
        : fresh.strategy,
      base_images: target ? target.base_images : [],
    })
    .run()
  if (plannedBuild) {
    const env = db
      .select({
        project_id: environment.project_id,
      })
      .from(environment)
      .where(eq(environment.id, svc.environment_id))
      .get()!
    db.insert(build)
      .values({
        id: buildId!,
        deployment_id: id,
        project_id: env.project_id,
        source: plannedBuild.source,
        builder: plannedBuild.builder,
        cache_key: env.project_id,
        detail: {},
        log_ref: `logs/${svc.id}/${id}/build.log`,
      })
      .run()
  }
  if (fresh.desired_state === 'running' && fresh.status !== 'amber')
    db.update(service)
      .set({
        status: 'amber',
      })
      .where(eq(service.id, svc.id))
      .run()
  return {
    id,
    superseded: open.map((o) => o.id),
    build_id: buildId,
  }
}
