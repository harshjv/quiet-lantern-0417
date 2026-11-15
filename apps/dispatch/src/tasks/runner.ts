import { randomUUID } from 'node:crypto'

import type { Static } from '@sinclair/typebox'
import { and, asc, desc, eq, gt, inArray, isNull, max } from 'drizzle-orm'

import {
  workspaceUser,
  type Actor,
  type AgentEventInputValue,
  type AgentEventType,
} from '@stationly/protocol'

import type { Db } from '../db/client.ts'
import { newId } from '../db/ids.ts'
import { conversation, run, sandbox, task, task_inbox } from '../db/schema.ts'
import type { Log } from '../log.ts'
import { every } from '../schedule.ts'

type ActorValue = Static<typeof Actor>

export type ConversationRow = typeof conversation.$inferSelect

type InputRow = typeof task_inbox.$inferSelect

export const runnerLiveMs = 60_000

export const startTimeoutMs = 600_000

const runnerActor: ActorValue = {
  type: 'system',
  id: null,
  client: 'dispatch/agent-runner',
}

const runnerScript = [
  'set -eu',
  'state="$HOME/.local/state/stationly/runner"',
  'mkdir -p "$state"',
  'cd "$5"',
  'setsid sly agent run --session "$1" --adapter "$2" ${3:+--model "$3"} ${4:+--resume} >>"$state/$1.log" 2>&1 </dev/null &',
].join('\n')

export const runnerCommand = (session: ConversationRow, path: string) => [
  'bash',
  '-lc',
  runnerScript,
  'agent-runner',
  session.agent_session_id,
  session.adapter,
  session.model ?? '',
  session.resume ? '1' : '',
  path,
]

export const humanOf = (actor: ActorValue) => ({
  type: actor.type,
  id: actor.id,
})

const nextInputSeq = (db: Db, taskId: string) =>
  (db
    .select({
      value: max(task_inbox.seq),
    })
    .from(task_inbox)
    .where(eq(task_inbox.task_id, taskId))
    .get()?.value ?? 0) + 1

export const conversationOf = (db: Db, taskId: string, agentSessionId: string) =>
  db
    .select()
    .from(conversation)
    .where(and(eq(conversation.task_id, taskId), eq(conversation.agent_session_id, agentSessionId)))
    .get()

export const latestConversation = (db: Db, taskId: string) =>
  db
    .select()
    .from(conversation)
    .where(eq(conversation.task_id, taskId))
    .orderBy(desc(conversation.created_at), desc(conversation.id))
    .limit(1)
    .get()

export const terminalConversation = (
  db: Db,
  taskRow: Pick<typeof task.$inferSelect, 'id' | 'agent'>,
  agentSessionId: string,
  now: Date,
) => {
  const found = conversationOf(db, taskRow.id, agentSessionId)

  if (found) {
    return found
  }

  return db
    .insert(conversation)
    .values({
      id: newId('conversation'),
      task_id: taskRow.id,
      agent_session_id: agentSessionId,
      adapter: taskRow.agent,
      model: null,
      origin: 'terminal',
      started_by: null,
      created_at: now,
    })
    .returning()
    .get()
}

export const addInput = (
  db: Db,
  conversationRow: Pick<ConversationRow, 'id' | 'task_id'>,
  input: { kind: 'prompt' | 'interrupt'; text: string | null },
  actor: ActorValue,
  now = new Date(),
) => {
  const seq = nextInputSeq(db, conversationRow.task_id)
  const id = randomUUID()

  db.insert(task_inbox)
    .values({
      id,
      task_id: conversationRow.task_id,
      conversation_id: conversationRow.id,
      seq,
      kind: input.kind,
      text: input.text,
      actor,
      created_at: now,
    })
    .run()

  return {
    id,
    seq,
  }
}

export const startConversation = (
  db: Db,
  taskId: string,
  options: { adapter: string; model: string | null; prompt: string; actor: ActorValue },
  now = new Date(),
) => {
  const created = db
    .insert(conversation)
    .values({
      id: newId('conversation'),
      task_id: taskId,
      agent_session_id: randomUUID(),
      adapter: options.adapter,
      model: options.model,
      origin: 'dashboard',
      started_by: options.actor,
      created_at: now,
      runner_wanted: true,
    })
    .returning()
    .get()

  addInput(
    db,
    created,
    {
      kind: 'prompt',
      text: options.prompt,
    },
    options.actor,
    now,
  )

  return created
}

export const inboxItems = (db: Db, conversationRow: ConversationRow, after: number) =>
  db
    .select()
    .from(task_inbox)
    .where(
      and(
        eq(task_inbox.task_id, conversationRow.task_id),
        eq(task_inbox.conversation_id, conversationRow.id),
        gt(task_inbox.seq, after),
        isNull(task_inbox.delivered_at),
      ),
    )
    .orderBy(asc(task_inbox.seq))
    .all()

export const touchRunner = (db: Db, conversationId: string, now = new Date()) => {
  db.update(conversation)
    .set({
      runner_seen_at: now,
    })
    .where(eq(conversation.id, conversationId))
    .run()
}

export const ackInputs = (db: Db, taskId: string, ids: string[], now = new Date()) =>
  db
    .update(task_inbox)
    .set({
      delivered_at: now,
    })
    .where(and(eq(task_inbox.task_id, taskId), inArray(task_inbox.id, ids)))
    .run().changes

export const runnerLive = (session: Pick<ConversationRow, 'runner_seen_at'>, now = new Date()) =>
  session.runner_seen_at !== null && now.getTime() - session.runner_seen_at.getTime() < runnerLiveMs

export const wantRunner = (db: Db, conversationId: string) => {
  db.update(conversation)
    .set({
      runner_wanted: true,
      resume: true,
    })
    .where(eq(conversation.id, conversationId))
    .run()
}

type Shaped = { type: AgentEventType; data: Record<string, unknown>; input: InputRow | null }

export const shapeEvent = (
  db: Db,
  session: ConversationRow,
  event: AgentEventInputValue,
): Shaped => {
  const plain = {
    type: event.type,
    data: event.data as Record<string, unknown>,
    input: null,
  }

  if (session.origin !== 'dashboard') {
    return plain
  }

  if (event.type === 'attention') {
    const { tool, summary } = event.data as { tool?: string; summary?: string }

    return {
      type: 'tool.denied',
      data: {
        ...(tool === undefined
          ? {}
          : {
              tool,
            }),
        ...(summary === undefined
          ? {}
          : {
              summary,
            }),
      },
      input: null,
    }
  }

  if (event.type === 'prompt') {
    const { text } = event.data as { text: string }

    const input = db
      .select()
      .from(task_inbox)
      .where(
        and(
          eq(task_inbox.task_id, session.task_id),
          eq(task_inbox.conversation_id, session.id),
          eq(task_inbox.kind, 'prompt'),
          eq(task_inbox.text, text),
          isNull(task_inbox.event_seq),
        ),
      )
      .orderBy(asc(task_inbox.seq))
      .all()
      .find((candidate) => candidate.delivered_at !== null)

    if (input) {
      return {
        type: 'prompt',
        data: {
          ...event.data,
          by: humanOf(input.actor),
        },
        input,
      }
    }
  }

  return plain
}

export const startPendingRunners = (db: Db, reconcile: (station: string) => void) => {
  const wanted = db
    .select({
      session: conversation,
      sandbox,
    })
    .from(conversation)
    .innerJoin(task, eq(task.id, conversation.task_id))
    .innerJoin(sandbox, eq(sandbox.id, task.sandbox_id))
    .where(eq(conversation.runner_wanted, true))
    .all()

  for (const { session, sandbox: row } of wanted) {
    const workspace = row.workspace

    if (row.status !== 'running' || !workspace) {
      continue
    }

    const setup = db.select().from(run).where(eq(run.id, workspace.setup_run_id)).get()

    if (setup && setup.status !== 'succeeded') {
      continue
    }

    const id = newId('run')

    db.transaction((tx) => {
      const tdb = tx as unknown as Db

      tdb
        .insert(run)
        .values({
          id,
          service_id: null,
          sandbox_id: row.id,
          deployment_id: null,
          kind: 'exec',
          command: runnerCommand(session, workspace.path),
          status: 'queued',
          log_ref: `logs/sandboxes/${row.id}/${id}`,
          tty: false,
          actor: runnerActor,
          exec: {
            cwd: workspaceUser.home,
            user: workspaceUser.name,
            timeout_s: 60,
            stdin: null,
            env_keys: [],
            attach: false,
          },
        })
        .run()
      tdb
        .update(conversation)
        .set({
          runner_wanted: false,
          runner_run_id: id,
        })
        .where(eq(conversation.id, session.id))
        .run()
    })
    reconcile(row.station_id)
  }
}

export const startAgentRunners = (db: Db, reconcile: (station: string) => void, log: Log) =>
  every(2, 'sandbox.agent_runner_failed', log, () => startPendingRunners(db, reconcile))
