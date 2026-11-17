import { Type, type Static, type TSchema } from '@sinclair/typebox'

import { StringEnum } from './primitives.ts'

export const agentStatusValues = ['none', 'working', 'waiting', 'ready', 'failed', 'ended'] as const

export const agentAttentionKindValues = ['permission', 'question', 'plan'] as const

export const agentProgressKindValues = ['thinking', 'writing', 'retrying'] as const

export const toolApprovalStatusValues = ['pending', 'allowed', 'denied', 'expired'] as const

export const toolApprovalClosedValues = ['allowed', 'denied', 'expired'] as const

export type ToolApprovalStatusValue = (typeof toolApprovalStatusValues)[number]

export const shipPhaseValues = ['pushing', 'open', 'failed', 'merged'] as const

export type ShipPhaseValue = (typeof shipPhaseValues)[number]

export const toolApprovalWaitS = 600

export const runnerAskRules = [
  'Bash(git push --force*)',
  'Bash(git push -f*)',
  'Bash(git push * main)',
  'Bash(git push * master)',
  'Bash(gh pr merge*)',
  'Bash(gh release*)',
  'Bash(npm publish*)',
] as const

export const taskStatusValues = [
  'queued',
  'setting_up',
  'working',
  'waiting',
  'finished',
  'failed',
  'stopped',
] as const

export type TaskStatusValue = (typeof taskStatusValues)[number]

export const taskMachineValues = ['project', 'own'] as const

export type TaskMachineValue = (typeof taskMachineValues)[number]

export const taskSlotMemoryBytes = 2 * 1024 ** 3

export const taskSlotsDefault = 2

export const taskPortRange = {
  first: 3000,
  last: 3099,
} as const

export const taskWorktreeRoot = '/home/agent/tasks'

export const agentEventLimits = {
  batch: 100,
  string: 4096,
  message: 16384,
  event: 20480,
  raw: 131072,
  failedOutput: 512,
  toolOutput: 4096,
  partsHeld: 65536,
  partsIdleS: 60,
  perMachineBytes: 64 * 1024 * 1024,
  perMachineCount: 100000,
  requestsPerMinute: 240,
  requestsPerExtraSlot: 60,
  staleWorkingS: 300,
} as const

const Text = Type.String()

const Truncated = Type.Optional(Type.Boolean())

const agentEventData = {
  'session.started': Type.Object({
    source: Type.Optional(Text),
    model: Type.Optional(Text),
    cwd: Type.Optional(Text),
    branch: Type.Optional(Text),
    version: Type.Optional(Text),
  }),
  'session.ended': Type.Object({
    reason: Type.Optional(Text),
  }),
  prompt: Type.Object({
    text: Text,
    truncated: Truncated,
    by: Type.Optional(
      Type.Object({
        type: Text,
        id: Type.Union([Text, Type.Null()]),
      }),
    ),
  }),
  'message.part': Type.Object({
    message_id: Text,
    index: Type.Integer({
      minimum: 0,
    }),
    final: Type.Boolean(),
    text: Text,
  }),
  progress: Type.Object({
    key: Text,
    kind: StringEnum(agentProgressKindValues),
    text: Type.Optional(Text),
    tokens: Type.Optional(
      Type.Integer({
        minimum: 0,
      }),
    ),
    attempt: Type.Optional(
      Type.Integer({
        minimum: 0,
      }),
    ),
    error: Type.Optional(Text),
  }),
  message: Type.Object({
    message_id: Text,
    text: Text,
    truncated: Truncated,
  }),
  'tool.started': Type.Object({
    tool_use_id: Text,
    name: Text,
    summary: Text,
    truncated: Truncated,
  }),
  'tool.finished': Type.Object({
    tool_use_id: Text,
    name: Text,
    summary: Text,
    is_error: Type.Boolean(),
    duration_ms: Type.Optional(Type.Integer()),
    output: Type.Optional(Text),
    truncated: Truncated,
  }),
  'tool.denied': Type.Object({
    tool: Type.Optional(Text),
    summary: Type.Optional(Text),
  }),
  'tool.blocked': Type.Object({
    tool_use_id: Type.Optional(Text),
    tool: Text,
    summary: Type.Optional(Text),
    reason: Type.Optional(Text),
    truncated: Truncated,
  }),
  'approval.requested': Type.Object({
    approval_id: Text,
    tool: Text,
    input: Type.Record(Type.String(), Type.Unknown()),
    expires_at: Text,
    truncated: Truncated,
  }),
  'approval.decided': Type.Object({
    approval_id: Text,
    status: StringEnum(toolApprovalClosedValues),
    by: Type.Optional(
      Type.Object({
        type: Text,
        id: Type.Union([Text, Type.Null()]),
      }),
    ),
    message: Type.Optional(Text),
  }),
  attention: Type.Object({
    kind: StringEnum(agentAttentionKindValues),
    tool: Type.Optional(Text),
    summary: Type.Optional(Text),
    message: Type.Optional(Text),
  }),
  'turn.ended': Type.Object({
    text: Type.Optional(Text),
    reason: Type.Optional(Text),
    truncated: Truncated,
  }),
  'turn.changes': Type.Object({
    files: Type.Array(
      Type.Object({
        path: Text,
        added: Type.Union([Type.Integer(), Type.Null()]),
        removed: Type.Union([Type.Integer(), Type.Null()]),
        diff: Type.Optional(Text),
      }),
    ),
    more_files: Type.Optional(Type.Integer()),
    commits: Type.Array(
      Type.Object({
        sha: Text,
        subject: Text,
      }),
    ),
    truncated: Truncated,
  }),
  'turn.failed': Type.Object({
    error: Text,
    error_details: Type.Optional(Text),
    text: Type.Optional(Text),
  }),
  'subagent.started': Type.Object({
    agent_type: Type.Optional(Text),
  }),
  'subagent.stopped': Type.Object({
    agent_type: Type.Optional(Text),
  }),
  omitted: Type.Object({
    count: Type.Integer({
      minimum: 0,
    }),
  }),
}

export type AgentEventType = keyof typeof agentEventData

export const agentEventTypeValues = Object.keys(agentEventData) as AgentEventType[]

export const agentLiveEventTypeValues = ['message.part', 'progress'] as const

export const agentDispatchEventTypeValues = ['approval.requested', 'approval.decided'] as const

export const isDispatchAgentEvent = (type: string) =>
  (agentDispatchEventTypeValues as readonly string[]).includes(type)

export type AgentLiveEventType = (typeof agentLiveEventTypeValues)[number]

export const isLiveAgentEvent = (type: string): type is AgentLiveEventType =>
  (agentLiveEventTypeValues as readonly string[]).includes(type)

export const agentStoredEventTypeValues = agentEventTypeValues.filter(
  (type): type is Exclude<AgentEventType, AgentLiveEventType> => !isLiveAgentEvent(type),
)

export type AgentProgressData = Static<(typeof agentEventData)['progress']>

const agentEventBase = {
  id: Type.String({
    minLength: 1,
    maxLength: 128,
  }),
  at: Type.String(),
  session_id: Type.String({
    minLength: 1,
    maxLength: 128,
  }),
  prompt_id: Type.Optional(Type.String()),
  turn_id: Type.Optional(Type.String()),
  agent_id: Type.Optional(Type.String()),
}

const eventSchema = <T extends AgentEventType>(type: T, extra: Record<string, TSchema> = {}) =>
  Type.Object(
    {
      ...agentEventBase,
      ...extra,
      type: Type.Literal(type),
      data: agentEventData[type],
    },
    {
      additionalProperties: false,
    },
  )

export const AgentEventInput = Type.Union(
  agentEventTypeValues
    .filter((type) => !isDispatchAgentEvent(type))
    .map((type) => eventSchema(type)),
  {
    description: 'One event a workspace relay reports about its agent session',
  },
)

export type AgentEventInputValue = Static<typeof AgentEventInput>

export const AgentEvent = Type.Union(
  agentStoredEventTypeValues.map((type) =>
    eventSchema(type, {
      seq: Type.Integer(),
      conversation_id: Type.String(),
    }),
  ),
  {
    description: "One stored event of a task's conversation; seq is the task cursor",
  },
)

const AgentEventEnvelope = Type.Object(agentEventBase)

type AgentStoredEventType = (typeof agentStoredEventTypeValues)[number]

export type AgentEventValue = {
  [K in AgentStoredEventType]: Static<typeof AgentEventEnvelope> & {
    type: K
    seq: number
    conversation_id: string
    data: Static<(typeof agentEventData)[K]>
  }
}[AgentStoredEventType]

export type AgentStatusValue = (typeof agentStatusValues)[number]

export const AgentEventsInput = Type.Object(
  {
    events: Type.Array(AgentEventInput, {
      minItems: 1,
      maxItems: agentEventLimits.batch,
    }),
  },
  {
    additionalProperties: false,
    description: 'A batch of at most 100 events; a repeated id is ignored',
  },
)

export const AgentEventsAccepted = Type.Object(
  {
    accepted: Type.Integer(),
    duplicates: Type.Integer(),
  },
  {
    additionalProperties: false,
  },
)

export const AgentStatus = Type.Object(
  {
    status: StringEnum(agentStatusValues),
    since: Type.String(),
    session_id: Type.Union([Type.String(), Type.Null()]),
    kind: Type.Union([StringEnum(agentAttentionKindValues), Type.Null()]),
    agents: Type.Array(Type.String()),
    last_event_at: Type.Union([Type.String(), Type.Null()]),
  },
  {
    additionalProperties: false,
  },
)

export type AgentStatusRecord = Static<typeof AgentStatus>

export const AgentInboxItem = Type.Object(
  {
    id: Type.String(),
    seq: Type.Integer(),
    kind: StringEnum(['prompt', 'interrupt']),
    text: Type.Union([Type.String(), Type.Null()]),
  },
  {
    additionalProperties: false,
  },
)

export const AgentInbox = Type.Object(
  {
    items: Type.Array(AgentInboxItem),
  },
  {
    additionalProperties: false,
  },
)

export const AgentInboxAck = Type.Object(
  {
    ids: Type.Array(Type.String(), {
      minItems: 1,
      maxItems: 100,
    }),
  },
  {
    additionalProperties: false,
  },
)

export const AgentApprovalRequest = Type.Object(
  {
    id: Type.String({
      minLength: 1,
      maxLength: 128,
    }),
    session_id: Type.String({
      minLength: 1,
      maxLength: 128,
    }),
    agent_id: Type.Optional(Type.String()),
    tool_name: Type.String({
      minLength: 1,
    }),
    tool_input: Type.Record(Type.String(), Type.Unknown()),
  },
  {
    additionalProperties: false,
  },
)

export const AgentApprovalState = Type.Object(
  {
    id: Type.String(),
    status: StringEnum(toolApprovalStatusValues),
    behavior: Type.Union([StringEnum(['allow', 'deny']), Type.Null()]),
    message: Type.Union([Type.String(), Type.Null()]),
    expires_at: Type.String(),
  },
  {
    additionalProperties: false,
  },
)

export const AgentRunnerExit = Type.Object(
  {
    session: Type.String(),
    failed: Type.Optional(Type.Boolean()),
  },
  {
    additionalProperties: false,
  },
)

export const agentPromptLimit = 32768
