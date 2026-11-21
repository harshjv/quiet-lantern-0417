import type { Static } from '@sinclair/typebox'
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm'

import { runActiveStatuses, type Actor, type MessageBody, type Observed } from '@stationly/protocol'

import type { Principal } from '../auth/principal.ts'
import type { Db } from '../db/client.ts'
import { environment_variable, machine, run, secret_value, server } from '../db/schema.ts'
import { readSetting } from '../db/settings.ts'
import type { Log } from '../log.ts'
import { every } from '../schedule.ts'
import { emitEvent } from '../station/events.ts'
import { stopMachineTasks } from '../tasks/machine.ts'

import { requireQuota } from './limits.ts'
import { machineSubject } from './subject.ts'
import { revokeWorkspaceToken } from './workspace.ts'

type ActorValue = Static<typeof Actor>
type MachineRow = typeof machine.$inferSelect

export const systemActor: ActorValue = {
  type: 'system',
  id: null,
  client: 'dispatch/machines',
}

export const expiringLeadS = 86400

type StationRow = typeof server.$inferSelect

export const stopAtFrom = (ttl: number | null) =>
  ttl === null ? null : new Date(Date.now() + ttl * 1000)

export const startMachine = (
  db: Db,
  st: StationRow,
  principal: Principal,
  row: MachineRow,
  ttl_s: number | null,
) => {
  requireQuota(
    db,
    st,
    {
      machineId: row.id,
      newMachine: false,
      running: true,
      memoryBytes: row.size.memory_bytes,
    },
    principal,
  )
  db.update(machine)
    .set({
      ttl_s,
      desired_state: 'running',
      stop_at: stopAtFrom(ttl_s),
      status: 'starting',
      status_reason: null,
      failure: null,
      exit_code: null,
      expiring_notified_at: null,
    })
    .where(eq(machine.id, row.id))
    .run()
}

export const stopMachine = (db: Db, row: MachineRow, reason: 'idle' | null = null) => {
  if (row.status === 'stopped' || row.status === 'failed') {
    return
  }

  db.update(machine)
    .set({
      desired_state: 'stopped',
      stop_at: null,
      status: 'stopping',
      ...(reason
        ? {
            status_reason: reason,
          }
        : {}),
    })
    .where(eq(machine.id, row.id))
    .run()
}

export const retentionSeconds = (db: Db) => readSetting(db, 'machine.stopped_retention_s')

export const deleteAt = (
  row: Pick<MachineRow, 'status' | 'stopped_at' | 'workspace'>,
  retention: number,
) =>
  row.status === 'stopped' && retention > 0 && row.stopped_at && !row.workspace
    ? new Date(row.stopped_at.getTime() + retention * 1000)
    : null

const dropVariables = (db: Db, machineId: string) => {
  const ids = db
    .select({
      id: environment_variable.id,
    })
    .from(environment_variable)
    .where(eq(environment_variable.machine_id, machineId))
    .all()
    .map((v) => v.id)

  if (!ids.length) {
    return
  }

  db.delete(secret_value).where(inArray(secret_value.environment_variable_id, ids)).run()
  db.delete(environment_variable).where(inArray(environment_variable.id, ids)).run()
}

const endRuns = (db: Db, machineId: string) =>
  db
    .update(run)
    .set({
      status: 'cancelled',
      finished_at: new Date(),
    })
    .where(and(eq(run.machine_id, machineId), inArray(run.status, [...runActiveStatuses])))
    .run()

export const requestDeletion = (
  db: Db,
  row: MachineRow,
  by: { actor: ActorValue; reason: 'user' | 'retention' | 'preview' },
) => {
  if (row.status === 'deleting') {
    return
  }

  db.transaction((tx) => {
    const tdb = tx as unknown as Db

    tdb
      .update(machine)
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
      .where(eq(machine.id, row.id))
      .run()
    dropVariables(tdb, row.id)
    endRuns(tdb, row.id)
    revokeWorkspaceToken(tdb, row, by.actor)
  })
}

export const removeMachine = (db: Db, row: MachineRow) => {
  db.transaction((tx) => {
    const tdb = tx as unknown as Db

    dropVariables(tdb, row.id)
    stopMachineTasks(tdb, row.id, new Date())
    tdb.delete(machine).where(eq(machine.id, row.id)).run()
    emitEvent(tdb, 'machine.deleted', machineSubject(row), {
      machine: row.id,
      actor: row.deletion?.actor ?? systemActor,
      reason: row.deletion?.reason ?? 'user',
    })
  })
}

const date = (value: string | null | undefined) => (value ? new Date(value) : null)

export const applyStatus = (db: Db, stationId: string, body: MessageBody<'sandbox.status'>) => {
  const row = db.select().from(machine).where(eq(machine.id, body.sandbox_id)).get()

  if (!row || row.server_id !== stationId) {
    return false
  }

  if (body.status === 'deleted') {
    if (row.status === 'deleting') {
      removeMachine(db, row)
    }

    return true
  }

  if (row.status === 'deleting') {
    return false
  }

  const subject = machineSubject(row)
  const now = new Date()

  switch (body.status) {
    case 'creating':
    case 'starting':
    case 'stopping':
      db.update(machine)
        .set({
          status: body.status,
          status_reason: body.reason ?? row.status_reason,
        })
        .where(eq(machine.id, row.id))
        .run()

      return true

    case 'running': {
      db.update(machine)
        .set({
          status: 'running',
          status_reason: null,
          started_at: date(body.started_at) ?? row.started_at ?? now,
          stopped_at: null,
          exit_code: null,
          failure: null,
        })
        .where(eq(machine.id, row.id))
        .run()

      if (row.status !== 'running') {
        const reason =
          body.reason === 'station_restart' ? 'station_restart' : row.started_at ? 'user' : 'create'

        emitEvent(db, 'machine.started', subject, {
          machine: row.id,
          target: row.target_id,
          server: row.server_id,
          reason,
          stop_at: row.stop_at?.toISOString() ?? null,
        })
      }

      return true
    }

    case 'stopped': {
      const reported = body.reason ?? 'user'
      const reason = row.status_reason === 'idle' && reported === 'user' ? 'idle' : reported
      const ended = reason === 'ttl' || reason === 'exited' || reason === 'oom'
      const stoppedAt = date(body.stopped_at) ?? now

      db.update(machine)
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
        .where(eq(machine.id, row.id))
        .run()
      endRuns(db, row.id)
      stopMachineTasks(db, row.id, new Date())

      if (row.status !== 'stopped') {
        emitEvent(db, 'machine.stopped', subject, {
          machine: row.id,
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
      db.update(machine)
        .set({
          status: 'failed',
          status_reason: null,
          failure: body.failure,
          exit_code: body.exit_code,
          desired_state: 'stopped',
          stop_at: null,
          address: null,
        })
        .where(eq(machine.id, row.id))
        .run()
      endRuns(db, row.id)
      stopMachineTasks(db, row.id, new Date())

      if (row.status !== 'failed') {
        emitEvent(db, 'machine.failed', subject, {
          machine: row.id,
          phase: body.failure?.phase ?? 'start',
          code: body.failure?.code ?? 'MACHINE_START_FAILED',
          summary: body.failure?.summary ?? 'the server reported the machine failed',
        })
      }

      return true
    }
  }
}

export const ingestObservedMachines = (db: Db, stationId: string, observed: Observed) => {
  const capabilities = observed.station.capabilities
  const st = db
    .select({
      capabilities: server.capabilities,
    })
    .from(server)
    .where(eq(server.id, stationId))
    .get()

  if (st && JSON.stringify(st.capabilities) !== JSON.stringify(capabilities)) {
    db.update(server)
      .set({
        capabilities,
      })
      .where(eq(server.id, stationId))
      .run()
  }

  for (const [id, seen] of Object.entries(observed.sandboxes ?? {})) {
    const row = db.select().from(machine).where(eq(machine.id, id)).get()

    if (!row || row.server_id !== stationId || row.status === 'deleting') {
      continue
    }

    const address = seen.status === 'running' ? seen.address : null

    if (row.address !== address || row.disk_used_bytes !== seen.disk.referenced_bytes) {
      db.update(machine)
        .set({
          address,
          disk_used_bytes: seen.disk.referenced_bytes,
        })
        .where(eq(machine.id, id))
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
    .from(machine)
    .where(
      and(eq(machine.status, 'stopped'), isNotNull(machine.stopped_at), isNull(machine.workspace)),
    )
    .all()) {
    const at = deleteAt(row, retention)!

    if (now.getTime() >= at.getTime()) {
      requestDeletion(db, row, {
        actor: systemActor,
        reason: 'retention',
      })
      result.deleted.push(row.id)
      touched.add(row.server_id)
    } else if (
      now.getTime() >= at.getTime() - expiringLeadS * 1000 &&
      (!row.expiring_notified_at || row.expiring_notified_at.getTime() < row.stopped_at!.getTime())
    ) {
      emitEvent(db, 'machine.expiring', machineSubject(row), {
        machine: row.id,
        delete_at: at.toISOString(),
      })
      db.update(machine)
        .set({
          expiring_notified_at: now,
        })
        .where(eq(machine.id, row.id))
        .run()
      result.expiring.push(row.id)
    }
  }

  for (const id of touched) {
    deps.stations.reconcile(id)
  }

  return result
}

export const startMachineRetention = (deps: RetentionDeps, log: Log) =>
  every(60, 'machine.retention_failed', log, () => {
    const result = runRetention(deps)

    if (result.deleted.length || result.expiring.length) {
      log('machine.retention', result)
    }
  })
