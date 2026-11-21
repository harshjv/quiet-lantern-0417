import { and, desc, eq, gte, inArray, type SQL } from 'drizzle-orm'
import { t } from 'elysia'

import {
  runActiveStatuses,
  runKindValues,
  runStatusValues,
  runTerminalStatuses,
} from '@stationly/protocol'

import type { Db } from '../db/client.ts'
import { machine, run } from '../db/schema.ts'

import type { Call } from './context.ts'
import { notFound } from './errors.ts'
import { project as select } from './fields.ts'
import { csv, parseTime, type Kit } from './kit.ts'
import { before, collect, filterMany, listQuery, since } from './pagination.ts'

type RunRow = typeof run.$inferSelect

const maxLines = 200
const maxBytes = 64 * 1024

export const terminalRun = new Set<RunRow['status']>(runTerminalStatuses)

export const runRow = (db: Db, id: string) =>
  db.select().from(run).where(eq(run.id, id)).get() ?? notFound('run', id)

export const pollUntil = async (
  done: () => boolean,
  ms: number,
  signal?: AbortSignal,
  everyMs = 100,
) => {
  const deadline = Date.now() + ms

  while (!done() && Date.now() < deadline && !signal?.aborted) {
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(everyMs, Math.max(0, deadline - Date.now()))),
    )
  }
}

export const activeMachineRuns = (db: Db, machineId: string) =>
  db
    .select({
      id: run.id,
    })
    .from(run)
    .where(and(eq(run.machine_id, machineId), inArray(run.status, [...runActiveStatuses])))
    .all().length

export const waitForRun = async (db: Db, id: string, seconds: number, signal: AbortSignal) => {
  let row = runRow(db, id)

  await pollUntil(
    () => terminalRun.has((row = runRow(db, id)).status),
    Math.min(seconds, 10) * 1000,
    signal,
    200,
  )

  return row
}

export const runListQuery = t.Object({
  ...listQuery,
  kind: filterMany(runKindValues),
  status: filterMany(runStatusValues),
  since,
})

export const listRuns = (kit: Kit, owner: SQL, query: typeof runListQuery.static) => {
  const { db } = kit.deps
  const since = parseTime(query.since, '/since')
  const kinds = csv(query.kind)
  const statuses = csv(query.status)
  const page = collect(
    (cursor, size) =>
      db
        .select()
        .from(run)
        .where(
          and(
            owner,
            kinds ? inArray(run.kind, kinds as RunRow['kind'][]) : undefined,
            statuses ? inArray(run.status, statuses as RunRow['status'][]) : undefined,
            since ? gte(run.created_at, since) : undefined,
            before(run.id, cursor),
          ),
        )
        .orderBy(desc(run.id))
        .limit(size)
        .all(),
    query,
  )

  return {
    items: page.rows.map((row) => select(kit.views.run, row, kit.fields(query.fields))),
    next_cursor: page.next_cursor,
  }
}

export const machineRunOutput = async (kit: Kit, row: RunRow, call: Call) => {
  const { db, stations } = kit.deps
  const box = db
    .select({
      server_id: machine.server_id,
    })
    .from(machine)
    .where(eq(machine.id, row.machine_id!))
    .get()

  if (!box) {
    return undefined
  }

  try {
    const reply = await stations.ask(
      box.server_id,
      'logs.query',
      {
        source: 'run',
        run_id: row.id,
        tail: maxLines,
      },
      {
        timeoutMs: 10_000,
      },
    )
    const page = reply.body
    const redact = kit.machineRedaction([row.machine_id!], call.principal.actor, call.request_id)
    const lines = page.lines.map((line) => `${line.stream}: ${redact(line.text)}`)
    let size = 0
    let kept = lines.length

    while (kept > 0 && (size += Buffer.byteLength(lines[kept - 1]!) + 1) <= maxBytes) {
      kept -= 1
    }

    const shown = lines.slice(kept)

    return {
      untrusted: {
        source: 'machine exec output' as const,
        text: shown.length ? `${shown.join('\n')}\n` : '',
      },
      truncated: page.truncated || kept > 0,
      cursor: page.next_cursor ?? page.lines.at(-1)?.cursor ?? null,
    }
  } catch {
    return undefined
  }
}
