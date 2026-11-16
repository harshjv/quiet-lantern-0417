import type { AgentEventValue } from '@stationly/protocol'

export const agentStreamTypes: readonly (AgentEventValue['type'] | 'message.part' | 'progress')[] =
  [
    'session.started',
    'session.ended',
    'prompt',
    'message.part',
    'progress',
    'message',
    'tool.started',
    'tool.finished',
    'tool.denied',
    'tool.blocked',
    'turn.changes',
    'approval.requested',
    'approval.decided',
    'attention',
    'turn.ended',
    'turn.failed',
    'subagent.started',
    'subagent.stopped',
    'omitted',
  ]

export const taskStreamUrl = (task: string) => `/v1/tasks/${encodeURIComponent(task)}/events`
