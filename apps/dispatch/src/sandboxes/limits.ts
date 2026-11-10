import { and, eq, ne } from 'drizzle-orm'

import { bytesText, fitSandboxMemory } from '@stationly/protocol'

import { fail } from '../api/errors.ts'
import type { Db } from '../db/client.ts'
import { sandbox, station } from '../db/schema.ts'

type StationRow = typeof station.$inferSelect

export const memoryCap = (st: StationRow) =>
  st.sandbox_limits.memory_bytes ??
  (st.resources ? Math.floor(st.resources.memory_bytes * 0.75) : null)

export const minFree = (st: StationRow) =>
  st.sandbox_limits.min_free_bytes ??
  (st.capabilities?.sandboxes
    ? Math.floor(st.capabilities.sandboxes.filesystem_bytes * 0.05)
    : null)

export type QuotaRequest = {
  sandboxId: string | null
  newSandbox: boolean
  running: boolean
  memoryBytes: number
}

const sandboxesOn = (db: Db, st: StationRow, except: string | null) =>
  db
    .select()
    .from(sandbox)
    .where(and(eq(sandbox.station_id, st.id), except ? ne(sandbox.id, except) : undefined))
    .all()

const runningOf = (rows: (typeof sandbox.$inferSelect)[]) =>
  rows.filter((r) => r.desired_state === 'running' && r.status !== 'deleting')

export const sandboxMemory = (db: Db, st: StationRow) => {
  const limit = memoryCap(st)
  const used = runningOf(sandboxesOn(db, st, null)).reduce((sum, r) => sum + r.size.memory_bytes, 0)
  return {
    limit,
    used,
    free: limit === null ? null : Math.max(0, limit - used),
  }
}

export const fittingMemory = (db: Db, st: StationRow) =>
  fitSandboxMemory(sandboxMemory(db, st).free)

export const requireQuota = (db: Db, st: StationRow, request: QuotaRequest) => {
  const rows = sandboxesOn(db, st, request.sandboxId)
  const exceeded = (
    limit: 'max_sandboxes' | 'max_running' | 'memory_bytes',
    allowed: number,
    used: number,
    requested: number,
  ) => {
    const text = limit === 'memory_bytes' ? bytesText : String
    return fail(
      'SANDBOX_QUOTA_EXCEEDED',
      `Station ${st.name} allows ${text(allowed)} for ${limit}; ${text(used)} ${limit === 'memory_bytes' ? 'is' : 'are'} used and this change needs ${text(requested)} more.`,
      `Delete or stop a sandbox on ${st.name}, or ask an instance admin to raise sandbox_limits.${limit} with sly stations update ${st.name} --sandbox-limits ${limit}=<n>.`,
      {
        station: st.id,
        limit,
        allowed,
        used,
        requested,
      },
    )
  }
  if (request.newSandbox && rows.length + 1 > st.sandbox_limits.max_sandboxes)
    exceeded('max_sandboxes', st.sandbox_limits.max_sandboxes, rows.length, 1)
  if (!request.running) return
  const running = runningOf(rows)
  if (running.length + 1 > st.sandbox_limits.max_running)
    exceeded('max_running', st.sandbox_limits.max_running, running.length, 1)
  const cap = memoryCap(st)
  const used = running.reduce((sum, r) => sum + r.size.memory_bytes, 0)
  if (cap !== null && used + request.memoryBytes > cap)
    exceeded('memory_bytes', cap, used, request.memoryBytes)
}

export const requireDiskRoom = (st: StationRow) => {
  const free = st.capabilities?.sandboxes?.filesystem_free_bytes
  const floor = minFree(st)
  if (free === undefined || floor === null || free >= floor) return
  fail(
    'SANDBOX_DISK_FULL',
    `Station ${st.name}'s sandbox filesystem has ${free} bytes free, below the ${floor} byte floor for new disks, snapshots and forks.`,
    `Delete sandboxes or snapshots, or grow the sandbox filesystem with sly sandboxes grow-storage ${st.name} --size-bytes <size>.`,
    {
      station: st.id,
      free_bytes: free,
      min_free_bytes: floor,
    },
  )
}
