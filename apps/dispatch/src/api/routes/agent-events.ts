import { eq } from 'drizzle-orm'
import { t } from 'elysia'

import {
  agentEventLimits,
  AgentEventsInput,
  AgentInboxAck,
  AgentRunnerExit,
} from '@stationly/protocol'

import {
  chargeTokenWindow,
  fixedWindow,
  rateLimited,
  type Principal,
} from '../../auth/principal.ts'
import { task } from '../../db/schema.ts'
import { log } from '../../log.ts'
import { ingestAgentEvents } from '../../tasks/events.ts'
import {
  ackInputs,
  conversationOf,
  inboxItems,
  runnerExited,
  touchRunner,
} from '../../tasks/runner.ts'
import { fail } from '../errors.ts'
import type { Kit } from '../kit.ts'
import type { SandboxRow } from '../lookup.ts'
import { input } from '../schemas.ts'
import {
  AgentEventsAccepted,
  AgentInbox,
  AgentInboxAcked,
  AgentRunnerExited,
  replies,
} from '../shapes.ts'

const inboxPollMs = 500

const maxInboxWaitS = 25

const budget = fixedWindow(agentEventLimits.requestsPerMinute)

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

export const agentEventRoutes = (kit: Kit) => {
  const { db } = kit.deps

  const taskOf = (row: SandboxRow) => {
    const found = db.select().from(task).where(eq(task.sandbox_id, row.id)).get()

    if (!found) {
      fail(
        'NOT_FOUND',
        `Workspace ${row.name} belongs to no task, so it takes no agent events.`,
        'Start the work as a task with create_task.',
        {
          sandbox_id: row.id,
        },
      )
    }

    return found!
  }

  return kit
    .router('sandboxes', '/v1')
    .get(
      '/sandboxes/:sandbox/agent/inbox',
      async ({ ctx, request, query }) => {
        const call = await kit.call(request)
        const row = ctx.sandbox

        requireWorkspaceToken(row, call.principal)

        const session = conversationOf(db, taskOf(row).id, query.session)

        if (!session) {
          return {
            items: [],
          }
        }

        const after = query.after ?? 0
        const deadline = Date.now() + Math.min(query.wait_s ?? 0, maxInboxWaitS) * 1000

        touchRunner(db, session.id)

        for (;;) {
          const items = inboxItems(db, session, after)

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
          acked: ackInputs(db, taskOf(ctx.sandbox).id, body.ids),
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
      '/sandboxes/:sandbox/agent/runner/exit',
      async ({ ctx, request, body, set }) => {
        const call = await kit.call(request)

        requireWorkspaceToken(ctx.sandbox, call.principal)

        const session = conversationOf(db, taskOf(ctx.sandbox).id, body.session)

        set.status = 202

        return {
          restarting: session ? runnerExited(db, session, body.failed ?? false) : false,
        }
      },
      {
        sandbox: {
          id: 'report_runner_exit',
          summary:
            "Report that a session's runner exited, so a prompt waiting for it starts the next one; only the workspace token is accepted",
          level: 'read',
          mcp: false,
          cli: false,
          deferTokenWindow: true,
        },
        body: input(AgentRunnerExit),
        response: replies({
          202: AgentRunnerExited,
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
          taskOf(row),
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
}
