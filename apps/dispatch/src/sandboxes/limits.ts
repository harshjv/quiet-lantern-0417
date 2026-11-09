import { and, eq, ne } from 'drizzle-orm'
import type { Db } from '../db/client.ts'
import { sandbox, station } from '../db/schema.ts'
import { fail } from '../api/errors.ts'

type StationRow = typeof station.$inferSelect

export const memoryCap = (st: StationRow) => st.sandbox_limits.memory_bytes ?? (st.resources ? Math.floor(st.resources.memory_bytes * 0.75) : null)

export const minFree = (st: StationRow) => st.sandbox_limits.min_free_bytes ?? (st.capabilities?.sandboxes ? Math.floor(st.capabilities.sandboxes.filesystem_bytes * 0.05) : null)

export type QuotaRequest = { sandboxId: string | null; newSandbox: boolean; running: boolean; memoryBytes: number }

export const requireQuota = (db: Db, st: StationRow, request: QuotaRequest) => {
  const rows = db.select().from(sandbox).where(and(eq(sandbox.station_id, st.id), request.sandboxId ? ne(sandbox.id, request.sandboxId) : undefined)).all()
  const exceeded = (limit: 'max_sandboxes' | 'max_running' | 'memory_bytes', allowed: number, used: number, requested: number) =>
    fail('SANDBOX_QUOTA_EXCEEDED', `Station ${st.name} allows ${allowed} for ${limit}; ${used} are used and this change needs ${requested} more.`, `Delete or stop a sandbox on ${st.name}, or ask an instance admin to raise sandbox_limits.${limit} with sly stations update ${st.name}.`, {
      station: st.id,
      limit,
      allowed,
      used,
      requested
    })
  if (request.newSandbox && rows.length + 1 > st.sandbox_limits.max_sandboxes) exceeded('max_sandboxes', st.sandbox_limits.max_sandboxes, rows.length, 1)
  if (!request.running) return
  const running = rows.filter(r => r.desired_state === 'running' && r.status !== 'deleting')
  if (running.length + 1 > st.sandbox_limits.max_running) exceeded('max_running', st.sandbox_limits.max_running, running.length, 1)
  const cap = memoryCap(st)
  const used = running.reduce((sum, r) => sum + r.size.memory_bytes, 0)
  if (cap !== null && used + request.memoryBytes > cap) exceeded('memory_bytes', cap, used, request.memoryBytes)
}

export const requireDiskRoom = (st: StationRow) => {
  const free = st.capabilities?.sandboxes?.filesystem_free_bytes
  const floor = minFree(st)
  if (free === undefined || floor === null || free >= floor) return
  fail('SANDBOX_DISK_FULL', `Station ${st.name}'s sandbox filesystem has ${free} bytes free, below the ${floor} byte floor for new disks, snapshots and forks.`, 'Delete sandboxes or snapshots, or grow the sandbox filesystem with sly platform storage grow.', {
    station: st.id,
    free_bytes: free,
    min_free_bytes: floor
  })
}
