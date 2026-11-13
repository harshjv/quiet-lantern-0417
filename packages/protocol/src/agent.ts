import { Type, type Static, type TSchema } from '@sinclair/typebox'

import { StringEnum } from './primitives.ts'

export const agentStatusValues = ['none', 'working', 'waiting', 'ready', 'failed', 'ended'] as const

export const agentAttentionKindValues = ['permission', 'question', 'plan'] as const

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
  perSandboxBytes: 64 * 1024 * 1024,
  perSandboxCount: 100000,
  requestsPerMinute: 120,
  staleWorkingS: 300,
} as const

const Text = Type.String()

const Truncated = Type.Optional(Type.Boolean())

const agentEventData = {
  'session.started': Type.Object({
    source: Type.Optional(Text),
    model: Type.Optional(Text),
    cwd: Type.Optional(Text),
    version: Type.Optional(Text),
  }),
  'session.ended': Type.Object({
    reason: Type.Optional(Text),
  }),
  prompt: Type.Object({
    text: Text,
    truncated: Truncated,
  }),
  'message.part': Type.Object({
    message_id: Text,
    index: Type.Integer({
      minimum: 0,
    }),
    final: Type.Boolean(),
    text: Text,
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
  attention: Type.Object({
    kind: StringEnum(agentAttentionKindValues),
    tool: Type.Optional(Text),
    summary: Type.Optional(Text),
    message: Type.Optional(Text),
  }),
  'turn.ended': Type.Object({
    text: Type.Optional(Text),
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

export const agentStoredEventTypeValues = agentEventTypeValues.filter(
  (type) => type !== 'message.part',
)

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
  agentEventTypeValues.map((type) => eventSchema(type)),
  {
    description: 'One event a workspace relay reports about its agent session',
  },
)

export type AgentEventInputValue = Static<typeof AgentEventInput>

export const AgentEvent = Type.Union(
  agentStoredEventTypeValues.map((type) =>
    eventSchema(type, {
      seq: Type.Integer(),
    }),
  ),
  {
    description: 'One stored event of an agent session; seq is the sandbox cursor',
  },
)

const AgentEventEnvelope = Type.Object(agentEventBase)

type AgentStoredEventType = (typeof agentStoredEventTypeValues)[number]

export type AgentEventValue = {
  [K in AgentStoredEventType]: Static<typeof AgentEventEnvelope> & {
    type: K
    seq: number
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
