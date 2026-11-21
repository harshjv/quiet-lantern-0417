import { randomUUID } from 'node:crypto'

import type { Static } from '@sinclair/typebox'
import { and, asc, desc, eq, gt, inArray, isNull, max } from 'drizzle-orm'

import type { Actor, AgentEventInputValue, AgentEventType } from '@stationly/protocol'

import type { Db } from '../db/client.ts'
import { newId } from '../db/ids.ts'
import { conversation, machine, run, task, task_inbox } from '../db/schema.ts'
import type { Log } from '../log.ts'
import { every } from '../schedule.ts'
import { isProxied } from '../secrets/relay.ts'
import { runGitHubToken, runKeyEnv } from '../team/keys.ts'

import { closePendingApprovals } from './approvals.ts'
import {
  claimSlot,
  deliveredRun,
  machineUserOf,
  memberKeyPlaceholders,
  memberRelayEnv,
  promoteQueued,
  settleUnstartedTasks,
  startTaskSetups,
  taskRunAs,
  taskSetupReady,
  type MachineDeps,
} from './machine.ts'
import { saveActivity } from './status.ts'

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
  'if [ -n "$7" ] && [ "${STATIONLY_MEMBER:-}" != "$7" ]; then echo "The run did not receive its member values" >&2; exit 1; fi',
  'for name in ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN CODEX_API_KEY CODEX_ACCESS_TOKEN; do if [ -z "$(printenv "$name")" ]; then unset "$name"; fi; done',
  'cd "$5"',
  'if [ -n "$6" ]; then export PORT="$6"; fi',
  'setsid sly agent run --session "$1" --adapter "$2" ${3:+--model "$3"} ${4:+--resume} >>"$state/$1.log" 2>&1 </dev/null &',
].join('\n')

export const runnerCommand = (
  session: ConversationRow,
  path: string,
  port: number | null,
  member: string | null = null,
) => [
  'bash',
  '-lc',
  runnerScript,
  'agent-runner',
  session.agent_session_id,
  session.adapter,
  session.model ?? '',
  session.resume ? '1' : '',
  path,
  port === null ? '' : String(port),
  member ?? '',
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

export const conversationById = (db: Db, id: string) =>
  db.select().from(conversation).where(eq(conversation.id, id)).get()

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

export const ackMachineInputs = (
  db: Db,
  machineId: string,
  ids: string[],
  owner: string | null = null,
  now = new Date(),
) => {
  const owners = db
    .select({
      id: task.id,
      owner: task.owner,
    })
    .from(task)
    .where(eq(task.machine_id, machineId))
    .all()
    .filter((row) => owner === null || row.owner.id === owner)
    .map((row) => row.id)

  return owners.length && ids.length
    ? db
        .update(task_inbox)
        .set({
          delivered_at: now,
        })
        .where(and(inArray(task_inbox.task_id, owners), inArray(task_inbox.id, ids)))
        .run().changes
    : 0
}

export const runnerLive = (session: Pick<ConversationRow, 'runner_seen_at'>, now = new Date()) =>
  session.runner_seen_at !== null && now.getTime() - session.runner_seen_at.getTime() < runnerLiveMs

export const runnerExited = (
  db: Db,
  conversationRow: ConversationRow,
  failed: boolean,
  now = new Date(),
) => {
  db.update(conversation)
    .set({
      runner_seen_at: null,
    })
    .where(eq(conversation.id, conversationRow.id))
    .run()

  closePendingApprovals(db, conversationRow.task_id, now)

  const items = inboxItems(db, conversationRow, 0)
  const stale = items.filter((item) => item.kind === 'interrupt').map((item) => item.id)

  if (stale.length) {
    ackInputs(db, conversationRow.task_id, stale, now)
  }

  const row = db.select().from(task).where(eq(task.id, conversationRow.task_id)).get()
  const waiting =
    !failed && items.some((item) => item.kind === 'prompt') && !!row && claimSlot(db, row, now)

  if (waiting) {
    wantRunner(db, conversationRow.id)
  } else if (row && (row.status === 'working' || row.status === 'waiting')) {
    saveActivity(db, row, {
      status: 'ready',
      since: now.toISOString(),
      session_id: conversationRow.agent_session_id,
      last_event_at: now.toISOString(),
      kind: null,
      agents: [],
    })
  }

  return waiting
}

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
      .at(0)

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

const settledRun = (db: Db, runId: string | null) =>
  !runId ||
  ['succeeded', 'failed', 'cancelled', 'skipped'].includes(
    db
      .select({
        status: run.status,
      })
      .from(run)
      .where(eq(run.id, runId))
      .get()?.status ?? 'failed',
  )

export const wantStrandedRunners = (db: Db, now = new Date()) => {
  const stranded = db
    .select({
      session: conversation,
      row: task,
    })
    .from(conversation)
    .innerJoin(task, eq(task.id, conversation.task_id))
    .innerJoin(machine, eq(machine.id, task.machine_id))
    .where(
      and(
        eq(conversation.runner_wanted, false),
        eq(conversation.origin, 'dashboard'),
        eq(machine.status, 'running'),
      ),
    )
    .all()

  for (const { session, row } of stranded) {
    if (
      row.status === 'failed' ||
      row.status === 'queued' ||
      row.status === 'stopped' ||
      runnerLive(session, now) ||
      !settledRun(db, session.runner_run_id)
    ) {
      continue
    }

    if (
      inboxItems(db, session, 0).some((item) => item.kind === 'prompt') &&
      claimSlot(db, row, now)
    ) {
      wantRunner(db, session.id)
    }
  }
}

export const startPendingRunners = async (db: Db, deps: MachineDeps) => {
  promoteQueued(db)
  await startTaskSetups(db, deps)
  settleUnstartedTasks(db)
  wantStrandedRunners(db)

  const wanted = db
    .select({
      session: conversation,
      row: task,
      machine,
    })
    .from(conversation)
    .innerJoin(task, eq(task.id, conversation.task_id))
    .innerJoin(machine, eq(machine.id, task.machine_id))
    .where(eq(conversation.runner_wanted, true))
    .all()

  for (const { session, row: owner, machine: row } of wanted) {
    const workspace = row.workspace

    if (
      row.status !== 'running' ||
      !workspace ||
      owner.status === 'queued' ||
      !taskSetupReady(db, owner)
    ) {
      continue
    }

    const setup = db.select().from(run).where(eq(run.id, workspace.setup_run_id)).get()

    if (setup && setup.status !== 'succeeded') {
      continue
    }

    const id = newId('run')
    const member = machineUserOf(db, owner)
    const as = taskRunAs(row, owner, member)

    db.update(conversation)
      .set({
        runner_wanted: false,
      })
      .where(eq(conversation.id, session.id))
      .run()

    if (member && !member.token_id) {
      continue
    }

    const shared = member
      ? {
          project: row.project_id,
          target: row.target_id,
        }
      : null
    const token = await runGitHubToken(deps.auth, db, deps.keyring, owner.owner.id, shared)
    const refreshed = await deps
      .refreshMachine(row)
      .then(() => true)
      .catch(() => false)
    const delivered = refreshed
      ? await deliveredRun(deps.deliver, row, id, [
          ['HOME', as.home],
          ...(member ? memberRelayEnv(member) : []),
          ...(member && shared ? memberKeyPlaceholders(db, member, shared) : []),
          ...runKeyEnv(db, deps.keyring, owner.owner.id, owner.agent, shared).filter(
            ([name]) => !isProxied(name),
          ),
          ...(token ? ([['GH_TOKEN', token]] as [string, string][]) : []),
        ]).catch(() => null)
      : null

    if (!delivered) {
      wantRunner(db, session.id)
      continue
    }

    db.transaction((tx) => {
      const tdb = tx as unknown as Db

      tdb
        .insert(run)
        .values({
          id,
          app_id: null,
          machine_id: row.id,
          deployment_id: null,
          kind: 'exec',
          command: runnerCommand(
            session,
            as.worktree ?? workspace.path,
            owner.port,
            member?.name ?? null,
          ),
          status: 'queued',
          log_ref: `logs/sandboxes/${row.id}/${id}`,
          tty: false,
          actor: runnerActor,
          exec: {
            cwd: as.home,
            user: as.user,
            timeout_s: 60,
            stdin: null,
            env_keys: delivered.envKeys,
            attach: false,
            task_id: owner.id,
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
    deps.reconcile(row.server_id)
  }
}

export const startAgentRunners = (db: Db, deps: MachineDeps, log: Log) =>
  every(2, 'machine.agent_runner_failed', log, () => startPendingRunners(db, deps))
