import { eq } from 'drizzle-orm'
import { t } from 'elysia'

import {
  agentEventLimits,
  AgentEventsInput,
  AgentInboxAck,
  agentPromptLimit,
  workspaceAgents,
} from '@stationly/protocol'

import {
  chargeTokenWindow,
  fixedWindow,
  rateLimited,
  type Principal,
} from '../../auth/principal.ts'
import { station } from '../../db/schema.ts'
import { log } from '../../log.ts'
import {
  agentBus,
  agentEventsAfter,
  firstSessionEvent,
  ingestAgentEvents,
  newestSessionStart,
  shownAgentEvent,
  type AgentEventLive,
} from '../../sandboxes/agent-events.ts'
import {
  ackInputs,
  addInput,
  createRunnerSession,
  inboxItems,
  runnerLive,
  runnerSessionOf,
  touchRunner,
  wantRunner,
} from '../../sandboxes/agent-runner.ts'
import { filterStatuses, listAgentSessions } from '../../sandboxes/agent-sessions.ts'
import { startSandbox } from '../../sandboxes/lifecycle.ts'
import { variablesOf } from '../../secrets/values.ts'
import { requireHuman } from '../access.ts'
import { audit, type Call } from '../context.ts'
import { requireConnected } from '../deployments.ts'
import { fail, invalid } from '../errors.ts'
import type { Kit } from '../kit.ts'
import { sandboxById, type SandboxRow } from '../lookup.ts'
import { filterMany } from '../pagination.ts'
import { input } from '../schemas.ts'
import {
  AgentEventPage,
  AgentEventsAccepted,
  AgentInbox,
  AgentInboxAcked,
  AgentInputAccepted,
  AgentInterruptAccepted,
  AgentSession,
  AgentSessionPage,
  replies,
} from '../shapes.ts'
import { createSse } from '../sse.ts'

const inboxPollMs = 500

const maxInboxWaitS = 25

const drainSize = 200
const fallbackPollMs = 1000
const defaultPageSize = 100
const maxPageSize = 500

const budget = fixedWindow(agentEventLimits.requestsPerMinute)

const agentQuery = t.Object({
  since: t.Optional(
    t.String({
      description: 'Resume after this seq, the id of an event of this sandbox',
    }),
  ),
  session: t.Optional(
    t.String({
      description: 'Only the events of this Claude Code session',
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

type AgentQuery = typeof agentQuery.static

const holdsWorkspaceToken = (row: SandboxRow, principal: Principal) =>
  row.workspace !== null && principal.token_id === row.workspace.token_id

const requireWorkspaceToken = (row: SandboxRow, principal: Principal) => {
  if (!holdsWorkspaceToken(row, principal)) {
    chargeTokenWindow(principal)
  }

  if (!row.workspace) {
    fail(
      'NOT_FOUND',
      `Sandbox ${row.name} is not a workspace, so it takes no agent events.`,
      'Only a workspace reports its agent session.',
      {
        sandbox_id: row.id,
      },
    )
  }

  if (!holdsWorkspaceToken(row, principal)) {
    fail(
      'FORBIDDEN_SCOPE',
      `Only the token of workspace ${row.name} may report its agent events.`,
      'Run the relay inside the workspace, where STATIONLY_TOKEN is that token.',
      {
        sandbox_id: row.id,
      },
    )
  }
}

const cursorOf = (request: Request, query: AgentQuery) => {
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

export const agentEventRoutes = (kit: Kit) => {
  const { db } = kit.deps

  const wake = (call: Call, row: SandboxRow, refusal: string) => {
    if (row.status === 'stopped') {
      requireConnected(kit.deps, row.station_id)
      startSandbox(
        db,
        db.select().from(station).where(eq(station.id, row.station_id)).get()!,
        call.principal,
        row,
        null,
      )
      audit(
        db,
        call,
        'sandbox.start',
        {
          entity: 'sandbox',
          id: row.id,
        },
        {
          before: {
            status: row.status,
          },
        },
      )
      kit.deps.stations.reconcile(row.station_id)

      return
    }

    if (!['creating', 'starting', 'running'].includes(row.status)) {
      fail(
        'SANDBOX_NOT_RUNNING',
        `Workspace ${row.name} is ${row.status}, so ${refusal}.`,
        'Start the workspace with start_sandbox, then try again.',
        {
          status: row.status,
        },
      )
    }
  }

  const start = (sandboxId: string, since: number | undefined, session: string | undefined) => {
    if (since !== undefined) {
      return since
    }

    const first = session
      ? firstSessionEvent(db, sandboxId, session)
      : newestSessionStart(db, sandboxId)

    return Math.max(0, (first ?? 1) - 1)
  }

  const redactor = (row: SandboxRow, principal: Principal, requestId: string) => () =>
    kit.sandboxRedaction([row.id], principal.actor, requestId)

  const page = async (row: SandboxRow, request: Request, query: AgentQuery) => {
    const call = await kit.call(request)
    const since = start(row.id, cursorOf(request, query), query.session)
    const redact = redactor(row, call.principal, call.request_id)()
    const rows = agentEventsAfter(db, row.id, since, query.limit ?? defaultPageSize, query.session)

    return {
      items: rows.map((entry) => shownAgentEvent(entry, redact)),
      next_since: String(rows.at(-1)?.seq ?? since),
    }
  }

  const stream = async (row: SandboxRow, request: Request, query: AgentQuery) => {
    const call = await kit.call(request)
    const redact = redactor(row, call.principal, call.request_id)
    const sse = createSse(request.signal)
    let last = start(row.id, cursorOf(request, query), query.session)
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

          for (;;) {
            const batch = agentEventsAfter(db, row.id, last, drainSize, query.session)

            if (!batch.length) {
              break
            }

            for (const entry of batch) {
              last = entry.seq
              await sse.send(entry.type, shownAgentEvent(entry, masked), String(entry.seq))

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
    const wake = (sandboxId: string) => {
      if (sandboxId === row.id) {
        void drain()
      }
    }
    const part = (sandboxId: string, event: AgentEventLive) => {
      if (sandboxId === row.id && (!query.session || event.session_id === query.session)) {
        void sse.send(event.type, event)
      }
    }

    agentBus.on('stored', wake)
    agentBus.on('part', part)
    const poll = setInterval(() => wake(row.id), fallbackPollMs)

    sse.onClose(() => {
      agentBus.off('stored', wake)
      agentBus.off('part', part)
      clearInterval(poll)
    })
    void drain()

    return sse.response
  }

  return kit
    .router('sandboxes', '/v1')
    .get(
      '/agent-sessions',
      async ({ request, query }) => {
        const call = await kit.call(request)

        return listAgentSessions(db, {
          limit: query.limit ?? defaultPageSize,
          cursor: query.cursor,
          status: filterStatuses(query.status),
          workspace: query.workspace,
          redactor: (sandboxId) =>
            kit.sandboxRedaction([sandboxId], call.principal.actor, call.request_id),
        })
      },
      {
        operation: {
          id: 'list_agent_sessions',
          summary:
            'Agent sessions of every workspace, newest first, with status, attention kind and the first prompt as the title; for an instance admin',
          level: 'instance admin',
          mcp: false,
          cli: {
            path: ['sandboxes', 'sessions'],
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
          status: filterMany(['working', 'waiting', 'ready', 'failed', 'ended']),
          workspace: t.Optional(
            t.String({
              description: 'Only the sessions of this workspace, a sandbox id',
            }),
          ),
        }),
        response: replies({
          200: AgentSessionPage,
        }),
      },
    )
    .post(
      '/agent-sessions',
      async ({ request, body, set }) => {
        const call = await kit.call(request)

        requireHuman(call.principal, 'Starting an agent session')

        const row = sandboxById(db, body.workspace).sandbox
        const agent = row.workspace?.agent

        if (!agent) {
          invalid([
            {
              path: '/workspace',
              message: `${row.name} is not a workspace`,
            },
          ])
        }

        const preset = workspaceAgents[agent!]

        if (!preset.runner) {
          invalid([
            {
              path: '/workspace',
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

        const keys = new Set(
          variablesOf(db, {
            scope: 'project',
            id: row.project_id,
          })
            .all()
            .map((variable) => variable.key),
        )

        if (!preset.keys.some((key) => keys.has(key))) {
          invalid([
            {
              path: '/workspace',
              message: `the project defines none of ${preset.keys.join(', ')} for ${preset.label}`,
            },
          ])
        }

        wake(call, row, 'no session can start in it')

        const session = createRunnerSession(db, row, {
          model: body.model ?? preset.models[0]?.id ?? null,
          prompt: body.prompt,
          actor: call.principal.actor,
        })

        set.status = 202

        return listAgentSessions(db, {
          limit: 200,
          cursor: undefined,
          status: null,
          workspace: row.id,
          redactor: (sandboxId) =>
            kit.sandboxRedaction([sandboxId], call.principal.actor, call.request_id),
        }).items.find((item) => item.session_id === session)!
      },
      {
        operation: {
          id: 'create_agent_session',
          summary:
            'Start an agent session in a workspace from a first prompt; the runner starts once the workspace is running and set up. Needs a human actor',
          level: 'instance admin',
          mcp: false,
          cli: {
            path: ['sandboxes', 'ask'],
          },
        },
        body: t.Object({
          workspace: t.String({
            description: 'The workspace, a sandbox id, running or still being set up',
          }),
          prompt: t.String({
            minLength: 1,
            maxLength: agentPromptLimit,
          }),
          model: t.Optional(
            t.String({
              description: "One of the agent's models, default the first",
            }),
          ),
        }),
        response: replies({
          202: AgentSession,
        }),
      },
    )
    .post(
      '/sandboxes/:sandbox/agent/sessions/:session/prompts',
      async ({ params, request, body, set }) => {
        const call = await kit.call(request)

        requireHuman(call.principal, 'Sending a prompt to an agent session')

        const row = sandboxById(db, params.sandbox).sandbox
        const session = runnerSessionOf(db, row.id, params.session)

        if (!session) {
          invalid([
            {
              path: '/session',
              message: 'not a session Stationly started, so it has no process to take a prompt',
            },
          ])
        }

        wake(call, row, 'its session cannot take a prompt')

        const stored = addInput(
          db,
          row.id,
          params.session,
          {
            kind: 'prompt',
            text: body.text,
          },
          call.principal.actor,
        )

        if (!runnerLive(session!)) {
          wantRunner(db, row.id, params.session)
        }

        set.status = 202

        return stored
      },
      {
        operation: {
          id: 'send_agent_prompt',
          summary:
            'Send the next prompt to a session Stationly started; only a human actor may send one',
          level: 'instance admin',
          mcp: false,
          cli: {
            path: ['sandboxes', 'reply'],
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
      '/sandboxes/:sandbox/agent/sessions/:session/interrupt',
      async ({ params, request, set }) => {
        const call = await kit.call(request)

        requireHuman(call.principal, 'Interrupting an agent session')

        const row = sandboxById(db, params.sandbox).sandbox
        const session = runnerSessionOf(db, row.id, params.session)

        if (!session || !runnerLive(session)) {
          invalid([
            {
              path: '/session',
              message: 'has no live runner to interrupt',
            },
          ])
        }

        addInput(
          db,
          row.id,
          params.session,
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
          id: 'interrupt_agent_session',
          summary:
            'End the running turn of a session Stationly started; the workspace stays. Needs a human actor',
          level: 'instance admin',
          mcp: false,
          cli: {
            path: ['sandboxes', 'interrupt'],
          },
        },
        response: replies({
          202: AgentInterruptAccepted,
        }),
      },
    )
    .get(
      '/sandboxes/:sandbox/agent/inbox',
      async ({ ctx, request, query }) => {
        const call = await kit.call(request)
        const row = ctx.sandbox

        requireWorkspaceToken(row, call.principal)

        const after = query.after ?? 0
        const deadline = Date.now() + Math.min(query.wait_s ?? 0, maxInboxWaitS) * 1000

        for (;;) {
          touchRunner(db, row.id, query.session)

          const items = inboxItems(db, row.id, query.session, after)

          if (items.length || Date.now() >= deadline || request.signal.aborted) {
            return {
              items: items.map((item) => ({
                id: item.id,
                seq: item.seq,
                kind: item.kind,
                text: item.text,
              })),
            }
          }

          await new Promise((resolve) => setTimeout(resolve, inboxPollMs))
        }
      },
      {
        sandbox: {
          id: 'get_agent_inbox',
          summary:
            "The operator's undelivered prompts and interrupts for a session, waiting up to wait_s; only the workspace token is accepted",
          level: 'read',
          mcp: false,
          cli: false,
          deferTokenWindow: true,
        },
        query: t.Object({
          session: t.String(),
          after: t.Optional(
            t.Integer({
              minimum: 0,
            }),
          ),
          wait_s: t.Optional(
            t.Integer({
              minimum: 0,
              maximum: maxInboxWaitS,
            }),
          ),
        }),
        response: replies({
          200: AgentInbox,
        }),
      },
    )
    .post(
      '/sandboxes/:sandbox/agent/inbox/ack',
      async ({ ctx, request, body, set }) => {
        const call = await kit.call(request)

        requireWorkspaceToken(ctx.sandbox, call.principal)
        set.status = 202

        return {
          acked: ackInputs(db, ctx.sandbox.id, body.ids),
        }
      },
      {
        sandbox: {
          id: 'ack_agent_inbox',
          summary:
            'Mark inbox items as delivered to the agent process; only the workspace token is accepted',
          level: 'read',
          mcp: false,
          cli: false,
          deferTokenWindow: true,
        },
        body: input(AgentInboxAck),
        response: replies({
          202: AgentInboxAcked,
        }),
      },
    )
    .post(
      '/sandboxes/:sandbox/agent/events',
      async ({ ctx, request, body, set }) => {
        const call = await kit.call(request)
        const row = ctx.sandbox

        requireWorkspaceToken(row, call.principal)

        const retry = budget.retryAfter(row.id)

        if (retry !== null) {
          throw rateLimited(
            `This sandbox posted ${agentEventLimits.requestsPerMinute} agent event batches in the last minute, its limit.`,
            retry,
          )
        }

        budget.add(row.id)
        set.status = 202

        return ingestAgentEvents(
          db,
          row,
          body.events,
          kit.sandboxRedaction([row.id], call.principal.actor, call.request_id),
          log,
        )
      },
      {
        sandbox: {
          id: 'post_agent_events',
          summary:
            'Report events of the agent session in a workspace; only the workspace token is accepted',
          level: 'read',
          mcp: false,
          cli: false,
          deferTokenWindow: true,
        },
        body: input(AgentEventsInput),
        response: replies({
          202: AgentEventsAccepted,
        }),
      },
    )
    .get(
      '/sandboxes/:sandbox/agent/events',
      async ({ params, request, query }) => {
        const row = sandboxById(db, params.sandbox).sandbox

        return (request.headers.get('accept') ?? '').includes('text/event-stream')
          ? ((await stream(row, request, query)) as never)
          : page(row, request, query)
      },
      {
        operation: {
          id: 'get_agent_events',
          summary:
            "Events of a workspace's agent session, for an instance admin; Accept: text/event-stream streams them, resuming after since or Last-Event-ID",
          level: 'instance admin',
          mcp: false,
          cli: {
            path: ['sandboxes', 'agent'],
          },
          stream: true,
        },
        query: agentQuery,
        response: replies({
          200: AgentEventPage,
        }),
      },
    )
}
