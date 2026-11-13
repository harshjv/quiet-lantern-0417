import type { AgentEventInputValue } from '@stationly/protocol'

export type HookPayload = Record<string, unknown>

type Mapped = Pick<AgentEventInputValue, 'type' | 'data'>

type Context = {
  version?: string
}

export const transportCapBytes = 32 * 1024

const summaryKeys: Record<string, string> = {
  Bash: 'command',
  Read: 'file_path',
  Edit: 'file_path',
  Write: 'file_path',
  Grep: 'pattern',
  Glob: 'pattern',
}

const rawText = (value: unknown) => (typeof value === 'string' ? value : undefined)

const clipped = (value: string) => {
  const bytes = Buffer.from(value)

  if (bytes.length <= transportCapBytes) {
    return {
      text: value,
      truncated: undefined,
    }
  }

  return {
    text: bytes.subarray(0, transportCapBytes).toString().replace(/�+$/, ''),
    truncated: true,
  }
}

const text = (value: unknown) => {
  const raw = rawText(value)

  return raw === undefined ? undefined : clipped(raw).text
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}

const firstLine = (value: string) => value.split('\n', 1)[0]!

export const summaryOf = (tool: string, input: unknown) => {
  const fields = record(input)
  const named = text(fields[summaryKeys[tool] ?? ''])
  const first = named ?? Object.values(fields).find((value) => typeof value === 'string')

  return clipped(firstLine(typeof first === 'string' ? first : '')).text
}

export const attentionKindOf = (tool: string | undefined) => {
  if (tool === 'AskUserQuestion') {
    return 'question' as const
  }

  if (tool === 'ExitPlanMode') {
    return 'plan' as const
  }

  return 'permission' as const
}

const outputOf = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value))

const clippedOutput = (value: unknown) => {
  const raw = outputOf(value)

  return raw === undefined ? undefined : clipped(raw).text
}

const toolEvent = (payload: HookPayload) => {
  const id = text(payload.tool_use_id)
  const name = text(payload.tool_name)

  return id && name
    ? {
        id,
        name,
        summary: summaryOf(name, payload.tool_input),
      }
    : null
}

const duration = (payload: HookPayload) =>
  typeof payload.duration_ms === 'number' ? Math.trunc(payload.duration_ms) : undefined

const finished = (payload: HookPayload, failed: boolean): Mapped | null => {
  const tool = toolEvent(payload)

  if (!tool) {
    return null
  }

  const raw = outputOf(failed ? payload.error : payload.tool_response)
  const output = raw === undefined ? undefined : clipped(raw)

  return {
    type: 'tool.finished',
    data: {
      tool_use_id: tool.id,
      name: tool.name,
      summary: tool.summary,
      is_error: failed,
      duration_ms: duration(payload),
      output: output?.text,
      truncated: output?.truncated,
    },
  }
}

const attention = (
  kind: 'permission' | 'question' | 'plan',
  fields: { tool?: string; summary?: string; message?: string },
): Mapped => ({
  type: 'attention',
  data: {
    kind,
    ...fields,
  },
})

const notification = (payload: HookPayload): Mapped | null => {
  const kinds: Record<string, 'permission' | 'question'> = {
    permission_prompt: 'permission',
    elicitation_dialog: 'question',
    agent_needs_input: 'question',
  }
  const kind = kinds[text(payload.notification_type) ?? '']

  return kind
    ? attention(kind, {
        message: text(payload.message),
      })
    : null
}

const permission = (payload: HookPayload): Mapped | null => {
  const tool = text(payload.tool_name)

  return tool
    ? attention(attentionKindOf(tool), {
        tool,
        summary: summaryOf(tool, payload.tool_input),
      })
    : null
}

const elicitation = (payload: HookPayload): Mapped | null => {
  const server = text(payload.mcp_server_name)

  return server
    ? attention('question', {
        tool: server,
        message: text(payload.message),
      })
    : null
}

const turnFailed = (payload: HookPayload): Mapped | null => {
  const error = text(payload.error)

  return error
    ? {
        type: 'turn.failed',
        data: {
          error,
          error_details: clippedOutput(payload.error_details),
          text: text(payload.last_assistant_message),
        },
      }
    : null
}

const messagePart = (payload: HookPayload): Mapped | null => {
  const id = text(payload.message_id)
  const delta = rawText(payload.delta)
  const { index, final } = payload

  if (!id || delta === undefined || !Number.isInteger(index) || typeof final !== 'boolean') {
    return null
  }

  return {
    type: 'message.part',
    data: {
      message_id: id,
      index: index as number,
      final,
      text: clipped(delta).text,
    },
  }
}

const prompt = (payload: HookPayload): Mapped | null => {
  const submitted = rawText(payload.prompt)

  if (submitted === undefined) {
    return null
  }

  const cut = clipped(submitted)

  return {
    type: 'prompt',
    data: {
      text: cut.text,
      truncated: cut.truncated,
    },
  }
}

const turnEnded = (payload: HookPayload): Mapped => {
  const last = rawText(payload.last_assistant_message)
  const cut = last === undefined ? undefined : clipped(last)

  return {
    type: 'turn.ended',
    data: {
      text: cut?.text,
      truncated: cut?.truncated,
    },
  }
}

const subagent =
  (type: 'subagent.started' | 'subagent.stopped') =>
  (payload: HookPayload): Mapped | null =>
    text(payload.agent_id)
      ? {
          type,
          data: {
            agent_type: text(payload.agent_type),
          },
        }
      : null

const mappers: Record<string, (payload: HookPayload, context: Context) => Mapped | null> = {
  SessionStart: (payload, context) => ({
    type: 'session.started',
    data: {
      source: text(payload.source),
      model: text(payload.model),
      cwd: text(payload.cwd),
      version: context.version,
    },
  }),
  SessionEnd: (payload) => ({
    type: 'session.ended',
    data: {
      reason: text(payload.reason),
    },
  }),
  UserPromptSubmit: prompt,
  MessageDisplay: messagePart,
  PreToolUse: (payload) => {
    const tool = toolEvent(payload)

    return tool
      ? {
          type: 'tool.started',
          data: {
            tool_use_id: tool.id,
            name: tool.name,
            summary: tool.summary,
          },
        }
      : null
  },
  PostToolUse: (payload) => finished(payload, false),
  PostToolUseFailure: (payload) => finished(payload, true),
  PermissionRequest: permission,
  Notification: notification,
  Elicitation: elicitation,
  SubagentStart: subagent('subagent.started'),
  SubagentStop: subagent('subagent.stopped'),
  Stop: turnEnded,
  StopFailure: turnFailed,
}

export const needsVersion = (payload: HookPayload) =>
  payload.hook_event_name === 'SessionStart' && text(payload.session_id) !== undefined

export const eventOf = (
  name: string,
  payload: HookPayload,
  context: Context = {},
): AgentEventInputValue | null => {
  const hook = text(payload.hook_event_name)
  const session = text(payload.session_id)
  const mapped = hook ? mappers[hook]?.(payload, context) : null
  const nanoseconds = /^(\d+)-/.exec(name)?.[1]

  if (!mapped || !session || !nanoseconds) {
    return null
  }

  const identifiers = {
    prompt_id: text(payload.prompt_id),
    turn_id: text(payload.turn_id),
    agent_id: text(payload.agent_id),
  }

  return {
    id: name.replace(/\.json$/, ''),
    at: new Date(Number(BigInt(nanoseconds) / 1_000_000n)).toISOString(),
    session_id: session,
    ...identifiers,
    ...mapped,
  }
}
