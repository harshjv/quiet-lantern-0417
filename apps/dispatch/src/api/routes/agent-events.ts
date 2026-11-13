import { t } from 'elysia'

import { agentEventLimits, AgentEventsInput } from '@stationly/protocol'

import {
  chargeTokenWindow,
  fixedWindow,
  rateLimited,
  type Principal,
} from '../../auth/principal.ts'
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
import { fail, invalid } from '../errors.ts'
import type { Kit } from '../kit.ts'
import { sandboxById, type SandboxRow } from '../lookup.ts'
import { input } from '../schemas.ts'
import { AgentEventPage, AgentEventsAccepted, replies } from '../shapes.ts'
import { createSse } from '../sse.ts'

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
