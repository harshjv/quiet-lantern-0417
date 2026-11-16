import { and, eq, sql } from 'drizzle-orm'
import { t } from 'elysia'

import {
  agentEventLimits,
  AgentEventsInput,
  AgentInboxAck,
  AgentRunnerExit,
  type AgentEventInputValue,
} from '@stationly/protocol'

import {
  chargeTokenWindow,
  fixedWindow,
  rateLimited,
  type Principal,
} from '../../auth/principal.ts'
import { conversation, project, task, tool_approval } from '../../db/schema.ts'
import { log } from '../../log.ts'
import { approvalState, requestApproval } from '../../tasks/approvals.ts'
import { ingestAgentEvents } from '../../tasks/events.ts'
import { machineUserByToken, taskOnSandbox } from '../../tasks/machine.ts'
import { ackSandboxInputs, inboxItems, runnerExited, touchRunner } from '../../tasks/runner.ts'
import type { TaskRow } from '../../tasks/status.ts'
import { fail, invalid } from '../errors.ts'
import type { Kit } from '../kit.ts'
import type { SandboxRow } from '../lookup.ts'
import { input } from '../schemas.ts'
import {
  AgentApprovalRequest,
  AgentApprovalState,
  AgentEventsAccepted,
  AgentInbox,
  AgentInboxAcked,
  AgentRunnerExited,
  replies,
} from '../shapes.ts'

const inboxPollMs = 500

const maxInboxWaitS = 25

const budgets = new Map<number, ReturnType<typeof fixedWindow>>()

const budgetFor = (limit: number) => {
  const found = budgets.get(limit) ?? fixedWindow(limit)

  budgets.set(limit, found)

  return found
}

export const agentEventRoutes = (kit: Kit) => {
  const { db } = kit.deps

  const holderOf = (row: SandboxRow, principal: Principal) => {
    if (
      row.workspace &&
      row.workspace.kind !== 'project' &&
      principal.token_id === row.workspace.token_id
    ) {
      return {
        owner: null,
      }
    }

    const member = row.workspace ? machineUserByToken(db, row.id, principal.token_id) : undefined

    return member
      ? {
          owner: member.user_id,
        }
      : null
  }

  const requireWorkspaceToken = (row: SandboxRow, principal: Principal) => {
    const holder = holderOf(row, principal)

    if (!holder) {
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

    if (!holder) {
      fail(
        'FORBIDDEN_SCOPE',
        `Only the token of workspace ${row.name}, or of one of its members, may report its agent events.`,
        'Run the relay inside the workspace, where STATIONLY_TOKEN is that token.',
        {
          sandbox_id: row.id,
        },
      )
    }

    return holder!.owner
  }

  const ownedBy = (owner: string | null) =>
    owner === null ? undefined : sql`json_extract(${task.owner}, '$.id') = ${owner}`

  const limitOf = (row: SandboxRow) => {
    const slots =
      row.workspace?.kind === 'project'
        ? (db.select().from(project).where(eq(project.id, row.project_id)).get()?.machine?.slots ??
          1)
        : 1

    return agentEventLimits.requestsPerMinute + agentEventLimits.requestsPerExtraSlot * (slots - 1)
  }

  const approvalOnSandbox = (row: SandboxRow, id: string, owner: string | null) =>
    db
      .select({
        approval: tool_approval,
      })
      .from(tool_approval)
      .innerJoin(task, eq(task.id, tool_approval.task_id))
      .where(and(eq(task.sandbox_id, row.id), eq(tool_approval.id, id), ownedBy(owner)))
      .get()?.approval

  const sessionOf = (row: SandboxRow, agentSessionId: string, owner: string | null) =>
    db
      .select({
        session: conversation,
      })
      .from(conversation)
      .innerJoin(task, eq(task.id, conversation.task_id))
      .where(
        and(
          eq(task.sandbox_id, row.id),
          eq(conversation.agent_session_id, agentSessionId),
          ownedBy(owner),
        ),
      )
      .get()?.session ?? null

  const taskForEvent = (row: SandboxRow, event: AgentEventInputValue, owner: string | null) => {
    const session = sessionOf(row, event.session_id, owner)
    const found = session
      ? db.select().from(task).where(eq(task.id, session.task_id)).get()
      : taskOnSandbox(db, row.id, (event.data as { cwd?: string }).cwd)

    return found && (owner === null || found.owner.id === owner) ? found : null
  }

  return kit
    .router('sandboxes', '/v1')
    .get(
      '/sandboxes/:sandbox/agent/inbox',
      async ({ ctx, request, query }) => {
        const call = await kit.call(request)
        const row = ctx.sandbox

        const holder = requireWorkspaceToken(row, call.principal)
        const session = sessionOf(row, query.session, holder)

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

        const holder = requireWorkspaceToken(ctx.sandbox, call.principal)

        set.status = 202

        return {
          acked: ackSandboxInputs(db, ctx.sandbox.id, body.ids, holder),
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
      '/sandboxes/:sandbox/agent/approvals',
      async ({ ctx, request, body, set }) => {
        const call = await kit.call(request)

        const holder = requireWorkspaceToken(ctx.sandbox, call.principal)
        const session = sessionOf(ctx.sandbox, body.session_id, holder)
        const owner = session
          ? db.select().from(task).where(eq(task.id, session.task_id)).get()
          : null

        if (!session || !owner || session.origin !== 'dashboard') {
          fail(
            'NOT_FOUND',
            `Session ${body.session_id} is not a runner session of workspace ${ctx.sandbox.name}.`,
            'Only a task started from the dashboard asks for approvals here.',
            {
              sandbox_id: ctx.sandbox.id,
            },
          )
        }

        if (Buffer.byteLength(JSON.stringify(body.tool_input)) > agentEventLimits.raw) {
          invalid([
            {
              path: '/tool_input',
              message: `is over ${agentEventLimits.raw} bytes`,
            },
          ])
        }

        set.status = 201

        return approvalState(
          requestApproval(
            db,
            owner!,
            session!,
            body,
            kit.sandboxRedaction([ctx.sandbox.id], call.principal.actor, call.request_id),
          ),
        )
      },
      {
        sandbox: {
          id: 'request_tool_approval',
          summary:
            "Ask the task's owner to allow or deny a tool call of a runner session; only the workspace token is accepted",
          level: 'read',
          mcp: false,
          cli: false,
          deferTokenWindow: true,
        },
        body: input(AgentApprovalRequest),
        response: replies({
          201: AgentApprovalState,
        }),
      },
    )
    .get(
      '/sandboxes/:sandbox/agent/approvals/:approval',
      async ({ ctx, request, params, query }) => {
        const call = await kit.call(request)

        const holder = requireWorkspaceToken(ctx.sandbox, call.principal)
        const deadline = Date.now() + Math.min(query.wait_s ?? 0, maxInboxWaitS) * 1000

        for (;;) {
          const found = approvalOnSandbox(ctx.sandbox, params.approval, holder)

          if (!found) {
            fail(
              'NOT_FOUND',
              `Workspace ${ctx.sandbox.name} has no approval ${params.approval}.`,
              'Ask for it with request_tool_approval first.',
              {
                approval: params.approval,
              },
            )
          }

          if (found!.status !== 'pending' || Date.now() >= deadline || request.signal.aborted) {
            return approvalState(found!)
          }

          await new Promise((resolve) => setTimeout(resolve, inboxPollMs))
        }
      },
      {
        sandbox: {
          id: 'get_tool_approval',
          summary:
            'An approval of a runner session, waiting up to wait_s for a decision; only the workspace token is accepted',
          level: 'read',
          mcp: false,
          cli: false,
          deferTokenWindow: true,
        },
        query: t.Object({
          wait_s: t.Optional(
            t.Integer({
              minimum: 0,
              maximum: maxInboxWaitS,
            }),
          ),
        }),
        response: replies({
          200: AgentApprovalState,
        }),
      },
    )
    .post(
      '/sandboxes/:sandbox/agent/runner/exit',
      async ({ ctx, request, body, set }) => {
        const call = await kit.call(request)

        const holder = requireWorkspaceToken(ctx.sandbox, call.principal)
        const session = sessionOf(ctx.sandbox, body.session, holder)

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

        const holder = requireWorkspaceToken(row, call.principal)
        const limit = limitOf(row)
        const budget = budgetFor(limit)
        const retry = budget.retryAfter(row.id)

        if (retry !== null) {
          throw rateLimited(
            `This sandbox posted ${limit} agent event batches in the last minute, its limit.`,
            retry,
          )
        }

        budget.add(row.id)
        set.status = 202

        const redact = kit.sandboxRedaction([row.id], call.principal.actor, call.request_id)
        const groups = new Map<string, { row: TaskRow; events: AgentEventInputValue[] }>()
        const bySession = new Map<string, TaskRow>()
        let dropped = 0

        for (const event of body.events) {
          const owner = bySession.get(event.session_id) ?? taskForEvent(row, event, holder)

          if (!owner) {
            dropped += 1
            continue
          }

          const group = groups.get(owner.id) ?? {
            row: owner,
            events: [],
          }

          group.events.push(event)
          groups.set(owner.id, group)
          bySession.set(event.session_id, owner)
        }

        let accepted = 0
        let duplicates = dropped

        for (const group of groups.values()) {
          const result = ingestAgentEvents(db, group.row, group.events, redact, log)

          accepted += result.accepted
          duplicates += result.duplicates
        }

        return {
          accepted,
          duplicates,
        }
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
