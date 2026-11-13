import type { AgentEventValue } from '@stationly/protocol'

export const agentStreamTypes: readonly (AgentEventValue['type'] | 'message.part')[] = [
  'session.started',
  'session.ended',
  'prompt',
  'message.part',
  'message',
  'tool.started',
  'tool.finished',
  'attention',
  'turn.ended',
  'turn.failed',
  'subagent.started',
  'subagent.stopped',
  'omitted',
]

export const agentStreamUrl = (sandbox: string) => `/v1/sandboxes/${sandbox}/agent/events`
