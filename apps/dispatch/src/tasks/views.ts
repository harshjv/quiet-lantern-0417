import type { Static } from '@sinclair/typebox'
import { and, asc, desc, eq, isNull, lt, sql } from 'drizzle-orm'

import { invalid } from '../api/errors.ts'
import type { Redactor } from '../api/redaction.ts'
import type { Task } from '../api/shapes.ts'
import type { Db } from '../db/client.ts'
import { conversation, machine, project, run, task, task_inbox } from '../db/schema.ts'
import { setupFailureOf } from '../sandboxes/setup-failure.ts'

import { queuePosition } from './machine.ts'
import { previewAddress, previewOf } from './preview.ts'
import { startTimeoutMs } from './runner.ts'
import { latestShip, shipView } from './ship.ts'
import type { TaskRow } from './status.ts'

export type TaskItem = Static<typeof Task>

export const titleLength = 80

export const titleOf = (text: string) => {
  const line = text.split('\n').find((part) => part.trim()) ?? text
  const flat = line.replace(/\s+/g, ' ').trim()

  const chars = Array.from(flat)

  if (chars.length <= titleLength) {
    return flat || 'Untitled task'
  }

  const cut = chars.slice(0, titleLength - 1).join('')
  const space = cut.lastIndexOf(' ')

  return `${(space > titleLength / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

export const branchSlug = (title: string) =>
  `task/${
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '') || 'work'
  }`

export const uniqueBranch = (db: Db, repository: string, wanted: string) => {
  const taken = new Set(
    db
      .select({
        branch: task.branch,
      })
      .from(task)
      .where(eq(task.repository, repository))
      .all()
      .map((row) => row.branch),
  )
  let name = wanted

  for (let n = 2; taken.has(name); n += 1) {
    name = `${wanted}-${n}`
  }

  return name
}

type Setup = NonNullable<TaskItem['setup']>

type RunRow = typeof run.$inferSelect

const runOf = (db: Db, id: string | null | undefined) =>
  id ? db.select().from(run).where(eq(run.id, id)).get() : undefined

const pendingRun = (setup: RunRow | undefined) =>
  !setup || setup.status === 'queued' || setup.status === 'running'

const projectSetupOf = (
  db: Db,
  row: TaskRow,
  box: typeof machine.$inferSelect | undefined,
  now: number,
) => {
  const machineRun = runOf(db, box?.workspace?.setup_run_id)
  const ownRun = runOf(db, row.setup_run_id)

  if (!box || box.status !== 'running') {
    return {
      setup: {
        state: 'creating',
        run_id: row.setup_run_id,
      } satisfies Setup,
      failed: null,
    }
  }

  for (const step of [machineRun, ownRun]) {
    if (step && !pendingRun(step) && step.status !== 'succeeded') {
      return {
        setup: {
          state: 'failed',
          run_id: step.id,
        } satisfies Setup,
        failed: step,
      }
    }
  }

  if (pendingRun(machineRun) || pendingRun(ownRun)) {
    return {
      setup: {
        state: 'setting_up',
        run_id: ownRun?.id ?? machineRun?.id ?? null,
      } satisfies Setup,
      failed: null,
    }
  }

  const finished = ownRun!.finished_at?.getTime() ?? now

  return now - finished <= startTimeoutMs
    ? {
        setup: {
          state: 'starting',
          run_id: ownRun!.id,
        } satisfies Setup,
        failed: null,
      }
    : {
        setup: {
          state: 'failed',
          run_id: ownRun!.id,
        } satisfies Setup,
        failed: ownRun!,
      }
}

const setupOf = (db: Db, box: typeof machine.$inferSelect | undefined, now: number) => {
  const runId = box?.workspace?.setup_run_id ?? null

  if (!box || box.status !== 'running') {
    return {
      setup: {
        state: 'creating',
        run_id: runId,
      } satisfies Setup,
      failed: null,
    }
  }

  const setup = runId ? db.select().from(run).where(eq(run.id, runId)).get() : undefined

  if (!setup || setup.status === 'queued' || setup.status === 'running') {
    return {
      setup: {
        state: 'setting_up',
        run_id: runId,
      } satisfies Setup,
      failed: null,
    }
  }

  const finished = setup.finished_at?.getTime() ?? now

  if (setup.status === 'succeeded' && now - finished <= startTimeoutMs) {
    return {
      setup: {
        state: 'starting',
        run_id: runId,
      } satisfies Setup,
      failed: null,
    }
  }

  return {
    setup: {
      state: 'failed',
      run_id: runId,
    } satisfies Setup,
    failed: setup,
  }
}

const firstPrompt = (db: Db, taskId: string) =>
  db
    .select({
      text: task_inbox.text,
    })
    .from(task_inbox)
    .where(and(eq(task_inbox.task_id, taskId), eq(task_inbox.kind, 'prompt')))
    .orderBy(asc(task_inbox.seq))
    .limit(1)
    .get()?.text ?? null

const modelOf = (db: Db, row: TaskRow) =>
  db
    .select({
      model: conversation.model,
    })
    .from(conversation)
    .where(eq(conversation.task_id, row.id))
    .orderBy(desc(conversation.created_at))
    .limit(1)
    .get()?.model ?? row.model

const shipOf = (db: Db, taskId: string) => {
  const found = latestShip(db, taskId)

  return found ? shipView(db, found) : null
}

const previewView = (db: Db, row: TaskRow) => {
  const preview = previewOf(db, row)

  return preview
    ? {
        id: preview.id,
        name: preview.name,
        url: previewAddress(db, preview.id),
      }
    : null
}

export const taskItem = (db: Db, row: TaskRow, redact: Redactor, now = Date.now()): TaskItem => {
  const box = db.select().from(machine).where(eq(machine.id, row.machine_id)).get()
  const proj = db.select().from(project).where(eq(project.id, row.project_id)).get()
  const pending =
    row.status === 'setting_up'
      ? row.machine === 'project'
        ? projectSetupOf(db, row, box, now)
        : setupOf(db, box, now)
      : null
  const prompt = firstPrompt(db, row.id)

  return {
    id: row.id,
    project: {
      id: row.project_id,
      name: proj?.name ?? row.project_id,
    },
    preview_id: row.preview_id,
    owner: {
      type: row.owner.type,
      id: row.owner.id,
    },
    title: redact(row.title),
    repository: row.repository,
    base_branch: row.base_branch,
    branch: row.branch,
    agent: row.agent,
    model: modelOf(db, row),
    machine: {
      id: row.machine_id,
      name: box?.name ?? row.machine_id,
      kind: row.machine,
    },
    port: row.port,
    ship: shipOf(db, row.id),
    preview: previewView(db, row),
    queued_ahead: queuePosition(db, row),
    status: pending?.failed ? 'failed' : row.status,
    attention: row.attention,
    failure: pending?.failed ? setupFailureOf(pending.failed, redact) : null,
    setup: pending?.setup ?? null,
    prompt: prompt === null ? null : redact(prompt),
    last_event_at: row.activity?.last_event_at ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    archived_at: row.archived_at?.toISOString() ?? null,
  }
}

const decodeCursor = (cursor: string) => {
  const id = Buffer.from(cursor, 'base64url').toString()

  if (!id.startsWith('tsk_')) {
    invalid([
      {
        path: '/cursor',
        message: 'unknown cursor',
      },
    ])
  }

  return id
}

export const listTasks = (
  db: Db,
  options: {
    owner: string | null
    limit: number
    cursor: string | undefined
    archived: boolean
    redactor: (machineId: string) => Redactor
  },
) => {
  const after = options.cursor ? decodeCursor(options.cursor) : null
  const rows = db
    .select()
    .from(task)
    .where(
      and(
        options.archived ? undefined : isNull(task.archived_at),
        options.owner !== null
          ? sql`json_extract(${task.owner}, '$.id') = ${options.owner}`
          : undefined,
        after ? lt(task.id, after) : undefined,
      ),
    )
    .orderBy(desc(task.id))
    .limit(options.limit + 1)
    .all()
  const page = rows.slice(0, options.limit)
  const now = Date.now()

  return {
    items: page.map((row) => taskItem(db, row, options.redactor(row.machine_id), now)),
    next_cursor:
      rows.length > options.limit && page.length
        ? Buffer.from(page.at(-1)!.id).toString('base64url')
        : null,
  }
}
