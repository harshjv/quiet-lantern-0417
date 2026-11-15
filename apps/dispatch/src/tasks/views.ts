import type { Static } from '@sinclair/typebox'
import { and, asc, desc, eq, isNull, lt } from 'drizzle-orm'

import { invalid } from '../api/errors.ts'
import type { Redactor } from '../api/redaction.ts'
import type { Task } from '../api/shapes.ts'
import type { Db } from '../db/client.ts'
import { conversation, environment, project, run, sandbox, task, task_inbox } from '../db/schema.ts'
import { setupFailureOf } from '../sandboxes/setup-failure.ts'

import { startTimeoutMs } from './runner.ts'
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

type Setup = NonNullable<TaskItem['setup']>

const setupOf = (db: Db, box: typeof sandbox.$inferSelect | undefined, now: number) => {
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

export const taskItem = (db: Db, row: TaskRow, redact: Redactor, now = Date.now()): TaskItem => {
  const box = db.select().from(sandbox).where(eq(sandbox.id, row.sandbox_id)).get()
  const proj = db.select().from(project).where(eq(project.id, row.project_id)).get()
  const env = db.select().from(environment).where(eq(environment.id, row.environment_id)).get()
  const pending = row.status === 'setting_up' ? setupOf(db, box, now) : null
  const prompt = firstPrompt(db, row.id)

  return {
    id: row.id,
    project: {
      id: row.project_id,
      name: proj?.name ?? row.project_id,
    },
    environment: {
      id: row.environment_id,
      name: env?.name ?? row.environment_id,
    },
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
    sandbox: {
      id: row.sandbox_id,
      name: box?.name ?? row.sandbox_id,
    },
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
    limit: number
    cursor: string | undefined
    archived: boolean
    redactor: (sandboxId: string) => Redactor
  },
) => {
  const after = options.cursor ? decodeCursor(options.cursor) : null
  const rows = db
    .select()
    .from(task)
    .where(
      and(
        options.archived ? undefined : isNull(task.archived_at),
        after ? lt(task.id, after) : undefined,
      ),
    )
    .orderBy(desc(task.id))
    .limit(options.limit + 1)
    .all()
  const page = rows.slice(0, options.limit)
  const now = Date.now()

  return {
    items: page.map((row) => taskItem(db, row, options.redactor(row.sandbox_id), now)),
    next_cursor:
      rows.length > options.limit && page.length
        ? Buffer.from(page.at(-1)!.id).toString('base64url')
        : null,
  }
}
