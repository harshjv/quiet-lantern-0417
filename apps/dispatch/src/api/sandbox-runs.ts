import type { MessageBody } from '@stationly/protocol'
import { eq } from 'drizzle-orm'
import { run, sandbox } from '../db/schema.ts'
import type { Call } from './context.ts'
import type { Kit } from './kit.ts'

type RunRow = typeof run.$inferSelect

const maxLines = 200
const maxBytes = 64 * 1024

export const sandboxRunOutput = async (kit: Kit, row: RunRow, call: Call) => {
  const { db, stations } = kit.deps
  const box = db.select({ station_id: sandbox.station_id }).from(sandbox).where(eq(sandbox.id, row.sandbox_id!)).get()
  if (!box) return undefined
  try {
    const reply = await stations.ask(box.station_id, 'logs.query', { source: 'run', run_id: row.id, tail: maxLines }, { timeoutMs: 10_000 })
    const page = reply.body as MessageBody<'logs.page'>
    const redact = kit.sandboxRedaction([row.sandbox_id!], call.principal.actor, call.request_id)
    const lines = page.lines.map(line => `${line.stream}: ${redact(line.text)}`)
    let size = 0
    let kept = lines.length
    while (kept > 0 && (size += Buffer.byteLength(lines[kept - 1]!) + 1) <= maxBytes) kept -= 1
    const shown = lines.slice(kept)
    return {
      untrusted: { source: 'sandbox exec output' as const, text: shown.length ? `${shown.join('\n')}\n` : '' },
      truncated: page.truncated || kept > 0,
      cursor: page.next_cursor ?? page.lines.at(-1)?.cursor ?? null
    }
  } catch {
    return undefined
  }
}

const terminal = new Set<RunRow['status']>(['succeeded', 'failed', 'skipped', 'cancelled'])

export const waitForRun = async (kit: Kit, id: string, seconds: number, signal: AbortSignal) => {
  const { db } = kit.deps
  const deadline = Date.now() + Math.min(seconds, 10) * 1000
  let row = db.select().from(run).where(eq(run.id, id)).get()!
  while (!terminal.has(row.status) && Date.now() < deadline && !signal.aborted) {
    await new Promise(resolve => setTimeout(resolve, Math.min(200, Math.max(0, deadline - Date.now()))))
    row = db.select().from(run).where(eq(run.id, id)).get()!
  }
  return row
}
