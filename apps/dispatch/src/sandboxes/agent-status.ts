import { and, desc, eq, inArray, isNull } from 'drizzle-orm'

import type { AgentEventType, AgentStatusRecord, AgentStatusValue } from '@stationly/protocol'

import type { Db } from '../db/client.ts'
import { agent_event, sandbox } from '../db/schema.ts'
import { emitEvent } from '../station/events.ts'

import { sandboxSubject } from './subject.ts'

type SandboxRow = typeof sandbox.$inferSelect

type StatusEvent = {
  type: AgentEventType
  session_id: string
  prompt_id?: string | null
  agent_id?: string | null
  data: unknown
  at: string
}

const afterTurnTypes: AgentEventType[] = ['tool.started', 'tool.finished', 'tool.denied', 'message']

const endTypes: AgentEventType[] = ['turn.ended', 'turn.failed']

const endedTurn = (db: Db, row: SandboxRow, event: StatusEvent) => {
  if (event.agent_id || !event.prompt_id || !afterTurnTypes.includes(event.type)) {
    return false
  }

  const last = db
    .select({
      session_id: agent_event.session_id,
      prompt_id: agent_event.prompt_id,
    })
    .from(agent_event)
    .where(and(eq(agent_event.sandbox_id, row.id), inArray(agent_event.type, endTypes)))
    .orderBy(desc(agent_event.seq))
    .limit(1)
    .get()

  return last?.session_id === event.session_id && last.prompt_id === event.prompt_id
}

const mainTurnOpen = (db: Db, row: SandboxRow, session: string) =>
  db
    .select({
      type: agent_event.type,
    })
    .from(agent_event)
    .where(
      and(
        eq(agent_event.sandbox_id, row.id),
        eq(agent_event.session_id, session),
        isNull(agent_event.agent_id),
        inArray(agent_event.type, ['prompt', ...endTypes]),
      ),
    )
    .orderBy(desc(agent_event.seq))
    .limit(1)
    .get()?.type === 'prompt'

const transitions: Partial<Record<AgentEventType, AgentStatusValue>> = {
  prompt: 'working',
  message: 'working',
  'tool.started': 'working',
  'tool.finished': 'working',
  'tool.denied': 'working',
  'subagent.started': 'working',
  attention: 'waiting',
  'turn.ended': 'ready',
  'turn.failed': 'failed',
  'session.ended': 'ended',
}

export const noAgentSession = (since: Date): AgentStatusRecord => ({
  status: 'none',
  since: since.toISOString(),
  session_id: null,
  last_event_at: null,
  kind: null,
  agents: [],
})

export const agentStatusOf = (
  row: Pick<SandboxRow, 'workspace' | 'agent_status' | 'created_at'>,
) => (row.workspace ? (row.agent_status ?? noAgentSession(row.created_at)) : null)

type Context = { mainOpen: boolean }

const targetStatus = (current: AgentStatusRecord, event: StatusEvent, context: Context) => {
  const agents = agentsAfter(current, event)

  if (event.type === 'session.started') {
    const resumes = current.session_id === event.session_id
    const open = current.status !== 'none' && current.status !== 'ended'

    return resumes && open ? current.status : 'ready'
  }

  if (event.type === 'turn.ended') {
    return agents.length > 0 ? 'working' : 'ready'
  }

  if (event.type === 'subagent.stopped') {
    return current.status === 'working' && agents.length === 0 && !context.mainOpen
      ? 'ready'
      : current.status
  }

  return transitions[event.type]
}

const agentsAfter = (current: AgentStatusRecord, event: StatusEvent) => {
  const same = current.session_id === event.session_id
  const running = same ? current.agents : []

  if (event.type === 'session.ended') {
    return []
  }

  if (event.type === 'subagent.started' && event.agent_id) {
    return [...new Set([...running, event.agent_id])]
  }

  if (event.type === 'subagent.stopped') {
    return running.filter((id) => id !== event.agent_id)
  }

  return running
}

export const nextAgentStatus = (
  current: AgentStatusRecord,
  event: StatusEvent,
  context: Context = {
    mainOpen: true,
  },
): AgentStatusRecord | null => {
  const target = targetStatus(current, event, context)

  if (!target || (current.last_event_at && event.at < current.last_event_at)) {
    return null
  }

  const sameSession = current.session_id === event.session_id
  const holdsKind = current.status === 'waiting' && target === 'waiting' && sameSession
  const kind =
    target === 'waiting'
      ? holdsKind
        ? current.kind
        : ((event.data as { kind?: AgentStatusRecord['kind'] }).kind ?? null)
      : null
  const unchanged = current.status === target && sameSession

  return {
    status: target,
    since: unchanged ? current.since : event.at,
    session_id: event.session_id,
    last_event_at: event.at,
    kind,
    agents: agentsAfter(current, event),
  }
}

export const saveAgentStatus = (db: Db, row: SandboxRow, next: AgentStatusRecord) => {
  const current = agentStatusOf(row)

  db.update(sandbox)
    .set({
      agent_status: next,
    })
    .where(eq(sandbox.id, row.id))
    .run()

  if (
    current?.status !== next.status ||
    current.session_id !== next.session_id ||
    current.agents.length !== next.agents.length
  ) {
    emitEvent(db, 'sandbox.agent_status', sandboxSubject(row), {
      sandbox: row.id,
      status: next.status,
      since: next.since,
      session_id: next.session_id,
    })
  }
}

export const applyAgentStatus = (db: Db, row: SandboxRow, event: StatusEvent) => {
  const current = agentStatusOf(row)
  const next =
    current && !endedTurn(db, row, event)
      ? nextAgentStatus(current, event, {
          mainOpen:
            event.type === 'subagent.stopped' ? mainTurnOpen(db, row, event.session_id) : true,
        })
      : null

  if (!next) {
    return row
  }

  saveAgentStatus(db, row, next)

  return {
    ...row,
    agent_status: next,
  }
}

export const applyAgentReset = (db: Db, row: SandboxRow, now = new Date()) => {
  const current = agentStatusOf(row)

  if (current && current.status !== 'none') {
    saveAgentStatus(db, row, noAgentSession(now))
  }
}
