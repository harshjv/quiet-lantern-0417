import { randomUUID } from 'node:crypto'

import type { Static } from '@sinclair/typebox'
import { and, eq, lt } from 'drizzle-orm'

import {
  agentEventLimits,
  toolApprovalWaitS,
  type Actor,
  type AgentApprovalRequest,
  type AgentApprovalState,
} from '@stationly/protocol'

import { fail } from '../api/errors.ts'
import type { Redactor } from '../api/redaction.ts'
import type { Db } from '../db/client.ts'
import { conversation, task, tool_approval } from '../db/schema.ts'
import type { Log } from '../log.ts'
import { every } from '../schedule.ts'

import { recordEvents } from './events.ts'
import type { ConversationRow } from './runner.ts'
import type { TaskRow } from './status.ts'

type ApprovalRow = typeof tool_approval.$inferSelect
type ActorValue = Static<typeof Actor>

export const approvalState = (row: ApprovalRow): Static<typeof AgentApprovalState> => ({
  id: row.id,
  status: row.status,
  behavior: row.decision?.behavior ?? null,
  message: row.decision?.message ?? null,
  expires_at: row.expires_at.toISOString(),
})

export const approvalOf = (db: Db, taskId: string, id: string) =>
  db
    .select()
    .from(tool_approval)
    .where(and(eq(tool_approval.task_id, taskId), eq(tool_approval.id, id)))
    .get()

const event = (
  session: Pick<ConversationRow, 'agent_session_id'>,
  type: 'approval.requested' | 'approval.decided',
  data: Record<string, unknown>,
  agentId: string | null,
  now: Date,
) => ({
  id: `${type}:${randomUUID()}`,
  type,
  at: now.toISOString(),
  session_id: session.agent_session_id,
  ...(agentId
    ? {
        agent_id: agentId,
      }
    : {}),
  data,
})

const sessionOf = (db: Db, approval: ApprovalRow) =>
  db.select().from(conversation).where(eq(conversation.id, approval.conversation_id)).get() ?? null

const shownLimit = agentEventLimits.string

const shownInput = (input: Record<string, unknown>, redact: Redactor) => {
  let truncated = false
  const shown = Object.fromEntries(
    Object.entries(input).map(([key, value]) => {
      const text = redact(typeof value === 'string' ? value : JSON.stringify(value))
      const cut = Array.from(text).slice(0, shownLimit).join('')

      truncated ||= cut !== text

      return [key, typeof value === 'string' || cut !== text ? cut : (JSON.parse(cut) as unknown)]
    }),
  )

  return {
    shown,
    truncated,
  }
}

export const closePendingApprovals = (db: Db, taskId: string, now = new Date()) => {
  for (const approval of db
    .select()
    .from(tool_approval)
    .where(and(eq(tool_approval.task_id, taskId), eq(tool_approval.status, 'pending')))
    .all()) {
    const session = sessionOf(db, approval)

    if (session) {
      close(db, approval, 'expired', {
        by: null,
        message: null,
        session,
        redact: (text) => text,
        now,
      })
    }
  }
}

export const requestApproval = (
  db: Db,
  row: TaskRow,
  session: ConversationRow,
  body: Static<typeof AgentApprovalRequest>,
  redact: Redactor,
  now = new Date(),
) => {
  const found = approvalOf(db, row.id, body.id)

  if (found) {
    return found
  }

  const expires = new Date(now.getTime() + toolApprovalWaitS * 1000)
  const { shown, truncated } = shownInput(body.tool_input, redact)

  db.insert(tool_approval)
    .values({
      task_id: row.id,
      id: body.id,
      conversation_id: session.id,
      agent_id: body.agent_id ?? null,
      tool_name: body.tool_name,
      tool_input: shown,
      created_at: now,
      expires_at: expires,
    })
    .run()
  recordEvents(
    db,
    row,
    [
      event(
        session,
        'approval.requested',
        {
          approval_id: body.id,
          tool: body.tool_name,
          input: shown,
          expires_at: expires.toISOString(),
          ...(truncated
            ? {
                truncated,
              }
            : {}),
        },
        body.agent_id ?? null,
        now,
      ),
    ],
    redact,
  )

  return approvalOf(db, row.id, body.id)!
}

const close = (
  db: Db,
  approval: ApprovalRow,
  status: 'allowed' | 'denied' | 'expired',
  options: {
    by: ActorValue | null
    message: string | null
    session: Pick<ConversationRow, 'agent_session_id'>
    redact: Redactor
    now: Date
  },
) => {
  const closed = db
    .update(tool_approval)
    .set({
      status,
      decision:
        status === 'expired'
          ? null
          : {
              behavior: status === 'allowed' ? 'allow' : 'deny',
              message: options.message,
            },
      decided_by: options.by,
      closed_at: options.now,
    })
    .where(
      and(
        eq(tool_approval.task_id, approval.task_id),
        eq(tool_approval.id, approval.id),
        eq(tool_approval.status, 'pending'),
      ),
    )
    .run().changes

  const row = db.select().from(task).where(eq(task.id, approval.task_id)).get()

  if (!closed || !row) {
    return
  }

  recordEvents(
    db,
    row,
    [
      event(
        options.session,
        'approval.decided',
        {
          approval_id: approval.id,
          status,
          ...(options.by
            ? {
                by: {
                  type: options.by.type,
                  id: options.by.id,
                },
              }
            : {}),
          ...(options.message
            ? {
                message: options.message,
              }
            : {}),
        },
        approval.agent_id,
        options.now,
      ),
    ],
    options.redact,
  )
}

export const decideApproval = (
  db: Db,
  approval: ApprovalRow,
  session: Pick<ConversationRow, 'agent_session_id'>,
  decision: { behavior: 'allow' | 'deny'; message: string | null },
  actor: ActorValue,
  redact: Redactor,
  now = new Date(),
) => {
  if (approval.status === 'pending' && approval.expires_at > now) {
    close(db, approval, decision.behavior === 'allow' ? 'allowed' : 'denied', {
      by: actor,
      message: decision.behavior === 'deny' ? decision.message : null,
      session,
      redact,
      now,
    })
  }

  const after = approvalOf(db, approval.task_id, approval.id)!

  if (after.decision?.behavior !== decision.behavior) {
    fail(
      'APPROVAL_CLOSED',
      after.status === 'expired' || after.status === 'pending'
        ? 'This approval expired, so the agent was told no.'
        : `This approval was already ${after.status}.`,
      'Reply to the task to ask the agent to try again.',
      {
        approval: approvalState(after),
      },
    )
  }

  return after
}

export const expireApprovals = (db: Db, now = new Date()) => {
  for (const approval of db
    .select()
    .from(tool_approval)
    .where(and(eq(tool_approval.status, 'pending'), lt(tool_approval.expires_at, now)))
    .all()) {
    const session = sessionOf(db, approval)

    if (!session) {
      continue
    }

    close(db, approval, 'expired', {
      by: null,
      message: null,
      session,
      redact: (text) => text,
      now,
    })
  }
}

export const startApprovalExpiry = (db: Db, log: Log) =>
  every(5, 'task.approval_expiry_failed', log, () => expireApprovals(db))
