import type { AgentEventInputValue, WorkspaceAgent } from '@stationly/protocol'

export type AgentExit = { code: number | null; signal: string | null }

export type AgentProcess = {
  send: (text: string) => void
  interrupt: () => void
  stop: () => void
  events: AsyncIterable<AgentEventInputValue> | null
  exit: Promise<AgentExit>
}

export type StartOptions = {
  sessionId: string
  resume: boolean
  model: string | null
  cwd: string
}

export type AgentAdapter = {
  agent: WorkspaceAgent
  start: (options: StartOptions) => AgentProcess
}
