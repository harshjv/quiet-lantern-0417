import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter, on } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

import { runnerAskRules, toolApprovalWaitS, type AgentEventInputValue } from '@stationly/protocol'

import { env, projectEnv, tokenEnv } from '../env.ts'

import type { AgentAdapter, AgentExit } from './adapter.ts'
import { stationlyBriefing, stationlyMcpConfig, stationlyServer } from './briefing.ts'
import { claudeProgress } from './claude-progress.ts'

export const runnerDir = () => join(homedir(), '.local', 'state', 'stationly', 'runner')

export const approveHookTimeoutS = toolApprovalWaitS + 30

export const claudeSettings = {
  permissions: {
    defaultMode: 'auto',
    denyInsteadOfPrompting: true,
    allow: [`mcp__${stationlyServer}`],
    ask: [...runnerAskRules],
  },
  hooks: {
    PermissionRequest: [
      {
        hooks: [
          {
            type: 'command',
            command: '/usr/local/bin/sly agent approve',
            timeout: approveHookTimeoutS,
          },
        ],
      },
    ],
    PermissionDenied: [
      {
        hooks: [
          {
            type: 'command',
            command: '/usr/local/bin/sandbox-agent-hook',
            timeout: 5,
          },
        ],
      },
    ],
  },
} as const

type StationlyContext = { mcpPath: string; briefing: string }

export const claudeArgs = (
  options: { sessionId: string; resume: boolean; model: string | null },
  settingsPath: string,
  stationly: StationlyContext | null = null,
) => [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--replay-user-messages',
  '--include-partial-messages',
  options.resume ? '--resume' : '--session-id',
  options.sessionId,
  ...(options.model ? ['--model', options.model] : []),
  '--permission-mode',
  'auto',
  '--settings',
  settingsPath,
  ...(stationly
    ? ['--mcp-config', stationly.mcpPath, '--append-system-prompt', stationly.briefing]
    : []),
]

const stationlyContext = (dir: string): StationlyContext | null => {
  if (!env[tokenEnv]) {
    return null
  }

  const mcpPath = join(dir, 'mcp.json')

  writeFileSync(mcpPath, JSON.stringify(stationlyMcpConfig('/usr/local/bin/sly')))

  return {
    mcpPath,
    briefing: stationlyBriefing(env[projectEnv]),
  }
}

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

async function* progressEvents(live: EventEmitter): AsyncIterable<AgentEventInputValue> {
  for await (const [event] of on(live, 'progress', {
    close: ['end'],
  })) {
    yield event as AgentEventInputValue
  }
}

export const isResult = (line: string) => {
  try {
    return (JSON.parse(line) as { type?: unknown }).type === 'result'
  } catch {
    return false
  }
}

export const claudeAdapter = (command = 'claude', dir = runnerDir()): AgentAdapter => ({
  agent: 'claude',
  start: (options) => {
    mkdirSync(dir, {
      recursive: true,
    })

    const settingsPath = join(dir, 'settings.json')

    writeFileSync(settingsPath, JSON.stringify(claudeSettings))

    const child = spawn(command, claudeArgs(options, settingsPath, stationlyContext(dir)), {
      cwd: options.cwd,
      env: {
        ...process.env,
        STATIONLY_RUNNER: '1',
      },
      stdio: ['pipe', 'pipe', 'inherit'],
    })

    child.stdin.on('error', () => undefined)

    const progress = claudeProgress()
    const live = new EventEmitter()
    let results = 0
    let waiters: { at: number; resolve: () => void }[] = []
    let taken = 0

    createInterface({
      input: child.stdout,
    }).on('line', (line) => {
      const data = progress(line)

      if (data) {
        live.emit('progress', {
          id: `progress-${randomUUID()}`,
          type: 'progress',
          at: new Date().toISOString(),
          session_id: options.sessionId,
          data,
        } satisfies AgentEventInputValue)
      }

      if (!isResult(line)) {
        return
      }

      results += 1
      waiters = waiters.filter((waiter) => {
        if (waiter.at <= results) {
          waiter.resolve()

          return false
        }

        return true
      })
    })

    const exit = new Promise<AgentExit>((resolve) => {
      child.on('error', () => {
        live.emit('end')
        resolve({
          code: 127,
          signal: null,
        })
      })
      child.on('close', (code, signal) => {
        live.emit('end')
        resolve({
          code,
          signal,
        })
      })
    })

    return {
      send: (text) => void child.stdin.write(userLine(text)),
      interrupt: () => void child.stdin.write(interruptLine()),
      close: () => void child.stdin.end(),
      halt: () => {
        child.kill('SIGINT')
        setTimeout(() => child.kill('SIGTERM'), graceMs).unref()
      },
      nextResult: () => {
        taken += 1
        const at = taken

        return at <= results
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              waiters.push({
                at,
                resolve,
              })
            })
      },
      stop: () => {
        child.stdin.end()
        setTimeout(() => child.kill('SIGTERM'), graceMs).unref()
      },
      events: progressEvents(live),
      exit,
    }
  },
})
