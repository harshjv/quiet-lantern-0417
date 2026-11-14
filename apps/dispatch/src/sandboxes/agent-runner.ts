import { randomUUID } from 'node:crypto'

import type { Static } from '@sinclair/typebox'
import { and, asc, eq, gt, inArray, isNull, max } from 'drizzle-orm'

import {
  workspaceUser,
  type Actor,
  type AgentEventInputValue,
  type AgentEventType,
} from '@stationly/protocol'

import type { Db } from '../db/client.ts'
import { newId } from '../db/ids.ts'
import { agent_input, agent_session, run, sandbox } from '../db/schema.ts'
import type { Log } from '../log.ts'
import { every } from '../schedule.ts'

type ActorValue = Static<typeof Actor>

type SandboxRow = typeof sandbox.$inferSelect

export type AgentSessionRow = typeof agent_session.$inferSelect

type InputRow = typeof agent_input.$inferSelect

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

export const runnerCommand = (session: AgentSessionRow, path: string) => [
  'bash',
  '-lc',
  runnerScript,
  'agent-runner',
  session.session_id,
  session.adapter,
  session.model ?? '',
  session.resume ? '1' : '',
  path,
]

export const humanOf = (actor: ActorValue) => ({
  type: actor.type,
  id: actor.id,
})

const nextInputSeq = (db: Db, sandboxId: string) =>
  (db
    .select({
      value: max(agent_input.seq),
    })
    .from(agent_input)
    .where(eq(agent_input.sandbox_id, sandboxId))
    .get()?.value ?? 0) + 1

export const runnerSessionOf = (db: Db, sandboxId: string, session: string) =>
  db
    .select()
    .from(agent_session)
    .where(and(eq(agent_session.sandbox_id, sandboxId), eq(agent_session.session_id, session)))
    .get()

export const addInput = (
  db: Db,
  sandboxId: string,
  session: string,
  input: { kind: 'prompt' | 'interrupt'; text: string | null },
  actor: ActorValue,
  now = new Date(),
) => {
  const seq = nextInputSeq(db, sandboxId)
  const id = randomUUID()

  db.insert(agent_input)
    .values({
      id,
      sandbox_id: sandboxId,
      session_id: session,
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

export const createRunnerSession = (
  db: Db,
  row: SandboxRow,
  options: { model: string | null; prompt: string; actor: ActorValue },
  now = new Date(),
) => {
  const sessionId = randomUUID()

  db.transaction((tx) => {
    const tdb = tx as unknown as Db

    tdb
      .insert(agent_session)
      .values({
        sandbox_id: row.id,
        session_id: sessionId,
        adapter: row.workspace!.agent,
        model: options.model,
        started_by: options.actor,
        created_at: now,
      })
      .run()
    addInput(
      tdb,
      row.id,
      sessionId,
      {
        kind: 'prompt',
        text: options.prompt,
      },
      options.actor,
      now,
    )
  })

  return sessionId
}

export const inboxItems = (db: Db, sandboxId: string, session: string, after: number) =>
  db
    .select()
    .from(agent_input)
    .where(
      and(
        eq(agent_input.sandbox_id, sandboxId),
        eq(agent_input.session_id, session),
        gt(agent_input.seq, after),
        isNull(agent_input.delivered_at),
      ),
    )
    .orderBy(asc(agent_input.seq))
    .all()

export const touchRunner = (db: Db, sandboxId: string, session: string, now = new Date()) => {
  db.update(agent_session)
    .set({
      runner_seen_at: now,
    })
    .where(and(eq(agent_session.sandbox_id, sandboxId), eq(agent_session.session_id, session)))
    .run()
}

export const ackInputs = (db: Db, sandboxId: string, ids: string[], now = new Date()) =>
  db
    .update(agent_input)
    .set({
      delivered_at: now,
    })
    .where(and(eq(agent_input.sandbox_id, sandboxId), inArray(agent_input.id, ids)))
    .run().changes

export const runnerLive = (session: Pick<AgentSessionRow, 'runner_seen_at'>, now = new Date()) =>
  session.runner_seen_at !== null && now.getTime() - session.runner_seen_at.getTime() < runnerLiveMs

export const wantRunner = (db: Db, sandboxId: string, session: string) => {
  db.update(agent_session)
    .set({
      runner_wanted: true,
      resume: true,
    })
    .where(and(eq(agent_session.sandbox_id, sandboxId), eq(agent_session.session_id, session)))
    .run()
}

type Shaped = { type: AgentEventType; data: Record<string, unknown>; input: InputRow | null }

export const shapeEvent = (db: Db, row: SandboxRow, event: AgentEventInputValue): Shaped => {
  const plain = {
    type: event.type,
    data: event.data as Record<string, unknown>,
    input: null,
  }
  const session = runnerSessionOf(db, row.id, event.session_id)

  if (!session) {
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
      .from(agent_input)
      .where(
        and(
          eq(agent_input.sandbox_id, row.id),
          eq(agent_input.session_id, event.session_id),
          eq(agent_input.kind, 'prompt'),
          eq(agent_input.text, text),
          isNull(agent_input.event_seq),
        ),
      )
      .orderBy(asc(agent_input.seq))
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
      session: agent_session,
      sandbox,
    })
    .from(agent_session)
    .innerJoin(sandbox, eq(sandbox.id, agent_session.sandbox_id))
    .where(eq(agent_session.runner_wanted, true))
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
        .update(agent_session)
        .set({
          runner_wanted: false,
          runner_run_id: id,
        })
        .where(
          and(
            eq(agent_session.sandbox_id, session.sandbox_id),
            eq(agent_session.session_id, session.session_id),
          ),
        )
        .run()
    })
    reconcile(row.station_id)
  }
}

export const startAgentRunners = (db: Db, reconcile: (station: string) => void, log: Log) =>
  every(2, 'sandbox.agent_runner_failed', log, () => startPendingRunners(db, reconcile))
