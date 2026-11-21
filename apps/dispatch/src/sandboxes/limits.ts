import { and, eq, ne } from 'drizzle-orm'

import { bytesText, fitMachineMemory } from '@stationly/protocol'

import { can } from '../api/access.ts'
import { fail } from '../api/errors.ts'
import { scopeOf } from '../api/lookup.ts'
import type { Principal } from '../auth/principal.ts'
import type { Db } from '../db/client.ts'
import { machine, project, server, target } from '../db/schema.ts'

import { activityOf } from './activity.ts'

type StationRow = typeof server.$inferSelect

export const memoryCap = (st: StationRow) =>
  st.machine_limits.memory_bytes ??
  (st.resources ? Math.floor(st.resources.memory_bytes * 0.75) : null)

export const minFree = (st: StationRow) =>
  st.machine_limits.min_free_bytes ??
  (st.capabilities?.sandboxes
    ? Math.floor(st.capabilities.sandboxes.filesystem_bytes * 0.05)
    : null)

export type QuotaRequest = {
  machineId: string | null
  newMachine: boolean
  running: boolean
  memoryBytes: number
}

const machinesOn = (db: Db, st: StationRow, except: string | null) =>
  db
    .select()
    .from(machine)
    .where(and(eq(machine.server_id, st.id), except ? ne(machine.id, except) : undefined))
    .all()

const runningOf = (rows: (typeof machine.$inferSelect)[]) =>
  rows.filter((r) => r.desired_state === 'running' && r.status !== 'deleting')

export const machineMemory = (db: Db, st: StationRow) => {
  const limit = memoryCap(st)
  const used = runningOf(machinesOn(db, st, null)).reduce((sum, r) => sum + r.size.memory_bytes, 0)

  return {
    limit,
    used,
    free: limit === null ? null : Math.max(0, limit - used),
  }
}

export const fittingMemory = (db: Db, st: StationRow, wanted?: number) =>
  fitMachineMemory(machineMemory(db, st).free, wanted)

const targetScope = (db: Db, targetId: string) =>
  scopeOf(db.select().from(target).where(eq(target.id, targetId)).get()!)

const previewOf = (db: Db, targetId: string) => {
  const row = db
    .select({
      id: target.id,
      name: target.name,
      kind: target.kind,
    })
    .from(target)
    .where(eq(target.id, targetId))
    .get()

  return row && row.kind === 'preview'
    ? {
        id: row.id,
        name: row.name,
      }
    : null
}

const holdersOf = (db: Db, rows: (typeof machine.$inferSelect)[], principal: Principal) => {
  const named = (table: typeof project | typeof target, id: string) =>
    db
      .select({
        id: table.id,
        name: table.name,
      })
      .from(table)
      .where(eq(table.id, id))
      .get()

  return rows
    .filter((row) => can(principal, targetScope(db, row.target_id), 'read'))
    .map((row) => ({
      id: row.id,
      name: row.name,
      project: named(project, row.project_id) ?? null,
      preview: previewOf(db, row.target_id),
      workspace: row.workspace !== null,
      repository: row.workspace?.repository ?? null,
      status: row.status,
      memory_bytes: row.size.memory_bytes,
      last_activity_at: activityOf(db, row)?.toISOString() ?? null,
    }))
}

export const requireQuota = (
  db: Db,
  st: StationRow,
  request: QuotaRequest,
  principal: Principal,
) => {
  const rows = machinesOn(db, st, request.machineId)
  const exceeded = (
    limit: 'max_machines' | 'max_running' | 'memory_bytes',
    allowed: number,
    used: number,
    requested: number,
  ) => {
    const text = limit === 'memory_bytes' ? bytesText : String

    return fail(
      'MACHINE_QUOTA_EXCEEDED',
      `Server ${st.name} allows ${text(allowed)} for ${limit}; ${text(used)} ${limit === 'memory_bytes' ? 'is' : 'are'} used and this change needs ${text(requested)} more.`,
      `Delete a task on ${st.name}, or ask an instance admin to raise machine_limits.${limit} with sly servers update ${st.name} --machine-limits ${limit}=<n>.`,
      {
        server: st.id,
        limit,
        allowed,
        used,
        requested,
        holders: holdersOf(db, limit === 'max_machines' ? rows : runningOf(rows), principal),
      },
    )
  }

  if (request.newMachine && rows.length + 1 > st.machine_limits.max_machines) {
    exceeded('max_machines', st.machine_limits.max_machines, rows.length, 1)
  }

  if (!request.running) {
    return
  }

  const running = runningOf(rows)

  if (running.length + 1 > st.machine_limits.max_running) {
    exceeded('max_running', st.machine_limits.max_running, running.length, 1)
  }

  const cap = memoryCap(st)
  const used = running.reduce((sum, r) => sum + r.size.memory_bytes, 0)

  if (cap !== null && used + request.memoryBytes > cap) {
    exceeded('memory_bytes', cap, used, request.memoryBytes)
  }
}

export const requireDiskRoom = (st: StationRow) => {
  const free = st.capabilities?.sandboxes?.filesystem_free_bytes
  const floor = minFree(st)

  if (free === undefined || floor === null || free >= floor) {
    return
  }

  fail(
    'MACHINE_DISK_FULL',
    `Server ${st.name}'s task storage has ${free} bytes free, below the ${floor} byte floor for a new task's disk.`,
    `Delete tasks, or grow task storage with sly servers grow-task-storage ${st.name} --size-bytes <size>.`,
    {
      server: st.id,
      free_bytes: free,
      min_free_bytes: floor,
    },
  )
}
