import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { createApiClient } from '@stationly/api-client'
import { toolApprovalWaitS, type AgentEventInputValue } from '@stationly/protocol'

import { realDeps, relay, type PostResult } from '../agent-relay.ts'
import { gitChanges } from '../agent/changes.ts'
import { claudeAdapter, runnerDir } from '../agent/claude.ts'
import { runSession, type InboxItem } from '../agent/runner.ts'
import { action, type Program } from '../command.ts'
import { env, machineIdEnv } from '../env.ts'
import { exitCodes, usage } from '../errors.ts'
import { credentialHeaders } from '../http.ts'
import { connect, type Run } from '../kit.ts'

type Issue = { path?: unknown }

const badIndexesOf = (value: unknown) => {
  const issues = (value as { error?: { details?: { issues?: Issue[] } } } | null)?.error?.details
    ?.issues

  return (issues ?? []).flatMap((issue) => {
    const index = /^\/events\/(\d+)(\/|$)/.exec(String(issue.path))?.[1]

    return index === undefined ? [] : [Number(index)]
  })
}

const clientOf = ({ credentials, userAgent }: Run) =>
  createApiClient(credentials.instance, async (input, init) => {
    const request = new Request(input, init)

    for (const [name, value] of Object.entries(
      await credentialHeaders(credentials, request.method, request.url),
    )) {
      request.headers.set(name, value)
    }

    request.headers.set('user-agent', userAgent)

    return fetch(request)
  })

const poster = (run: Run, machine: string) => {
  const api = clientOf(run)

  return async (events: AgentEventInputValue[]) => {
    const { status, response, error } = await api.v1
      .machines({
        machine,
      })
      .agent.events.post({
        events,
      })
    const retryAfter = Number(response.headers.get('retry-after'))
    const result: PostResult = {
      status,
      retryAfterS: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      badIndexes: badIndexesOf(error?.value),
    }

    return result
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)

    return true
  } catch {
    return false
  }
}

const holderOf = (file: string) => {
  try {
    return Number(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const holdLock = (session: string) => {
  const dir = runnerDir()
  const file = join(dir, `${session}.pid`)

  mkdirSync(dir, {
    recursive: true,
  })

  const pid = holderOf(file)

  if (pid !== null && pid !== process.pid && alive(pid)) {
    return null
  }

  writeFileSync(file, String(process.pid))

  return () =>
    rmSync(file, {
      force: true,
    })
}

const inboxOf = (run: Run, machine: string, session: string) => {
  const api = clientOf(run)
  const agentApi = api.v1.machines({
    machine,
  }).agent
  const box = agentApi.inbox

  return {
    inbox: async (after: number, waitS: number): Promise<InboxItem[]> => {
      const { data, error } = await box.get({
        query: {
          session,
          after,
          wait_s: waitS,
        },
      })

      if (error || !data) {
        throw new Error('the inbox did not answer')
      }

      return data.items
    },
    ack: async (ids: string[]) => {
      await box.ack.post({
        ids,
      })
    },
    exited: async (failed: boolean) => {
      const { error } = await agentApi.runner.exit.post({
        session,
        failed,
      })

      if (error) {
        throw new Error('the exit report did not go through')
      }
    },
  }
}

const readStdin = async () => {
  const chunks: Buffer[] = []

  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }

  return Buffer.concat(chunks).toString('utf8')
}

const decisionLine = (behavior: 'allow' | 'deny', message: string | null) =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision:
        behavior === 'allow'
          ? {
              behavior,
            }
          : {
              behavior,
              message: message ?? 'The task owner denied this in Stationly.',
            },
    },
  })

const textOf = (value: unknown) => (typeof value === 'string' ? value : '')

const approve = async (run: Run, machine: string, hook: Record<string, unknown>) => {
  const api = clientOf(run).v1.machines({
    machine,
  }).agent.approvals
  const id = `${process.hrtime.bigint()}-${process.pid}`
  const posted = await api.post({
    id,
    session_id: textOf(hook.session_id),
    ...(typeof hook.agent_id === 'string'
      ? {
          agent_id: hook.agent_id,
        }
      : {}),
    tool_name: textOf(hook.tool_name),
    tool_input: (hook.tool_input ?? {}) as Record<string, unknown>,
  })

  if (posted.error || !posted.data) {
    return null
  }

  const deadline = Date.now() + toolApprovalWaitS * 1000

  for (let state = posted.data; Date.now() < deadline;) {
    if (state.status !== 'pending') {
      return state.behavior ? decisionLine(state.behavior, state.message) : null
    }

    const next = await api({
      approval: id,
    })
      .get({
        query: {
          wait_s: 25,
        },
      })
      .catch(() => null)

    if (next?.data) {
      state = next.data
    } else {
      await sleep(2000)
    }
  }

  return null
}

export const agentCommands = (program: Program) => {
  const agent = program
    .command('agent', {
      hidden: true,
    })
    .description('Agent session commands that run inside a workspace')

  agent
    .command('relay', {
      hidden: true,
    })
    .description(
      'Post the agent session events that the workspace hook spooled to Dispatch, then exit when the spool stays empty',
    )
    .action(
      action(async (options) => {
        const machine = env[machineIdEnv]

        if (!machine) {
          throw usage(
            `${machineIdEnv} is not set.`,
            'The relay runs inside a machine, started by its agent hook.',
          )
        }

        const run = await connect(options)

        await relay(await realDeps(poster(run, machine)))

        return exitCodes.ok
      }),
    )

  agent
    .command('approve', {
      hidden: true,
    })
    .description(
      "Ask the task's owner in Stationly to allow or deny a tool call; run as Claude Code's PermissionRequest hook in a runner session",
    )
    .action(
      action(async (options) => {
        const machine = env[machineIdEnv]
        const input = await readStdin()

        if (!machine || process.env.STATIONLY_RUNNER !== '1') {
          return exitCodes.ok
        }

        try {
          const line = await approve(
            await connect(options),
            machine,
            JSON.parse(input) as Record<string, unknown>,
          )

          if (line) {
            process.stdout.write(line)
          }
        } catch {
          return exitCodes.ok
        }

        return exitCodes.ok
      }),
    )

  agent
    .command('run', {
      hidden: true,
    })
    .description(
      "Run the agent for one session headless and feed it the operator's prompts from Dispatch",
    )
    .requiredOption('--session <id>', 'the session id Dispatch chose')
    .option('--adapter <agent>', 'the agent adapter', 'claude')
    .option('--model <model>', 'the model to run')
    .option('--resume', 'resume the session instead of starting it')
    .action(
      action(async (options) => {
        const machine = env[machineIdEnv]

        if (!machine) {
          throw usage(
            `${machineIdEnv} is not set.`,
            'The runner runs inside a workspace, started by Dispatch.',
          )
        }

        if (options.adapter !== 'claude') {
          throw usage(`No adapter for ${options.adapter}.`, 'The only adapter is claude.')
        }

        const release = holdLock(options.session)

        if (!release) {
          return exitCodes.ok
        }

        try {
          const run = await connect(options)
          const post = poster(run, machine)

          return await runSession({
            adapter: claudeAdapter(),
            start: {
              sessionId: options.session,
              resume: Boolean(options.resume),
              model: options.model ?? null,
              cwd: process.cwd(),
            },
            ...inboxOf(run, machine, options.session),
            post: async (events) => {
              await post(events)
            },
            changes: gitChanges(process.cwd()),
            now: () => new Date(),
            sleep: (ms) => sleep(ms),
          })
        } finally {
          release()
        }
      }),
    )
}
