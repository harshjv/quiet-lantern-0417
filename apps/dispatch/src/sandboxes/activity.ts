import { and, desc, eq, inArray, max, notInArray } from 'drizzle-orm'

import { runActiveStatuses } from '@stationly/protocol'

import type { Db } from '../db/client.ts'
import { conversation, conversation_event, run, sandbox, task, task_inbox } from '../db/schema.ts'
import { tasksInUse } from '../tasks/machine.ts'

type SandboxRow = typeof sandbox.$inferSelect

const latest = (...times: (Date | null | undefined)[]) =>
  times.reduce<Date | null>((best, time) => (time && (!best || time > best) ? time : best), null)

const taskIds = (db: Db, sandboxId: string) =>
  db
    .select({
      id: task.id,
    })
    .from(task)
    .where(eq(task.sandbox_id, sandboxId))
    .all()
    .map((row) => row.id)

const runnerRunIds = (db: Db, sandboxId: string) =>
  db
    .select({
      id: conversation.runner_run_id,
    })
    .from(conversation)
    .innerJoin(task, eq(task.id, conversation.task_id))
    .where(eq(task.sandbox_id, sandboxId))
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
  const owners = taskIds(db, row.id)
  const lastEvent = owners.length
    ? db
        .select({
          at: max(conversation_event.at),
        })
        .from(conversation_event)
        .where(inArray(conversation_event.task_id, owners))
        .get()?.at
    : null
  const lastInput = owners.length
    ? db
        .select({
          at: max(task_inbox.created_at),
        })
        .from(task_inbox)
        .where(inArray(task_inbox.task_id, owners))
        .get()?.at
    : null

  return latest(row.started_at, lastRun, lastEvent, lastInput)
}

export const inUse = (db: Db, row: SandboxRow) => {
  if (tasksInUse(db, row.id)) {
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
