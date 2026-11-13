import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'

import {
  agentStatusValues,
  type AgentStatusRecord,
  type AgentStatusValue,
} from '@stationly/protocol'

import { invalid } from '../api/errors.ts'
import type { Redactor } from '../api/redaction.ts'
import type { Db } from '../db/client.ts'
import { agent_event, environment, project, sandbox } from '../db/schema.ts'

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
    .orderBy(
      desc(sql`max(${agent_event.at})`),
      desc(agent_event.sandbox_id),
      desc(agent_event.session_id),
    )
    .all()
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
      const status = statusOf(known.get(row.sandbox_id)!, row.session_id)

      return !options.status || options.status.has(status)
    })

  const page = found.slice(0, options.limit)
  const redactors = new Map<string, Redactor>()
  const items = page.map((row): AgentSessionItem => {
    const workspace = known.get(row.sandbox_id)!
    const status = statusOf(workspace, row.session_id)

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
        firstPrompt(db, row.sandbox_id, row.session_id),
        redactors.get(row.sandbox_id)!,
      ),
      started_at: new Date(row.started).toISOString(),
      last_event_at: new Date(row.last).toISOString(),
    }
  })
  const last = page.at(-1)

  return {
    items,
    next_cursor:
      found.length > options.limit && last
        ? encodeCursor({
            last: last.last,
            sandbox: last.sandbox_id,
            session: last.session_id,
          })
        : null,
  }
}
