import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { AgentAdapter, AgentExit } from './adapter.ts'

export const runnerDir = () => join(homedir(), '.local', 'state', 'stationly', 'runner')

export const claudeSettings = {
  permissions: {
    defaultMode: 'auto',
    denyInsteadOfPrompting: true,
  },
} as const

export const claudeArgs = (
  options: { sessionId: string; resume: boolean; model: string | null },
  settingsPath: string,
) => [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--replay-user-messages',
  options.resume ? '--resume' : '--session-id',
  options.sessionId,
  ...(options.model ? ['--model', options.model] : []),
  '--permission-mode',
  'auto',
  '--settings',
  settingsPath,
]

export const userLine = (text: string) =>
  `${JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: text,
    },
  })}\n`

export const interruptLine = (requestId: string = randomUUID()) =>
  `${JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: {
      subtype: 'interrupt',
    },
  })}\n`

const graceMs = 5000

export const claudeAdapter = (command = 'claude', dir = runnerDir()): AgentAdapter => ({
  agent: 'claude',
  start: (options) => {
    mkdirSync(dir, {
      recursive: true,
    })

    const settingsPath = join(dir, 'settings.json')

    writeFileSync(settingsPath, JSON.stringify(claudeSettings))

    const child = spawn(command, claudeArgs(options, settingsPath), {
      cwd: options.cwd,
      env: {
        ...process.env,
        STATIONLY_RUNNER: '1',
      },
      stdio: ['pipe', 'pipe', 'inherit'],
    })

    child.stdout.resume()
    child.stdin.on('error', () => undefined)

    const exit = new Promise<AgentExit>((resolve) => {
      child.on('error', () =>
        resolve({
          code: 127,
          signal: null,
        }),
      )
      child.on('close', (code, signal) =>
        resolve({
          code,
          signal,
        }),
      )
    })

    return {
      send: (text) => void child.stdin.write(userLine(text)),
      interrupt: () => void child.stdin.write(interruptLine()),
      stop: () => {
        child.stdin.end()
        setTimeout(() => child.kill('SIGTERM'), graceMs).unref()
      },
      events: null,
      exit,
    }
  },
})
