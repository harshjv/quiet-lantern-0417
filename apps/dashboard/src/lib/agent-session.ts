import type {
  AgentEventValue,
  AgentProgressData,
  AgentStatusRecord,
  AgentStatusValue,
} from '@stationly/protocol'

import { plural } from './format.ts'
import type { Tone } from './tone.ts'

export const staleWorkingS = 300

export const maxAgentEvents = 5000

export type AgentLivePart = {
  type: 'message.part'
  session_id: string
  data: {
    message_id: string
    index: number
    final: boolean
    text: string
  }
}

export type AgentProgress = {
  type: 'progress'
  at: string
  session_id: string
  data: AgentProgressData
}

export type HeldParts = {
  session_id: string
  texts: Record<number, string>
}

export type AgentState = {
  events: AgentEventValue[]
  lastSeq: number
  parts: Record<string, HeldParts>
  progress: AgentProgress | null
  closedAt: string
}

export const emptyAgentState: AgentState = {
  events: [],
  lastSeq: 0,
  parts: {},
  progress: null,
  closedAt: '',
}

const closesProgress = new Set<AgentEventValue['type']>([
  'message',
  'tool.started',
  'turn.ended',
  'turn.failed',
  'session.ended',
])

const closing = (state: AgentState, event: AgentEventValue) => {
  if (event.agent_id || !closesProgress.has(event.type) || event.at <= state.closedAt) {
    return {}
  }

  return {
    closedAt: event.at,
    progress: state.progress && state.progress.at <= event.at ? null : state.progress,
  }
}

export const applyProgress = (state: AgentState, progress: AgentProgress): AgentState =>
  progress.at <= state.closedAt
    ? state
    : {
        ...state,
        progress,
      }

export const applyStored = (state: AgentState, event: AgentEventValue): AgentState => {
  if (event.seq <= state.lastSeq) {
    return state
  }

  const parts = {
    ...state.parts,
  }

  if (event.type === 'message') {
    delete parts[event.data.message_id]
  }

  return {
    ...state,
    events: [...state.events, event].slice(-maxAgentEvents),
    lastSeq: event.seq,
    parts,
    ...closing(state, event),
  }
}

export const applyPart = (state: AgentState, part: AgentLivePart): AgentState => {
  const held = state.parts[part.data.message_id]

  return {
    ...state,
    parts: {
      ...state.parts,
      [part.data.message_id]: {
        session_id: part.session_id,
        texts: {
          ...held?.texts,
          [part.data.index]: part.data.text,
        },
      },
    },
  }
}

const joinedParts = (held: HeldParts) =>
  Object.entries(held.texts)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, text]) => text)
    .join('')

export type AgentSession = {
  id: string
  startedAt: string
}

export const sessionsOf = (events: readonly AgentEventValue[]): AgentSession[] => {
  const seen = new Map<string, AgentSession>()

  for (const event of events) {
    if (!seen.has(event.session_id)) {
      seen.set(event.session_id, {
        id: event.session_id,
        startedAt: event.at,
      })
    }
  }

  return [...seen.values()]
}

export type ToolCall = {
  id: string
  name: string
  summary: string
  state: 'running' | 'done' | 'failed' | 'denied'
  output: string | null
  durationMs: number | null
}

export type TurnItem =
  | { kind: 'message'; id: string; text: string }
  | { kind: 'live'; id: string; text: string }
  | { kind: 'tools'; id: string; calls: ToolCall[] }
  | { kind: 'note'; id: string; text: string }
  | {
      kind: 'approval'
      id: string
      approvalId: string
      tool: string
      input: Record<string, unknown>
      expiresAt: string
      truncated: boolean
      status: 'pending' | 'allowed' | 'denied' | 'expired'
      message: string | null
    }
  | { kind: 'blocked'; id: string; tool: string; summary: string; reason: string | null }
  | {
      kind: 'changes'
      id: string
      files: { path: string; added: number | null; removed: number | null; diff?: string }[]
      moreFiles: number
      commits: { sha: string; subject: string }[]
      truncated: boolean
    }

export type Turn = {
  key: string
  prompt: string | null
  by: { type: string; id: string | null } | null
  startedAt: string | null
  endedAt: string | null
  failure: string | null
  stopped: boolean
  items: TurnItem[]
}

const notificationTag = '<task-notification>'

const isNotification = (text: string) => text.trimStart().startsWith(notificationTag)

export const typedPromptCount = (state: AgentState) =>
  state.events.filter((event) => event.type === 'prompt' && !isNotification(event.data.text)).length

export const runningTool = (turn: Turn | undefined) =>
  turn?.items.some(
    (item) => item.kind === 'tools' && item.calls.some((call) => call.state === 'running'),
  ) ?? false

const notificationNote = (text: string) => {
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim()

  return summary || 'Background work finished'
}

const newTurn = (
  key: string,
  prompt: string | null,
  startedAt: string | null,
  by: Turn['by'] = null,
): Turn => ({
  key,
  prompt,
  by,
  startedAt,
  endedAt: null,
  failure: null,
  stopped: false,
  items: [],
})

const inputKeys = ['command', 'file_path', 'pattern', 'url', 'path']

const refuseCall = (calls: Map<string, ToolCall>, tool: string, input: Record<string, unknown>) => {
  const shown = inputKeys.flatMap((key) => (typeof input[key] === 'string' ? [input[key]] : []))
  const call = [...calls.values()]
    .reverse()
    .find(
      (entry) => entry.state === 'running' && entry.name === tool && shown.includes(entry.summary),
    )

  if (call) {
    call.state = 'denied'
  }
}

export const turnsOf = (state: AgentState, sessionId: string): Turn[] => {
  const turns: Turn[] = []
  const calls = new Map<string, ToolCall>()

  const current = (event: AgentEventValue) => {
    const last = turns.at(-1)

    if (last) {
      return last
    }

    const turn = newTurn(`session-${event.id}`, null, event.at)

    turns.push(turn)

    return turn
  }

  const addCall = (turn: Turn, call: ToolCall, id: string) => {
    calls.set(call.id, call)
    const last = turn.items.at(-1)

    if (last?.kind === 'tools') {
      last.calls.push(call)
    } else {
      turn.items.push({
        kind: 'tools',
        id,
        calls: [call],
      })
    }
  }

  for (const event of state.events) {
    if (event.session_id !== sessionId) {
      continue
    }

    switch (event.type) {
      case 'prompt':
        if (isNotification(event.data.text)) {
          current(event).items.push({
            kind: 'note',
            id: event.id,
            text: notificationNote(event.data.text),
          })
          break
        }

        turns.push(newTurn(event.id, event.data.text, event.at, event.data.by ?? null))
        break
      case 'message':
        current(event).items.push({
          kind: 'message',
          id: event.data.message_id,
          text: event.data.text,
        })
        break
      case 'tool.started':
        addCall(
          current(event),
          {
            id: event.data.tool_use_id,
            name: event.data.name,
            summary: event.data.summary,
            state: 'running',
            output: null,
            durationMs: null,
          },
          event.id,
        )
        break

      case 'tool.finished': {
        const existing = calls.get(event.data.tool_use_id)
        const finished = {
          state: event.data.is_error ? ('failed' as const) : ('done' as const),
          output: event.data.output ?? null,
          durationMs: event.data.duration_ms ?? null,
        }

        if (existing) {
          const failedBefore = existing.state === 'failed'

          Object.assign(existing, finished, {
            summary: event.data.summary || existing.summary,
          })

          if (failedBefore) {
            existing.state = 'failed'
            existing.output = existing.output ?? finished.output
          }
        } else {
          addCall(
            current(event),
            {
              id: event.data.tool_use_id,
              name: event.data.name,
              summary: event.data.summary,
              ...finished,
            },
            event.id,
          )
        }

        break
      }

      case 'tool.denied':
        addCall(
          current(event),
          {
            id: event.id,
            name: event.data.tool ?? 'tool',
            summary: event.data.summary ?? '',
            state: 'denied',
            output: null,
            durationMs: null,
          },
          event.id,
        )
        break

      case 'tool.blocked': {
        const call = event.data.tool_use_id ? calls.get(event.data.tool_use_id) : undefined

        if (call?.state === 'running') {
          call.state = 'denied'
        }

        current(event).items.push({
          kind: 'blocked',
          id: event.id,
          tool: event.data.tool,
          summary: event.data.summary ?? '',
          reason: event.data.reason ?? null,
        })
        break
      }

      case 'turn.changes':
        current(event).items.push({
          kind: 'changes',
          id: event.id,
          files: event.data.files,
          moreFiles: event.data.more_files ?? 0,
          commits: event.data.commits,
          truncated: event.data.truncated === true,
        })
        break

      case 'approval.requested':
        current(event).items.push({
          kind: 'approval',
          id: event.id,
          approvalId: event.data.approval_id,
          tool: event.data.tool,
          input: event.data.input,
          expiresAt: event.data.expires_at,
          truncated: event.data.truncated === true,
          status: 'pending',
          message: null,
        })
        break

      case 'approval.decided':
        for (const turn of turns) {
          for (const item of turn.items) {
            if (item.kind === 'approval' && item.approvalId === event.data.approval_id) {
              item.status = event.data.status
              item.message = event.data.message ?? null

              if (event.data.status !== 'allowed') {
                refuseCall(calls, item.tool, item.input)
              }
            }
          }
        }

        break

      case 'turn.ended': {
        const turn = current(event)

        turn.endedAt ??= event.at

        if (event.data.reason === 'interrupted') {
          turn.stopped = true
        }

        break
      }

      case 'turn.failed': {
        const turn = current(event)

        turn.endedAt ??= event.at
        turn.failure = event.data.error_details ?? event.data.error
        break
      }

      default:
        break
    }
  }

  for (const [messageId, held] of Object.entries(state.parts)) {
    if (held.session_id !== sessionId) {
      continue
    }

    const turn = turns.at(-1) ?? newTurn(`live-${messageId}`, null, null)

    if (!turns.length) {
      turns.push(turn)
    }

    turn.items.push({
      kind: 'live',
      id: messageId,
      text: joinedParts(held),
    })
  }

  return turns
}

const editTools = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

const searchTools = new Set(['Grep', 'Glob'])

const verbOf = (name: string) => {
  if (name === 'Bash') {
    return 'ran'
  }

  if (name === 'Read') {
    return 'read'
  }

  if (editTools.has(name)) {
    return 'edited'
  }

  if (searchTools.has(name)) {
    return 'searched'
  }

  return 'used'
}

const objectOf = (verb: string, count: number) => {
  if (verb === 'ran') {
    return plural(count, 'command')
  }

  if (verb === 'searched') {
    return plural(count, 'time')
  }

  if (verb === 'used') {
    return plural(count, 'other tool')
  }

  return count === 1 ? 'a file' : `${count} files`
}

export const toolSentence = (calls: readonly ToolCall[]) => {
  const counts = new Map<string, number>()
  const denied = deniedCalls(calls)

  for (const call of calls.filter((entry) => entry.state !== 'denied')) {
    const verb = verbOf(call.name)

    counts.set(verb, (counts.get(verb) ?? 0) + 1)
  }

  const text = [
    ...[...counts].map(([verb, count]) => `${verb} ${objectOf(verb, count)}`),
    ...(denied ? [`${denied} denied`] : []),
  ].join(', ')

  return text.charAt(0).toUpperCase() + text.slice(1)
}

export const deniedCalls = (calls: readonly ToolCall[]) =>
  calls.filter((call) => call.state === 'denied').length

export const failedCalls = (calls: readonly ToolCall[]) =>
  calls.filter((call) => call.state === 'failed').length

export const runningCalls = (calls: readonly ToolCall[]) =>
  calls.filter((call) => call.state === 'running').length

export type AgentStatusView = {
  label: string
  tone: Tone
  pulse: boolean
  dot: boolean
}

const statusViews: Record<AgentStatusValue, AgentStatusView> = {
  none: {
    label: 'No conversation yet',
    tone: 'neutral',
    pulse: false,
    dot: false,
  },
  working: {
    label: 'Working',
    tone: 'violet',
    pulse: true,
    dot: true,
  },
  waiting: {
    label: 'Waiting on you',
    tone: 'warning',
    pulse: true,
    dot: true,
  },
  ready: {
    label: 'Finished',
    tone: 'success',
    pulse: false,
    dot: true,
  },
  failed: {
    label: 'Turn failed',
    tone: 'danger',
    pulse: false,
    dot: true,
  },
  ended: {
    label: 'Conversation ended',
    tone: 'neutral',
    pulse: false,
    dot: true,
  },
}

export const agentStatusView = (
  record:
    | (Pick<AgentStatusRecord, 'status' | 'last_event_at'> &
        Partial<Pick<AgentStatusRecord, 'agents'>>)
    | null
    | undefined,
  now = new Date(),
): AgentStatusView => {
  const view = statusViews[record?.status ?? 'none']

  if (record?.status !== 'working' || !record.last_event_at) {
    return view
  }

  const background = record.agents?.length ?? 0

  const idleS = Math.floor((now.getTime() - new Date(record.last_event_at).getTime()) / 1000)

  if (idleS < staleWorkingS) {
    return background > 0
      ? {
          ...view,
          label: `Working, ${plural(background, 'background agent')}`,
        }
      : view
  }

  return {
    ...view,
    label: `Working, no activity for ${Math.floor(idleS / 60)} min`,
    pulse: false,
  }
}

export const attentionText = {
  permission: 'Approve a tool call',
  question: 'Answer a question',
  plan: 'Approve a plan',
} as const

type Scope = {
  project_id: string
  target: string
  level: string
}

export const isInstanceAdmin = (scopes: readonly Scope[]) =>
  scopes.some(
    (scope) => scope.level === 'admin' && scope.project_id === '*' && scope.target === '*',
  )

export const modelOf = (state: AgentState, sessionId: string) => {
  for (const event of state.events) {
    if (event.type === 'session.started' && event.session_id === sessionId) {
      return event.data.model ?? null
    }
  }

  return null
}
