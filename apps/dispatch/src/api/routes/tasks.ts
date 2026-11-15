import { randomBytes } from 'node:crypto'

import type { Static } from '@sinclair/typebox'
import { eq } from 'drizzle-orm'
import { t } from 'elysia'

import {
  agentPromptLimit,
  SandboxCreateBody,
  workspaceAgents,
  workspaceAgentValues,
} from '@stationly/protocol'

import type { Principal } from '../../auth/principal.ts'
import type { Db } from '../../db/client.ts'
import { newId } from '../../db/ids.ts'
import { sandbox, station, task } from '../../db/schema.ts'
import { requestDeletion, startSandbox } from '../../sandboxes/lifecycle.ts'
import { variablesOf } from '../../secrets/values.ts'
import { emitEvent } from '../../station/events.ts'
import {
  agentBus,
  firstConversationEvent,
  sessionIds,
  shownTaskEvent,
  taskEventsAfter,
  type AgentEventLive,
} from '../../tasks/events.ts'
import {
  addInput,
  latestConversation,
  runnerLive,
  startConversation,
  wantRunner,
} from '../../tasks/runner.ts'
import { taskSubject, type TaskRow } from '../../tasks/status.ts'
import { branchSlug, listTasks, taskItem, titleOf } from '../../tasks/views.ts'
import { requireHuman } from '../access.ts'
import { audit, type Call } from '../context.ts'
import { requireConnected } from '../deployments.ts'
import { ApiError, fail, invalid, notFound } from '../errors.ts'
import type { Kit } from '../kit.ts'
import { environmentById, environmentInProject, projectByRef } from '../lookup.ts'
import {
  AgentEventPage,
  AgentInputAccepted,
  AgentInterruptAccepted,
  replies,
  Task,
  TaskDeleted,
  TaskPage,
} from '../shapes.ts'
import { createSse } from '../sse.ts'

type CreateSandbox = (
  call: Call,
  ctx: ReturnType<typeof environmentById>,
  body: Static<typeof SandboxCreateBody>,
  taskBranch: string | null,
) => Promise<{ id: string }>

const drainSize = 200
const fallbackPollMs = 1000
const defaultPageSize = 100
const maxPageSize = 500
const nameAttempts = 5

const eventsQuery = t.Object({
  since: t.Optional(
    t.String({
      description: 'Resume after this seq, the id of an event of this task',
    }),
  ),
  conversation: t.Optional(
    t.String({
      description: 'Only the events of this conversation',
    }),
  ),
  limit: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: maxPageSize,
      description: `Page size, default ${defaultPageSize}`,
    }),
  ),
})

type EventsQuery = typeof eventsQuery.static

const workspaceName = (title: string) =>
  `${
    title
      .toLowerCase()
      .split(/\s+/)
      .slice(0, 5)
      .join('-')
      .replace(/[^a-z0-9-]+/g, '')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/g, '') || 'task'
  }-${randomBytes(3).toString('hex').slice(0, 4)}`

const cursorOf = (request: Request, query: EventsQuery) => {
  const text = request.headers.get('last-event-id') ?? query.since

  if (text === undefined) {
    return undefined
  }

  if (!/^\d+$/.test(text)) {
    invalid([
      {
        path: '/since',
        message: 'not a seq from this stream',
      },
    ])
  }

  return Number(text)
}

const taskById = (db: Db, id: string) =>
  db.select().from(task).where(eq(task.id, id)).get() ?? notFound('task', id)

const requireKey = (db: Db, projectId: string, agent: keyof typeof workspaceAgents) => {
  const preset = workspaceAgents[agent]
  const keys = new Set(
    variablesOf(db, {
      scope: 'project',
      id: projectId,
    })
      .all()
      .map((variable) => variable.key),
  )

  if (!preset.keys.some((key) => keys.has(key))) {
    invalid([
      {
        path: '/agent',
        message: `the project defines none of ${preset.keys.join(', ')} for ${preset.label}`,
      },
    ])
  }
}

export const taskRoutes = (kit: Kit, createSandbox: CreateSandbox) => {
  const { db } = kit.deps

  const redactor = (row: TaskRow, principal: Principal, requestId: string) => () =>
    kit.sandboxRedaction([row.sandbox_id], principal.actor, requestId)

  const shown = (row: TaskRow, call: Call) =>
    taskItem(
      db,
      db.select().from(task).where(eq(task.id, row.id)).get()!,
      redactor(row, call.principal, call.request_id)(),
    )

  const wake = (call: Call, row: TaskRow, refusal: string) => {
    const box = db.select().from(sandbox).where(eq(sandbox.id, row.sandbox_id)).get()

    if (!box) {
      fail(
        'SANDBOX_NOT_RUNNING',
        `The workspace of task ${row.title} is gone, so ${refusal}.`,
        'Start a new task.',
        {
          status: 'deleted',
        },
      )
    }

    if (box!.status === 'stopped') {
      requireConnected(kit.deps, box!.station_id)
      startSandbox(
        db,
        db.select().from(station).where(eq(station.id, box!.station_id)).get()!,
        call.principal,
        box!,
        null,
      )
      audit(
        db,
        call,
        'sandbox.start',
        {
          entity: 'sandbox',
          id: box!.id,
        },
        {
          before: {
            status: box!.status,
          },
        },
      )
      kit.deps.stations.reconcile(box!.station_id)

      return
    }

    if (!['creating', 'starting', 'running'].includes(box!.status)) {
      fail(
        'SANDBOX_NOT_RUNNING',
        `The workspace of task ${row.title} is ${box!.status}, so ${refusal}.`,
        'Start a new task.',
        {
          status: box!.status,
        },
      )
    }
  }

  const start = (row: TaskRow, since: number | undefined, conversationId: string | undefined) => {
    if (since !== undefined) {
      return since
    }

    const first = conversationId ? firstConversationEvent(db, row.id, conversationId) : 1

    return Math.max(0, (first ?? 1) - 1)
  }

  const page = async (row: TaskRow, request: Request, query: EventsQuery) => {
    const call = await kit.call(request)
    const since = start(row, cursorOf(request, query), query.conversation)
    const redact = redactor(row, call.principal, call.request_id)()
    const sessions = sessionIds(db, row.id)
    const rows = taskEventsAfter(
      db,
      row.id,
      since,
      query.limit ?? defaultPageSize,
      query.conversation,
    )

    return {
      items: rows.map((entry) => shownTaskEvent(entry, sessions, redact)),
      next_since: String(rows.at(-1)?.seq ?? since),
    }
  }

  const stream = async (row: TaskRow, request: Request, query: EventsQuery) => {
    const call = await kit.call(request)
    const redact = redactor(row, call.principal, call.request_id)
    const sse = createSse(request.signal)
    let last = start(row, cursorOf(request, query), query.conversation)
    let draining = false
    let again = false
    const drain = async () => {
      if (draining) {
        again = true

        return
      }

      draining = true

      try {
        do {
          again = false

          const masked = redact()
          const sessions = sessionIds(db, row.id)

          for (;;) {
            const batch = taskEventsAfter(db, row.id, last, drainSize, query.conversation)

            if (!batch.length) {
              break
            }

            for (const entry of batch) {
              last = entry.seq
              await sse.send(entry.type, shownTaskEvent(entry, sessions, masked), String(entry.seq))

              if (sse.closed()) {
                return
              }
            }
          }
        } while (again && !sse.closed())
      } finally {
        draining = false
      }
    }
    const stored = (taskId: string) => {
      if (taskId === row.id) {
        void drain()
      }
    }
    const part = (taskId: string, event: AgentEventLive) => {
      if (taskId === row.id) {
        void sse.send(event.type, event)
      }
    }

    agentBus.on('stored', stored)
    agentBus.on('part', part)
    const poll = setInterval(() => stored(row.id), fallbackPollMs)

    sse.onClose(() => {
      agentBus.off('stored', stored)
      agentBus.off('part', part)
      clearInterval(poll)
    })
    void drain()

    return sse.response
  }

  return kit
    .router('tasks', '/v1')
    .get(
      '/tasks',
      async ({ request, query }) => {
        const call = await kit.call(request)

        return listTasks(db, {
          limit: query.limit ?? defaultPageSize,
          cursor: query.cursor,
          archived: query.archived ?? false,
          redactor: (sandboxId) =>
            kit.sandboxRedaction([sandboxId], call.principal.actor, call.request_id),
        })
      },
      {
        operation: {
          id: 'list_tasks',
          summary: 'Tasks, newest first, with their status and setup; for an instance admin',
          level: 'instance admin',
          mcp: false,
          cli: {
            path: ['tasks', 'list'],
          },
        },
        query: t.Object({
          limit: t.Optional(
            t.Integer({
              minimum: 1,
              maximum: 200,
              description: `Page size, default ${defaultPageSize}`,
            }),
          ),
          cursor: t.Optional(
            t.String({
              description: 'The next_cursor of the previous page',
            }),
          ),
          archived: t.Optional(
            t.Boolean({
              description: 'Include archived tasks',
            }),
          ),
        }),
        response: replies({
          200: TaskPage,
        }),
      },
    )
    .post(
      '/tasks',
      async ({ request, body, set }) => {
        const call = await kit.call(request)

        requireHuman(call.principal, 'Starting a task')

        const proj = projectByRef(db, body.project)
        const env = body.environment
          ? environmentInProject(db, proj, body.environment)
          : environmentById(db, proj.default_environment_id).environment
        const ctx = environmentById(db, env.id)
        const preset = workspaceAgents[body.agent]

        if (!preset.runner) {
          invalid([
            {
              path: '/agent',
              message: `${preset.label} has no runner yet`,
            },
          ])
        }

        if (body.model !== undefined && !preset.models.some((model) => model.id === body.model)) {
          invalid([
            {
              path: '/model',
              message: `not a model of ${preset.label}`,
            },
          ])
        }

        requireKey(db, proj.id, body.agent)

        const title = titleOf(body.prompt)
        const branch = branchSlug(title)
        const model = body.model ?? preset.models[0]?.id ?? null
        let created: { id: string } | null = null

        for (let attempt = 0; !created; attempt += 1) {
          try {
            created = await createSandbox(
              call,
              ctx,
              {
                name: workspaceName(title),
                workspace: {
                  agent: body.agent,
                  repository: body.repository,
                  ...(body.base_branch
                    ? {
                        branch: body.base_branch,
                      }
                    : {}),
                  level: 'read',
                },
              },
              branch,
            )
          } catch (error) {
            if (
              !(error instanceof ApiError) ||
              error.code !== 'NAME_TAKEN' ||
              attempt + 1 >= nameAttempts
            ) {
              throw error
            }
          }
        }

        const id = newId('task')
        const now = new Date()

        db.transaction((tx) => {
          const tdb = tx as unknown as Db

          tdb
            .insert(task)
            .values({
              id,
              project_id: proj.id,
              environment_id: env.id,
              owner: {
                type: call.principal.actor.type,
                id: call.principal.actor.id,
              },
              title,
              repository: body.repository,
              base_branch: body.base_branch ?? null,
              branch,
              agent: body.agent,
              model,
              sandbox_id: created.id,
              created_at: now,
              updated_at: now,
            })
            .run()
          startConversation(
            tdb,
            id,
            {
              adapter: body.agent,
              model,
              prompt: body.prompt,
              actor: call.principal.actor,
            },
            now,
          )
          emitEvent(
            tdb,
            'task.created',
            taskSubject({
              id,
              project_id: proj.id,
              environment_id: env.id,
            }),
            {
              task: id,
            },
          )
          audit(
            tdb,
            call,
            'task.create',
            {
              entity: 'task',
              id,
            },
            {
              after: {
                title,
                repository: body.repository,
                branch,
                agent: body.agent,
                sandbox_id: created.id,
              },
            },
          )
        })

        set.status = 202

        return shown(taskById(db, id), call)
      },
      {
        operation: {
          id: 'create_task',
          summary:
            'Start a task: a workspace of its own, a branch and a first prompt; the agent starts once the workspace is set up. Needs a human actor',
          level: 'instance admin',
          mcp: false,
          cli: {
            path: ['tasks', 'create'],
          },
        },
        body: t.Object({
          project: t.String({
            description: 'The project, an id or a name',
          }),
          environment: t.Optional(
            t.String({
              description:
                "Where the task's workspace lives; the project's default environment by default",
            }),
          ),
          repository: t.String({
            description: 'An https git URL',
          }),
          base_branch: t.Optional(
            t.String({
              description: "The branch to start from; the repository's default branch by default",
            }),
          ),
          agent: t.UnionEnum([...workspaceAgentValues]),
          model: t.Optional(
            t.String({
              description: "One of the agent's models, default the first",
            }),
          ),
          prompt: t.String({
            minLength: 1,
            maxLength: agentPromptLimit,
          }),
        }),
        response: replies({
          202: Task,
        }),
      },
    )
    .get(
      '/tasks/:task',
      async ({ params, request }) => {
        const call = await kit.call(request)

        return shown(taskById(db, params.task), call)
      },
      {
        operation: {
          id: 'get_task',
          summary: 'A task with its status and setup; for an instance admin',
          level: 'instance admin',
          mcp: false,
          cli: {
            path: ['tasks', 'get'],
            args: ['task'],
          },
        },
        response: replies({
          200: Task,
        }),
      },
    )
    .get(
      '/tasks/:task/events',
      async ({ params, request, query }) => {
        const row = taskById(db, params.task)

        return (request.headers.get('accept') ?? '').includes('text/event-stream')
          ? ((await stream(row, request, query)) as never)
          : page(row, request, query)
      },
      {
        operation: {
          id: 'get_task_events',
          summary:
            'Events of every conversation of a task, for an instance admin; Accept: text/event-stream streams them, resuming after since or Last-Event-ID',
          level: 'instance admin',
          mcp: false,
          cli: {
            path: ['tasks', 'events'],
            args: ['task'],
          },
          stream: true,
        },
        query: eventsQuery,
        response: replies({
          200: AgentEventPage,
        }),
      },
    )
    .post(
      '/tasks/:task/prompts',
      async ({ params, request, body, set }) => {
        const call = await kit.call(request)

        requireHuman(call.principal, 'Sending a prompt to a task')

        const row = taskById(db, params.task)
        const session = latestConversation(db, row.id)

        if (!session || session.origin === 'terminal') {
          invalid([
            {
              path: '/task',
              message:
                'its conversation started in a terminal, so it has no process to take a prompt',
            },
          ])
        }

        wake(call, row, 'it cannot take a prompt')

        const stored = addInput(
          db,
          session!,
          {
            kind: 'prompt',
            text: body.text,
          },
          call.principal.actor,
        )

        if (!runnerLive(session!)) {
          wantRunner(db, session!.id)
        }

        set.status = 202

        return stored
      },
      {
        operation: {
          id: 'send_task_prompt',
          summary: 'Send the next prompt to a task; only a human actor may send one',
          level: 'instance admin',
          mcp: false,
          cli: {
            path: ['tasks', 'reply'],
            args: ['task'],
          },
        },
        body: t.Object({
          text: t.String({
            minLength: 1,
            maxLength: agentPromptLimit,
          }),
        }),
        response: replies({
          202: AgentInputAccepted,
        }),
      },
    )
    .post(
      '/tasks/:task/interrupt',
      async ({ params, request, set }) => {
        const call = await kit.call(request)

        requireHuman(call.principal, 'Interrupting a task')

        const row = taskById(db, params.task)
        const session = latestConversation(db, row.id)

        if (!session || !runnerLive(session)) {
          invalid([
            {
              path: '/task',
              message: 'has no live runner to interrupt',
            },
          ])
        }

        addInput(
          db,
          session!,
          {
            kind: 'interrupt',
            text: null,
          },
          call.principal.actor,
        )
        set.status = 202

        return {
          accepted: true,
        }
      },
      {
        operation: {
          id: 'interrupt_task',
          summary: "End the running turn of a task's agent; the task stays. Needs a human actor",
          level: 'instance admin',
          mcp: false,
          cli: {
            path: ['tasks', 'interrupt'],
            args: ['task'],
          },
        },
        response: replies({
          202: AgentInterruptAccepted,
        }),
      },
    )
    .delete(
      '/tasks/:task',
      async ({ params, request }) => {
        const call = await kit.call(request)

        requireHuman(call.principal, 'Deleting a task')

        const row = taskById(db, params.task)
        const box = db.select().from(sandbox).where(eq(sandbox.id, row.sandbox_id)).get()

        db.transaction((tx) => {
          const tdb = tx as unknown as Db

          tdb.delete(task).where(eq(task.id, row.id)).run()
          emitEvent(tdb, 'task.deleted', taskSubject(row), {
            task: row.id,
          })
          audit(
            tdb,
            call,
            'task.delete',
            {
              entity: 'task',
              id: row.id,
            },
            {
              before: {
                title: row.title,
                branch: row.branch,
                sandbox_id: row.sandbox_id,
              },
            },
          )
        })

        if (box) {
          requestDeletion(db, box, {
            actor: call.principal.actor,
            reason: 'user',
          })
          kit.deps.stations.reconcile(box.station_id)
        }

        return {
          deleted: true as const,
        }
      },
      {
        operation: {
          id: 'delete_task',
          summary:
            'Delete a task, its workspace and its conversations; the branch on GitHub stays. Needs a human actor',
          level: 'instance admin',
          mcp: false,
          cli: {
            path: ['tasks', 'delete'],
            args: ['task'],
          },
        },
        response: replies({
          200: TaskDeleted,
        }),
      },
    )
}
