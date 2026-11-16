import { randomBytes } from 'node:crypto'

import type { Static } from '@sinclair/typebox'
import { desc, eq } from 'drizzle-orm'
import { t } from 'elysia'

import {
  agentPromptLimit,
  SandboxCreateBody,
  taskMachineValues,
  taskSlotMemoryBytes,
  taskSlotsDefault,
  workspaceAgents,
  workspaceAgentValues,
  type TaskMachineValue,
} from '@stationly/protocol'

import type { Principal } from '../../auth/principal.ts'
import { fullAdmin, isInstanceAdmin } from '../../auth/scopes.ts'
import type { Db } from '../../db/client.ts'
import { newId } from '../../db/ids.ts'
import { project, sandbox, ship_request, station, task } from '../../db/schema.ts'
import { requestDeletion, startSandbox } from '../../sandboxes/lifecycle.ts'
import { requireRepositoryAccess } from '../../sandboxes/repository-access.ts'
import { isRepositoryName, repositoryName } from '../../sandboxes/workspace.ts'
import { ephemeralDelivery } from '../../secrets/deliver.ts'
import { variablesOf } from '../../secrets/values.ts'
import { emitEvent } from '../../station/events.ts'
import { approvalOf, approvalState, decideApproval } from '../../tasks/approvals.ts'
import {
  agentBus,
  firstConversationEvent,
  sessionIds,
  shownTaskEvent,
  taskEventsAfter,
  type AgentEventLive,
} from '../../tasks/events.ts'
import {
  claimSlot,
  freeSlots,
  homeOf,
  machineSetupRerun,
  machineUserFor,
  nextPort,
  projectMachine,
  removeWorktree,
  resumeTask,
  slotsFor,
  stopTask,
  worktreeOf,
} from '../../tasks/machine.ts'
import { previewAddress } from '../../tasks/preview.ts'
import {
  addInput,
  conversationById,
  latestConversation,
  runnerLive,
  startConversation,
  wantRunner,
} from '../../tasks/runner.ts'
import { decideShip, shipView, startShip } from '../../tasks/ship.ts'
import { taskChanged, taskSubject, type TaskRow } from '../../tasks/status.ts'
import { branchSlug, listTasks, taskItem, titleOf, uniqueBranch } from '../../tasks/views.ts'
import { githubTokenOf, listKeys } from '../../team/keys.ts'
import { memberLevel } from '../../team/members.ts'
import { requireHuman, requireLevel, seesProject } from '../access.ts'
import { audit, type Call } from '../context.ts'
import { requireConnected } from '../deployments.ts'
import { ApiError, fail, invalid, notFound } from '../errors.ts'
import type { Kit } from '../kit.ts'
import { environmentById, environmentInProject, projectByRef } from '../lookup.ts'
import {
  AgentApprovalState,
  AgentEventPage,
  AgentInputAccepted,
  AgentInterruptAccepted,
  replies,
  ShipRequest,
  ShipRequestList,
  Task,
  TaskDeleted,
  TaskPage,
  TaskPreview,
} from '../shapes.ts'
import { createSse } from '../sse.ts'

import { deployPreview, removePreview } from './task-preview.ts'

type CreateSandbox = (
  call: Call,
  ctx: ReturnType<typeof environmentById>,
  body: Static<typeof SandboxCreateBody>,
  options?: {
    taskBranch?: string | null
    kind?: TaskMachineValue
    memoryBytes?: number
    repositoryReadable?: boolean
  },
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

const onBehalf = (call: Call): Call => ({
  ...call,
  principal: {
    ...call.principal,
    scopes: fullAdmin,
  },
})

const taskById = (db: Db, id: string) =>
  db.select().from(task).where(eq(task.id, id)).get() ?? notFound('task', id)

const requireKey = (
  db: Db,
  projectId: string,
  agent: keyof typeof workspaceAgents,
  userId: string,
) => {
  const preset = workspaceAgents[agent]
  const keys = new Set(
    variablesOf(db, {
      scope: 'project',
      id: projectId,
    })
      .all()
      .map((variable) => variable.key),
  )

  for (const own of listKeys(db, userId)) {
    if (own.set) {
      keys.add(own.name)
    }
  }

  if (!preset.keys.some((key) => keys.has(key))) {
    invalid([
      {
        path: '/agent',
        message: `neither you nor the project has ${preset.keys.join(' or ')} for ${preset.label}`,
      },
    ])
  }
}

export const taskRoutes = (kit: Kit, createSandbox: CreateSandbox) => {
  const { db } = kit.deps

  const redactor = (row: TaskRow, principal: Principal, requestId: string) => () =>
    kit.sandboxRedaction([row.sandbox_id], principal.actor, requestId)

  const personOf = (principal: Principal) =>
    principal.token_kind === 'session' || principal.token_kind === 'personal'
      ? principal.user_id
      : null

  const sees = (principal: Principal, row: Pick<TaskRow, 'owner' | 'project_id'>) =>
    isInstanceAdmin(principal.scopes) ||
    (personOf(principal) !== null &&
      row.owner.id === personOf(principal) &&
      seesProject(principal, row.project_id))

  const visibleTask = (call: Call, id: string) => {
    const row = taskById(db, id)

    if (!sees(call.principal, row)) {
      notFound('task', id)
    }

    return row
  }

  const shown = (row: TaskRow, call: Call) =>
    taskItem(
      db,
      db.select().from(task).where(eq(task.id, row.id)).get()!,
      redactor(row, call.principal, call.request_id)(),
    )

  const wake = (call: Call, row: TaskRow, refusal: string) => {
    const box = db.select().from(sandbox).where(eq(sandbox.id, row.sandbox_id)).get()

    return wakeBox(call, box, `task ${row.title}`, refusal)
  }

  const wakeBox = (
    call: Call,
    box: typeof sandbox.$inferSelect | undefined,
    owner: string,
    refusal: string,
  ) => {
    if (!box) {
      fail(
        'SANDBOX_NOT_RUNNING',
        `The workspace of ${owner} is gone, so ${refusal}.`,
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

      return true
    }

    if (!['creating', 'starting', 'running'].includes(box!.status)) {
      fail(
        'SANDBOX_NOT_RUNNING',
        `The workspace of ${owner} is ${box!.status}, so ${refusal}.`,
        'Start a new task.',
        {
          status: box!.status,
        },
      )
    }

    return false
  }

  const createMachine = async (
    call: Call,
    ctx: ReturnType<typeof environmentById>,
    proj: typeof project.$inferSelect,
    body: { agent: (typeof workspaceAgentValues)[number]; repository: string },
    readable: boolean,
  ) => {
    const names = [
      proj.name,
      `${proj.name}-tasks`,
      `${proj.name}-${randomBytes(2).toString('hex')}`,
    ]
    let created: { id: string } | null = null

    for (const [attempt, name] of names.entries()) {
      try {
        created = await createSandbox(
          call,
          ctx,
          {
            name,
            workspace: {
              agent: body.agent,
              repository: body.repository,
              level: 'read',
            },
          },
          {
            kind: 'project',
            memoryBytes: taskSlotsDefault * taskSlotMemoryBytes,
            repositoryReadable: readable,
          },
        )
        break
      } catch (error) {
        if (
          !(error instanceof ApiError) ||
          error.code !== 'NAME_TAKEN' ||
          attempt + 1 >= names.length
        ) {
          throw error
        }
      }
    }

    const box = db.select().from(sandbox).where(eq(sandbox.id, created!.id)).get()!

    db.update(project)
      .set({
        machine: {
          slots: Math.min(taskSlotsDefault, slotsFor(box.size.memory_bytes)),
          sandbox_id: box.id,
        },
      })
      .where(eq(project.id, proj.id))
      .run()

    return box
  }

  const machineFor = async (
    call: Call,
    ctx: ReturnType<typeof environmentById>,
    proj: typeof project.$inferSelect,
    body: { agent: (typeof workspaceAgentValues)[number]; repository: string },
    readable: boolean,
  ) => {
    const found = projectMachine(db, proj)

    if (!found) {
      return createMachine(call, ctx, proj, body, readable)
    }

    if (!isRepositoryName(repositoryName(body.repository))) {
      invalid([
        {
          path: '/repository',
          message: 'the last path segment, without .git, needs at least one letter or digit',
        },
      ])
    }

    if (!readable) {
      await requireRepositoryAccess(kit.deps, {
        project: proj,
        environment: ctx.environment.id,
        repository: body.repository,
        variables: undefined,
      })
    }

    wakeBox(call, found, `project ${proj.name}`, 'it cannot start a task')
    machineSetupRerun(db, found)
    kit.deps.stations.reconcile(found.station_id)

    return db.select().from(sandbox).where(eq(sandbox.id, found.id)).get()!
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

        const page = listTasks(db, {
          owner: isInstanceAdmin(call.principal.scopes) ? null : (personOf(call.principal) ?? ''),
          limit: query.limit ?? defaultPageSize,
          cursor: query.cursor,
          archived: query.archived ?? false,
          redactor: (sandboxId) =>
            kit.sandboxRedaction([sandboxId], call.principal.actor, call.request_id),
        })

        return {
          ...page,
          items: page.items.filter((item) =>
            sees(call.principal, {
              owner: item.owner,
              project_id: item.project.id,
            }),
          ),
        }
      },
      {
        operation: {
          id: 'list_tasks',
          summary: 'Tasks, newest first, with their status and setup; for an instance admin',
          level: 'any',
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
        const onProject = (body.machine ?? 'project') === 'project'
        const env = body.environment
          ? environmentInProject(db, proj, body.environment)
          : environmentById(db, proj.default_environment_id).environment

        requireLevel(
          call.principal,
          {
            project_id: proj.id,
            environment_id: env.id,
          },
          memberLevel,
        )

        const actingCall = onBehalf(call)
        const ownToken = await githubTokenOf(kit.deps.auth, db, call.principal.user_id)
        const readable =
          !!ownToken && (await kit.deps.readRepository(body.repository, ownToken)) === 'readable'

        if (onProject && env.id !== proj.default_environment_id) {
          invalid([
            {
              path: '/environment',
              message:
                "a task on the project machine runs in the project's default environment; ask for machine own to use another",
            },
          ])
        }

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

        requireKey(db, proj.id, body.agent, call.principal.user_id)

        const title = titleOf(body.prompt)
        const branch = uniqueBranch(db, body.repository, branchSlug(title))
        const model = body.model ?? preset.models[0]?.id ?? null
        const id = newId('task')
        let created: { id: string } | null = onProject
          ? await machineFor(actingCall, ctx, proj, body, readable)
          : null
        const port = onProject ? nextPort(db, created!.id) : null

        if (onProject && port === null) {
          invalid([
            {
              path: '/machine',
              message: `the machine of project ${proj.name} has no free port for another task; delete finished tasks or ask for machine own`,
            },
          ])
        }

        const queued =
          onProject &&
          freeSlots(db, db.select().from(sandbox).where(eq(sandbox.id, created!.id)).get()!) <= 0

        for (let attempt = 0; !created; attempt += 1) {
          try {
            created = await createSandbox(
              actingCall,
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
              {
                taskBranch: branch,
                repositoryReadable: readable,
              },
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

        const member = onProject
          ? await machineUserFor(
              db,
              kit.deps,
              db.select().from(sandbox).where(eq(sandbox.id, created.id)).get()!,
              call.principal.user_id,
            )
          : null
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
              machine: onProject ? 'project' : 'own',
              worktree: member ? worktreeOf(branch, id, homeOf(member.name)) : null,
              port,
              status: queued ? 'queued' : 'setting_up',
              queued_at: queued ? now : null,
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
                machine: onProject ? 'project' : 'own',
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
          level: 'any',
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
          machine: t.Optional(
            t.UnionEnum([...taskMachineValues], {
              description:
                "project (the default) runs the task on the project's shared machine in its own worktree; own gives it a machine of its own",
            }),
          ),
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

        return shown(visibleTask(call, params.task), call)
      },
      {
        operation: {
          id: 'get_task',
          summary: 'A task with its status and setup; for an instance admin',
          level: 'any',
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
        const row = visibleTask(await kit.call(request), params.task)

        return (request.headers.get('accept') ?? '').includes('text/event-stream')
          ? ((await stream(row, request, query)) as never)
          : page(row, request, query)
      },
      {
        operation: {
          id: 'get_task_events',
          summary:
            'Events of every conversation of a task, for an instance admin; Accept: text/event-stream streams them, resuming after since or Last-Event-ID',
          level: 'any',
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

        const row = visibleTask(call, params.task)
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

        const woke = wake(call, row, 'it cannot take a prompt')

        const stored = addInput(
          db,
          session!,
          {
            kind: 'prompt',
            text: body.text,
          },
          call.principal.actor,
        )

        const idle =
          woke || row.status === 'stopped' || row.status === 'finished' || row.status === 'failed'

        if (row.status === 'queued') {
          set.status = 202

          return stored
        }

        if (idle) {
          if (claimSlot(db, row)) {
            resumeTask(db, row)
          }
        } else if (!runnerLive(session!)) {
          wantRunner(db, session!.id)
        }

        set.status = 202

        return stored
      },
      {
        operation: {
          id: 'send_task_prompt',
          summary: 'Send the next prompt to a task; only a human actor may send one',
          level: 'any',
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
      '/tasks/:task/approvals/:approval/decision',
      async ({ params, request, body }) => {
        const call = await kit.call(request)

        requireHuman(call.principal, 'Deciding a tool approval')

        const row = visibleTask(call, params.task)
        const approval =
          approvalOf(db, row.id, params.approval) ?? notFound('approval', params.approval)
        const session = conversationById(db, approval.conversation_id)
        const decided = decideApproval(
          db,
          approval,
          session ?? {
            agent_session_id: '',
          },
          {
            behavior: body.decision,
            message: body.message ?? null,
          },
          call.principal.actor,
          redactor(row, call.principal, call.request_id)(),
        )

        audit(
          db,
          call,
          'task.approval.decide',
          {
            entity: 'task',
            id: row.id,
          },
          {
            after: {
              approval: approval.id,
              tool: approval.tool_name,
              decision: body.decision,
            },
          },
        )

        return approvalState(decided)
      },
      {
        operation: {
          id: 'decide_tool_approval',
          summary: "Allow or deny a tool call the task's agent asked for; needs a human actor",
          level: 'any',
          mcp: false,
          cli: {
            path: ['tasks', 'decide'],
            args: ['task', 'approval'],
          },
        },
        body: t.Object({
          decision: t.UnionEnum(['allow', 'deny']),
          message: t.Optional(
            t.String({
              maxLength: 2000,
              description: 'For a deny: the reason the agent reads',
            }),
          ),
        }),
        response: replies({
          200: AgentApprovalState,
        }),
      },
    )
    .post(
      '/tasks/:task/preview',
      async ({ params, request, set }) => {
        const call = await kit.call(request)

        requireHuman(call.principal, 'Making a preview')

        const row = visibleTask(call, params.task)
        const deployed = await deployPreview(kit, onBehalf(call), row)

        audit(
          db,
          call,
          'task.preview',
          {
            entity: 'task',
            id: row.id,
          },
          {
            after: {
              environment: deployed.environment.id,
              run_id: deployed.run_id,
            },
          },
        )
        set.status = 202

        return {
          ...deployed,
          url: previewAddress(db, deployed.environment.id),
        }
      },
      {
        operation: {
          id: 'deploy_task_preview',
          summary:
            "Deploy a task's worktree into its own preview environment, made the first time; needs a human, the task's owner or an admin",
          level: 'any',
          mcp: false,
          cli: {
            path: ['tasks', 'preview'],
            args: ['task'],
          },
        },
        response: replies({
          202: TaskPreview,
        }),
      },
    )
    .post(
      '/tasks/:task/ship',
      async ({ params, request, set }) => {
        const call = await kit.call(request)

        requireHuman(call.principal, 'Shipping a task')

        const row = visibleTask(call, params.task)
        const shipped = await startShip(
          {
            db,
            github: kit.deps.github,
            deliver: async (station, runId, entries) => {
              await kit.deps.stations.ask(
                station,
                'secrets.deliver',
                ephemeralDelivery(
                  {
                    run_id: runId,
                  },
                  'run',
                  entries,
                ),
              )
            },
            reconcile: (station) => kit.deps.stations.reconcile(station),
          },
          row,
          call.principal.user_id,
        )

        audit(
          db,
          call,
          'task.ship',
          {
            entity: 'task',
            id: row.id,
          },
          {
            after: {
              ship_request: shipped.id,
              run_id: shipped.run_id,
            },
          },
        )
        set.status = 202

        return shipView(db, shipped)
      },
      {
        operation: {
          id: 'ship_task',
          summary:
            "Push a task's branch, open its pull request and ask an admin to merge it; needs a human, the task's owner or an admin",
          level: 'any',
          mcp: false,
          cli: {
            path: ['tasks', 'ship'],
            args: ['task'],
          },
        },
        response: replies({
          202: ShipRequest,
        }),
      },
    )
    .get(
      '/ship-requests',
      async ({ request }) => {
        const call = await kit.call(request)
        const admin = isInstanceAdmin(call.principal.scopes)

        return {
          items: db
            .select()
            .from(ship_request)
            .where(eq(ship_request.status, 'pending'))
            .orderBy(desc(ship_request.created_at))
            .all()
            .filter((entry) => admin || entry.requested_by === call.principal.user_id)
            .map((entry) => shipView(db, entry)),
        }
      },
      {
        operation: {
          id: 'list_ship_requests',
          summary: 'List ship requests waiting for a decision; admins see all, others their own',
          level: 'any',
          mcp: false,
          cli: {
            path: ['ship-requests', 'list'],
          },
        },
        response: replies({
          200: ShipRequestList,
        }),
      },
    )
    .post(
      '/ship-requests/:request/decision',
      async ({ params, request, body }) => {
        const call = await kit.call(request)

        requireHuman(call.principal, 'Deciding a ship request')

        if (!isInstanceAdmin(call.principal.scopes)) {
          throw new ApiError(
            'FORBIDDEN_SCOPE',
            'Only an admin approves shipping to production.',
            'Ask an admin to decide.',
            {
              required: fullAdmin[0],
            },
          )
        }

        const found = db
          .select()
          .from(ship_request)
          .where(eq(ship_request.id, params.request))
          .get()

        if (!found) {
          notFound('ship request', params.request)
        }

        await decideShip(
          {
            db,
            github: kit.deps.github,
          },
          found!,
          {
            approve: body.decision === 'approve',
            reason: body.reason ?? null,
          },
          call.principal.user_id,
        )
        audit(
          db,
          call,
          'ship.decide',
          {
            entity: 'task',
            id: found!.task_id,
          },
          {
            after: {
              ship_request: found!.id,
              decision: body.decision,
            },
          },
        )

        return shipView(
          db,
          db.select().from(ship_request).where(eq(ship_request.id, found!.id)).get()!,
        )
      },
      {
        operation: {
          id: 'decide_ship_request',
          summary:
            'Approve a ship request, which merges its pull request and deploys production, or reject it with a reason; an admin and a human',
          level: 'any',
          mcp: false,
          cli: {
            path: ['ship-requests', 'decide'],
            args: ['request'],
          },
        },
        body: t.Object(
          {
            decision: t.Union([t.Literal('approve'), t.Literal('reject')]),
            reason: t.Optional(
              t.String({
                maxLength: 2000,
              }),
            ),
          },
          {
            additionalProperties: false,
          },
        ),
        response: replies({
          200: ShipRequest,
        }),
      },
    )
    .post(
      '/tasks/:task/interrupt',
      async ({ params, request, set }) => {
        const call = await kit.call(request)

        requireHuman(call.principal, 'Interrupting a task')

        const row = visibleTask(call, params.task)
        const session = latestConversation(db, row.id)

        if (row.status === 'queued') {
          db.update(task)
            .set({
              status: 'stopped',
              queued_at: null,
            })
            .where(eq(task.id, row.id))
            .run()
          taskChanged(db, row)
          set.status = 202

          return {
            accepted: true,
          }
        }

        if (
          session &&
          !runnerLive(session) &&
          (row.status === 'working' || row.status === 'setting_up' || row.status === 'waiting')
        ) {
          stopTask(db, row)
          set.status = 202

          return {
            accepted: true,
          }
        }

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
          level: 'any',
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

        const row = visibleTask(call, params.task)
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

        removePreview(kit, onBehalf(call), row)

        if (box && row.machine === 'project') {
          removeWorktree(db, row, (station) => kit.deps.stations.reconcile(station))
        } else if (box) {
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
          level: 'any',
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
