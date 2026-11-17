import { and, desc, eq, inArray, max, notInArray } from 'drizzle-orm'

import { runActiveStatuses } from '@stationly/protocol'

import type { Db } from '../db/client.ts'
import { conversation, conversation_event, machine, run, task, task_inbox } from '../db/schema.ts'
import { tasksInUse } from '../tasks/machine.ts'

type MachineRow = typeof machine.$inferSelect

const latest = (...times: (Date | null | undefined)[]) =>
  times.reduce<Date | null>((best, time) => (time && (!best || time > best) ? time : best), null)

const taskIds = (db: Db, machineId: string) =>
  db
    .select({
      id: task.id,
    })
    .from(task)
    .where(eq(task.machine_id, machineId))
    .all()
    .map((row) => row.id)

const runnerRunIds = (db: Db, machineId: string) =>
  db
    .select({
      id: conversation.runner_run_id,
    })
    .from(conversation)
    .innerJoin(task, eq(task.id, conversation.task_id))
    .where(eq(task.machine_id, machineId))
    .all()
    .flatMap((row) => (row.id ? [row.id] : []))

const ownRuns = (db: Db, row: MachineRow) => [
  ...(row.workspace ? [row.workspace.setup_run_id] : []),
  ...runnerRunIds(db, row.id),
]

export const activityOf = (db: Db, row: MachineRow) => {
  const lastRun = db
    .select({
      at: run.created_at,
    })
    .from(run)
    .where(and(eq(run.machine_id, row.id), notInArray(run.id, ownRuns(db, row))))
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

export const inUse = (db: Db, row: MachineRow) => {
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
          eq(run.machine_id, row.id),
          inArray(run.status, [...runActiveStatuses]),
          notInArray(run.id, ownRuns(db, row)),
        ),
      )
      .limit(1)
      .get() !== undefined
  )
}
