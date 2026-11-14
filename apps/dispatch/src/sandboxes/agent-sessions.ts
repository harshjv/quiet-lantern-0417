import { and, eq, isNotNull, sql } from 'drizzle-orm'

import {
  agentStatusValues,
  type AgentStatusRecord,
  type AgentStatusValue,
} from '@stationly/protocol'

import { invalid } from '../api/errors.ts'
import type { Redactor } from '../api/redaction.ts'
import type { Db } from '../db/client.ts'
import {
  agent_event,
  agent_input,
  agent_session,
  environment,
  project,
  run,
  sandbox,
} from '../db/schema.ts'

import { humanOf, startTimeoutMs } from './agent-runner.ts'
import { agentStatusOf } from './agent-status.ts'

export const titleLength = 120

type Workspace = {
  id: string
  name: string
  agent: 'claude' | 'codex'
  project: { id: string; name: string }
  environment: { id: string; name: string }
  current: {
    session_id: string | null
    status: AgentStatusValue
    kind: AgentStatusRecord['kind']
  }
  status: typeof sandbox.$inferSelect.status
  setup_run_id: string | null
}

export type AgentSessionItem = {
  session_id: string
  sandbox: { id: string; name: string }
  agent: 'claude' | 'codex'
  project: { id: string; name: string }
  environment: { id: string; name: string }
  status: Exclude<AgentStatusValue, 'none'>
  kind: AgentStatusRecord['kind']
  title: string | null
  started_at: string
  last_event_at: string
  mode: 'runner' | 'observed'
  started_by: { type: string; id: string | null } | null
  setup: { state: 'creating' | 'setting_up' | 'starting' | 'failed'; run_id: string | null } | null
}

type Position = { last: number; sandbox: string; session: string }

export const encodeCursor = (position: Position) =>
  Buffer.from(`${position.last}|${position.sandbox}|${position.session}`).toString('base64url')

const decodeCursor = (cursor: string): Position => {
  const [last, sandboxId, session] = Buffer.from(cursor, 'base64url').toString().split('|')

  if (!last || !/^\d+$/.test(last) || !sandboxId || !session) {
    invalid([
      {
        path: '/cursor',
        message: 'unknown cursor',
      },
    ])
  }

  return {
    last: Number(last),
    sandbox: sandboxId!,
    session: session!,
  }
}

const workspaces = (db: Db, only: string | undefined) =>
  new Map(
    db
      .select({
        row: sandbox,
        environment_name: environment.name,
        project_id: project.id,
        project_name: project.name,
      })
      .from(sandbox)
      .innerJoin(environment, eq(environment.id, sandbox.environment_id))
      .innerJoin(project, eq(project.id, environment.project_id))
      .where(and(isNotNull(sandbox.workspace), only ? eq(sandbox.id, only) : undefined))
      .all()
      .map((found): [string, Workspace] => {
        const status = agentStatusOf(found.row)

        return [
          found.row.id,
          {
            id: found.row.id,
            name: found.row.name,
            agent: found.row.workspace!.agent,
            project: {
              id: found.project_id,
              name: found.project_name,
            },
            environment: {
              id: found.row.environment_id,
              name: found.environment_name,
            },
            status: found.row.status,
            setup_run_id: found.row.workspace!.setup_run_id,
            current: {
              session_id: status?.session_id ?? null,
              status: status?.status ?? 'none',
              kind: status?.kind ?? null,
            },
          },
        ]
      }),
  )

const firstPrompt = (db: Db, sandboxId: string, session: string) =>
  db
    .select({
      data: agent_event.data,
    })
    .from(agent_event)
    .where(
      and(
        eq(agent_event.sandbox_id, sandboxId),
        eq(agent_event.session_id, session),
        eq(agent_event.type, 'prompt'),
      ),
    )
    .orderBy(agent_event.seq)
    .limit(1)
    .get()?.data.text

const firstInput = (db: Db, sandboxId: string, session: string) =>
  db
    .select({
      text: agent_input.text,
    })
    .from(agent_input)
    .where(
      and(
        eq(agent_input.sandbox_id, sandboxId),
        eq(agent_input.session_id, session),
        eq(agent_input.kind, 'prompt'),
      ),
    )
    .orderBy(agent_input.seq)
    .limit(1)
    .get()?.text

const setupOf = (
  db: Db,
  workspace: Workspace,
  now: number,
): NonNullable<AgentSessionItem['setup']> => {
  if (workspace.status !== 'running') {
    return {
      state: 'creating',
      run_id: workspace.setup_run_id,
    }
  }

  const setup = workspace.setup_run_id
    ? db.select().from(run).where(eq(run.id, workspace.setup_run_id)).get()
    : undefined

  if (!setup || setup.status === 'queued' || setup.status === 'running') {
    return {
      state: 'setting_up',
      run_id: workspace.setup_run_id,
    }
  }

  const finished = setup.finished_at?.getTime() ?? now

  return {
    state: setup.status !== 'succeeded' || now - finished > startTimeoutMs ? 'failed' : 'starting',
    run_id: workspace.setup_run_id,
  }
}

export const titleOf = (text: unknown, redact: Redactor) => {
  if (typeof text !== 'string') {
    return null
  }

  const line = redact(text).replace(/\s+/g, ' ').trim()

  return line ? Array.from(line).slice(0, titleLength).join('') : null
}

const statusOf = (workspace: Workspace, session: string) =>
  workspace.current.session_id === session && workspace.current.status !== 'none'
    ? workspace.current.status
    : 'ended'

export const filterStatuses = (text: string | undefined) => {
  if (text === undefined) {
    return null
  }

  const wanted = text.split(',').map((value) => value.trim())
  const unknown = wanted.filter(
    (value) => value === 'none' || !(agentStatusValues as readonly string[]).includes(value),
  )

  if (unknown.length) {
    invalid([
      {
        path: '/status',
        message: `unknown status ${unknown.join(', ')}`,
      },
    ])
  }

  return new Set(wanted)
}

export const listAgentSessions = (
  db: Db,
  options: {
    limit: number
    cursor: string | undefined
    status: Set<string> | null
    workspace: string | undefined
    redactor: (sandboxId: string) => Redactor
  },
) => {
  const known = workspaces(db, options.workspace)
  const after = options.cursor ? decodeCursor(options.cursor) : null
  const found = db
    .select({
      sandbox_id: agent_event.sandbox_id,
      session_id: agent_event.session_id,
      started: sql<number>`min(${agent_event.at})`,
      last: sql<number>`max(${agent_event.at})`,
    })
    .from(agent_event)
    .where(options.workspace ? eq(agent_event.sandbox_id, options.workspace) : undefined)
    .groupBy(agent_event.sandbox_id, agent_event.session_id)
    .all()
    .map((row) => ({
      ...row,
      events: true,
    }))
  const eventful = new Set(found.map((row) => `${row.sandbox_id}/${row.session_id}`))
  const pending = db
    .select()
    .from(agent_session)
    .where(options.workspace ? eq(agent_session.sandbox_id, options.workspace) : undefined)
    .all()
    .filter((row) => !eventful.has(`${row.sandbox_id}/${row.session_id}`))
    .map((row) => ({
      sandbox_id: row.sandbox_id,
      session_id: row.session_id,
      started: row.created_at.getTime(),
      last: row.created_at.getTime(),
      events: false,
    }))
  const matched = [...found, ...pending]
    .toSorted(
      (a, b) =>
        b.last - a.last ||
        b.sandbox_id.localeCompare(a.sandbox_id) ||
        b.session_id.localeCompare(a.session_id),
    )
    .filter((row) => known.has(row.sandbox_id))
    .filter((row) => {
      if (!after) {
        return true
      }

      return (
        row.last < after.last ||
        (row.last === after.last &&
          (row.sandbox_id < after.sandbox ||
            (row.sandbox_id === after.sandbox && row.session_id < after.session)))
      )
    })
    .filter((row) => {
      const status = row.events ? statusOf(known.get(row.sandbox_id)!, row.session_id) : 'working'

      return !options.status || options.status.has(status)
    })

  const sessions = new Map(
    db
      .select()
      .from(agent_session)
      .all()
      .map((row) => [`${row.sandbox_id}/${row.session_id}`, row]),
  )
  const now = Date.now()
  const page = matched.slice(0, options.limit)
  const redactors = new Map<string, Redactor>()
  const items = page.map((row): AgentSessionItem => {
    const workspace = known.get(row.sandbox_id)!
    const status = row.events ? statusOf(workspace, row.session_id) : 'working'
    const runner = sessions.get(`${row.sandbox_id}/${row.session_id}`)

    if (!redactors.has(row.sandbox_id)) {
      redactors.set(row.sandbox_id, options.redactor(row.sandbox_id))
    }

    return {
      session_id: row.session_id,
      sandbox: {
        id: workspace.id,
        name: workspace.name,
      },
      agent: workspace.agent,
      project: workspace.project,
      environment: workspace.environment,
      status,
      kind: status === 'waiting' ? workspace.current.kind : null,
      title: titleOf(
        firstPrompt(db, row.sandbox_id, row.session_id) ??
          firstInput(db, row.sandbox_id, row.session_id),
        redactors.get(row.sandbox_id)!,
      ),
      started_at: new Date(row.started).toISOString(),
      last_event_at: new Date(row.last).toISOString(),
      mode: runner ? 'runner' : 'observed',
      started_by: runner ? humanOf(runner.started_by) : null,
      setup: row.events || !runner ? null : setupOf(db, workspace, now),
    }
  })
  const last = page.at(-1)

  return {
    items,
    next_cursor:
      matched.length > options.limit && last
        ? encodeCursor({
            last: last.last,
            sandbox: last.sandbox_id,
            session: last.session_id,
          })
        : null,
  }
}
