import { and, desc, eq, inArray, isNull } from 'drizzle-orm'

import type {
  AgentEventType,
  AgentStatusRecord,
  AgentStatusValue,
  TaskStatusValue,
} from '@stationly/protocol'

import type { Db } from '../db/client.ts'
import { conversation_event, task } from '../db/schema.ts'
import { emitEvent } from '../station/events.ts'

export type TaskRow = typeof task.$inferSelect

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

const endedTurn = (db: Db, row: TaskRow, event: StatusEvent, conversationId: string) => {
  if (event.agent_id || !event.prompt_id || !afterTurnTypes.includes(event.type)) {
    return false
  }

  const last = db
    .select({
      conversation_id: conversation_event.conversation_id,
      prompt_id: conversation_event.prompt_id,
    })
    .from(conversation_event)
    .where(and(eq(conversation_event.task_id, row.id), inArray(conversation_event.type, endTypes)))
    .orderBy(desc(conversation_event.seq))
    .limit(1)
    .get()

  return last?.conversation_id === conversationId && last.prompt_id === event.prompt_id
}

const mainTurnOpen = (db: Db, row: TaskRow, conversationId: string) =>
  db
    .select({
      type: conversation_event.type,
    })
    .from(conversation_event)
    .where(
      and(
        eq(conversation_event.task_id, row.id),
        eq(conversation_event.conversation_id, conversationId),
        isNull(conversation_event.agent_id),
        inArray(conversation_event.type, ['prompt', ...endTypes]),
      ),
    )
    .orderBy(desc(conversation_event.seq))
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

export const activityOf = (row: Pick<TaskRow, 'activity' | 'created_at'>) =>
  row.activity ?? noAgentSession(row.created_at)

const taskStatuses: Record<AgentStatusValue, TaskStatusValue> = {
  none: 'stopped',
  working: 'working',
  waiting: 'waiting',
  ready: 'finished',
  failed: 'failed',
  ended: 'finished',
}

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

export const taskChanged = (db: Db, row: Pick<TaskRow, 'id' | 'project_id' | 'environment_id'>) =>
  emitEvent(db, 'task.changed', taskSubject(row), {
    task: row.id,
  })

export const taskSubject = (row: Pick<TaskRow, 'id' | 'project_id' | 'environment_id'>) => ({
  entity: 'task',
  id: row.id,
  task_id: row.id,
  project_id: row.project_id,
  environment_id: row.environment_id,
})

export const saveActivity = (db: Db, row: TaskRow, next: AgentStatusRecord) => {
  const status = taskStatuses[next.status]
  const attention =
    next.status === 'waiting' && next.kind
      ? {
          kind: next.kind,
          since: next.since,
        }
      : null

  db.update(task)
    .set({
      activity: next,
      status,
      attention,
    })
    .where(eq(task.id, row.id))
    .run()

  if (row.status !== status || row.attention?.kind !== attention?.kind) {
    taskChanged(db, row)
  }

  return {
    ...row,
    activity: next,
    status,
    attention,
  }
}

export const applyActivity = (db: Db, row: TaskRow, event: StatusEvent, conversationId: string) => {
  if (endedTurn(db, row, event, conversationId)) {
    return row
  }

  const next = nextAgentStatus(activityOf(row), event, {
    mainOpen: event.type === 'subagent.stopped' ? mainTurnOpen(db, row, conversationId) : true,
  })

  return next ? saveActivity(db, row, next) : row
}

export const stopSandboxTask = (db: Db, sandboxId: string, now = new Date()) => {
  const row = db.select().from(task).where(eq(task.sandbox_id, sandboxId)).get()

  if (row && row.status !== 'stopped') {
    saveActivity(db, row, noAgentSession(now))
  }
}
