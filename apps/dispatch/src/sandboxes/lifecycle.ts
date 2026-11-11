import type { Static } from '@sinclair/typebox'
import { and, count, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm'

import { runActiveStatuses, type Actor, type MessageBody, type Observed } from '@stationly/protocol'

import type { Db } from '../db/client.ts'
import { run, sandbox, sandbox_snapshot, secret_value, station, variable } from '../db/schema.ts'
import { readSetting } from '../db/settings.ts'
import type { Log } from '../log.ts'
import { every } from '../schedule.ts'
import { emitEvent } from '../station/events.ts'

import { revokeWorkspaceToken } from './workspace.ts'

type ActorValue = Static<typeof Actor>
type SandboxRow = typeof sandbox.$inferSelect

export const systemActor: ActorValue = {
  type: 'system',
  id: null,
  client: 'dispatch/sandboxes',
}

export const expiringLeadS = 86400

export const sandboxSubject = (row: Pick<SandboxRow, 'id' | 'project_id' | 'environment_id'>) => ({
  entity: 'sandbox',
  id: row.id,
  sandbox_id: row.id,
  project_id: row.project_id,
  environment_id: row.environment_id,
})

export const retentionSeconds = (db: Db) => readSetting(db, 'sandbox.stopped_retention_s')

export const deleteAt = (
  row: Pick<SandboxRow, 'status' | 'stopped_at' | 'workspace'>,
  retention: number,
) =>
  row.status === 'stopped' && retention > 0 && row.stopped_at && !row.workspace
    ? new Date(row.stopped_at.getTime() + retention * 1000)
    : null

export const snapshotsKept = (db: Db, sandboxId: string) =>
  db
    .select({
      n: count(),
    })
    .from(sandbox_snapshot)
    .where(and(eq(sandbox_snapshot.sandbox_id, sandboxId), ne(sandbox_snapshot.status, 'deleting')))
    .get()?.n ?? 0

const dropVariables = (db: Db, sandboxId: string) => {
  const ids = db
    .select({
      id: variable.id,
    })
    .from(variable)
    .where(eq(variable.sandbox_id, sandboxId))
    .all()
    .map((v) => v.id)

  if (!ids.length) {
    return
  }

  db.delete(secret_value).where(inArray(secret_value.variable_id, ids)).run()
  db.delete(variable).where(inArray(variable.id, ids)).run()
}

const endRuns = (db: Db, sandboxId: string) =>
  db
    .update(run)
    .set({
      status: 'cancelled',
      finished_at: new Date(),
    })
    .where(and(eq(run.sandbox_id, sandboxId), inArray(run.status, [...runActiveStatuses])))
    .run()

export const requestDeletion = (
  db: Db,
  row: SandboxRow,
  by: { actor: ActorValue; reason: 'user' | 'retention' | 'environment' },
) => {
  if (row.status === 'deleting') {
    return snapshotsKept(db, row.id)
  }

  db.transaction((tx) => {
    const tdb = tx as unknown as Db

    tdb
      .update(sandbox)
      .set({
        status: 'deleting',
        desired_state: 'stopped',
        stop_at: null,
        deletion: {
          actor: by.actor,
          reason: by.reason,
          requested_at: new Date().toISOString(),
        },
      })
      .where(eq(sandbox.id, row.id))
      .run()
    dropVariables(tdb, row.id)
    endRuns(tdb, row.id)
    revokeWorkspaceToken(tdb, row, by.actor)
  })

  return snapshotsKept(db, row.id)
}

export const removeSandbox = (db: Db, row: SandboxRow) => {
  const kept = snapshotsKept(db, row.id)

  db.transaction((tx) => {
    const tdb = tx as unknown as Db

    dropVariables(tdb, row.id)
    tdb.delete(sandbox).where(eq(sandbox.id, row.id)).run()
    emitEvent(tdb, 'sandbox.deleted', sandboxSubject(row), {
      sandbox: row.id,
      snapshots_kept: kept,
      actor: row.deletion?.actor ?? systemActor,
      reason: row.deletion?.reason ?? 'user',
    })
  })
}

const date = (value: string | null | undefined) => (value ? new Date(value) : null)

export const applyStatus = (db: Db, stationId: string, body: MessageBody<'sandbox.status'>) => {
  const row = db.select().from(sandbox).where(eq(sandbox.id, body.sandbox_id)).get()

  if (!row || row.station_id !== stationId) {
    return false
  }

  if (body.status === 'deleted') {
    if (row.status === 'deleting') {
      removeSandbox(db, row)
    }

    return true
  }

  if (row.status === 'deleting') {
    return false
  }

  const subject = sandboxSubject(row)
  const now = new Date()

  switch (body.status) {
    case 'creating':
    case 'starting':
    case 'stopping':
      db.update(sandbox)
        .set({
          status: body.status,
          status_reason: body.reason ?? row.status_reason,
        })
        .where(eq(sandbox.id, row.id))
        .run()

      return true

    case 'running': {
      db.update(sandbox)
        .set({
          status: 'running',
          status_reason: null,
          started_at: date(body.started_at) ?? row.started_at ?? now,
          stopped_at: null,
          exit_code: null,
          failure: null,
        })
        .where(eq(sandbox.id, row.id))
        .run()

      if (row.status !== 'running') {
        const reason =
          body.reason === 'station_restart' ? 'station_restart' : row.started_at ? 'user' : 'create'

        emitEvent(db, 'sandbox.started', subject, {
          sandbox: row.id,
          environment: row.environment_id,
          station: row.station_id,
          reason,
          forked_from: row.forked_from,
          stop_at: row.stop_at?.toISOString() ?? null,
        })
      }

      return true
    }

    case 'stopped': {
      const reason = body.reason ?? 'user'
      const ended = reason === 'ttl' || reason === 'exited' || reason === 'oom'
      const stoppedAt = date(body.stopped_at) ?? now

      db.update(sandbox)
        .set({
          status: 'stopped',
          status_reason: reason,
          exit_code: body.exit_code,
          stopped_at: stoppedAt,
          address: null,
          ...(ended
            ? {
                desired_state: 'stopped' as const,
                stop_at: null,
              }
            : {}),
        })
        .where(eq(sandbox.id, row.id))
        .run()
      endRuns(db, row.id)

      if (row.status !== 'stopped') {
        emitEvent(db, 'sandbox.stopped', subject, {
          sandbox: row.id,
          reason,
          exit_code: body.exit_code,
          ran_for_s: row.started_at
            ? Math.max(0, Math.round((stoppedAt.getTime() - row.started_at.getTime()) / 1000))
            : 0,
        })
      }

      return true
    }

    case 'failed': {
      db.update(sandbox)
        .set({
          status: 'failed',
          status_reason: null,
          failure: body.failure,
          exit_code: body.exit_code,
          desired_state: 'stopped',
          stop_at: null,
          address: null,
        })
        .where(eq(sandbox.id, row.id))
        .run()
      endRuns(db, row.id)

      if (row.status !== 'failed') {
        emitEvent(db, 'sandbox.failed', subject, {
          sandbox: row.id,
          phase: body.failure?.phase ?? 'start',
          code: body.failure?.code ?? 'SANDBOX_START_FAILED',
          summary: body.failure?.summary ?? 'the station reported the sandbox failed',
        })
      }

      return true
    }
  }
}

export const applySnapshotStatus = (
  db: Db,
  stationId: string,
  body: MessageBody<'sandbox.snapshot.status'>,
) => {
  const row = db
    .select()
    .from(sandbox_snapshot)
    .where(eq(sandbox_snapshot.id, body.snapshot_id))
    .get()

  if (!row || row.station_id !== stationId) {
    return false
  }

  if (body.status === 'deleted') {
    db.delete(sandbox_snapshot).where(eq(sandbox_snapshot.id, row.id)).run()

    return true
  }

  if (row.status === 'deleting') {
    return false
  }

  db.update(sandbox_snapshot)
    .set({
      status: body.status,
      taken_at: date(body.taken_at) ?? row.taken_at,
      exclusive_bytes: body.exclusive_bytes,
      referenced_bytes: body.referenced_bytes,
      failure: body.failure,
    })
    .where(eq(sandbox_snapshot.id, row.id))
    .run()

  return true
}

export const ingestObservedSandboxes = (db: Db, stationId: string, observed: Observed) => {
  const capabilities = observed.station.capabilities
  const st = db
    .select({
      capabilities: station.capabilities,
    })
    .from(station)
    .where(eq(station.id, stationId))
    .get()

  if (st && JSON.stringify(st.capabilities) !== JSON.stringify(capabilities)) {
    db.update(station)
      .set({
        capabilities,
      })
      .where(eq(station.id, stationId))
      .run()
  }

  for (const [id, seen] of Object.entries(observed.sandboxes ?? {})) {
    const row = db.select().from(sandbox).where(eq(sandbox.id, id)).get()

    if (!row || row.station_id !== stationId || row.status === 'deleting') {
      continue
    }

    const address = seen.status === 'running' ? seen.address : null

    if (row.address !== address || row.disk_used_bytes !== seen.disk.referenced_bytes) {
      db.update(sandbox)
        .set({
          address,
          disk_used_bytes: seen.disk.referenced_bytes,
        })
        .where(eq(sandbox.id, id))
        .run()
    }
  }

  for (const [id, seen] of Object.entries(observed.sandbox_snapshots ?? {})) {
    const row = db.select().from(sandbox_snapshot).where(eq(sandbox_snapshot.id, id)).get()

    if (!row || row.station_id !== stationId) {
      continue
    }

    if (
      row.referenced_bytes !== seen.referenced_bytes ||
      row.exclusive_bytes !== seen.exclusive_bytes
    ) {
      db.update(sandbox_snapshot)
        .set({
          referenced_bytes: seen.referenced_bytes,
          exclusive_bytes: seen.exclusive_bytes,
        })
        .where(eq(sandbox_snapshot.id, id))
        .run()
    }
  }
}

export type RetentionDeps = { db: Db; stations: { reconcile(stationId?: string): void } }

export const runRetention = (deps: RetentionDeps, now = new Date()) => {
  const { db } = deps
  const retention = retentionSeconds(db)
  const result = {
    deleted: [] as string[],
    expiring: [] as string[],
  }

  if (retention === 0) {
    return result
  }

  const touched = new Set<string>()

  for (const row of db
    .select()
    .from(sandbox)
    .where(
      and(eq(sandbox.status, 'stopped'), isNotNull(sandbox.stopped_at), isNull(sandbox.workspace)),
    )
    .all()) {
    const at = deleteAt(row, retention)!

    if (now.getTime() >= at.getTime()) {
      requestDeletion(db, row, {
        actor: systemActor,
        reason: 'retention',
      })
      result.deleted.push(row.id)
      touched.add(row.station_id)
    } else if (
      now.getTime() >= at.getTime() - expiringLeadS * 1000 &&
      (!row.expiring_notified_at || row.expiring_notified_at.getTime() < row.stopped_at!.getTime())
    ) {
      emitEvent(db, 'sandbox.expiring', sandboxSubject(row), {
        sandbox: row.id,
        delete_at: at.toISOString(),
      })
      db.update(sandbox)
        .set({
          expiring_notified_at: now,
        })
        .where(eq(sandbox.id, row.id))
        .run()
      result.expiring.push(row.id)
    }
  }

  for (const id of touched) {
    deps.stations.reconcile(id)
  }

  return result
}

export const startSandboxRetention = (deps: RetentionDeps, log: Log) =>
  every(60, 'sandbox.retention_failed', log, () => {
    const result = runRetention(deps)

    if (result.deleted.length || result.expiring.length) {
      log('sandbox.retention', result)
    }
  })
