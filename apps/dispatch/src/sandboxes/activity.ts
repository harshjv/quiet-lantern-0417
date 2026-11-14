import { and, desc, eq, inArray, max, notInArray } from 'drizzle-orm'

import { runActiveStatuses } from '@stationly/protocol'

import type { Db } from '../db/client.ts'
import { agent_event, agent_input, agent_session, run, sandbox } from '../db/schema.ts'

type SandboxRow = typeof sandbox.$inferSelect

const latest = (...times: (Date | null | undefined)[]) =>
  times.reduce<Date | null>((best, time) => (time && (!best || time > best) ? time : best), null)

const runnerRunIds = (db: Db, sandboxId: string) =>
  db
    .select({
      id: agent_session.runner_run_id,
    })
    .from(agent_session)
    .where(eq(agent_session.sandbox_id, sandboxId))
    .all()
    .flatMap((row) => (row.id ? [row.id] : []))

const ownRuns = (db: Db, row: SandboxRow) => [
  ...(row.workspace ? [row.workspace.setup_run_id] : []),
  ...runnerRunIds(db, row.id),
]

export const activityOf = (db: Db, row: SandboxRow) => {
  const lastRun = db
    .select({
      at: run.created_at,
    })
    .from(run)
    .where(and(eq(run.sandbox_id, row.id), notInArray(run.id, ownRuns(db, row))))
    .orderBy(desc(run.created_at))
    .limit(1)
    .get()?.at
  const lastEvent = db
    .select({
      at: max(agent_event.at),
    })
    .from(agent_event)
    .where(eq(agent_event.sandbox_id, row.id))
    .get()?.at
  const lastInput = db
    .select({
      at: max(agent_input.created_at),
    })
    .from(agent_input)
    .where(eq(agent_input.sandbox_id, row.id))
    .get()?.at

  return latest(row.started_at, lastRun, lastEvent, lastInput)
}

export const inUse = (db: Db, row: SandboxRow) => {
  const status = row.agent_status?.status

  if (status === 'working' || status === 'waiting') {
    return true
  }

  return (
    db
      .select({
        id: run.id,
      })
      .from(run)
      .where(
        and(
          eq(run.sandbox_id, row.id),
          inArray(run.status, [...runActiveStatuses]),
          notInArray(run.id, ownRuns(db, row)),
        ),
      )
      .limit(1)
      .get() !== undefined
  )
}
