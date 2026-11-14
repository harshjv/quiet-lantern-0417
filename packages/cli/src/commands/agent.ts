import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { createApiClient } from '@stationly/api-client'
import type { AgentEventInputValue } from '@stationly/protocol'

import { realDeps, relay, type PostResult } from '../agent-relay.ts'
import { claudeAdapter, runnerDir } from '../agent/claude.ts'
import { runSession, type InboxItem } from '../agent/runner.ts'
import { action, type Program } from '../command.ts'
import { env, sandboxIdEnv } from '../env.ts'
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

const poster = (run: Run, sandbox: string) => {
  const api = clientOf(run)

  return async (events: AgentEventInputValue[]) => {
    const { status, response, error } = await api.v1
      .sandboxes({
        sandbox,
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

const inboxOf = (run: Run, sandbox: string, session: string) => {
  const api = clientOf(run)
  const box = api.v1.sandboxes({
    sandbox,
  }).agent.inbox

  return {
    inbox: async (after: number): Promise<InboxItem[]> => {
      const { data, error } = await box.get({
        query: {
          session,
          after,
          wait_s: 25,
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
  }
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
        const sandbox = env[sandboxIdEnv]

        if (!sandbox) {
          throw usage(
            `${sandboxIdEnv} is not set.`,
            'The relay runs inside a sandbox, started by its agent hook.',
          )
        }

        const run = await connect(options)

        await relay(await realDeps(poster(run, sandbox)))

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
        const sandbox = env[sandboxIdEnv]

        if (!sandbox) {
          throw usage(
            `${sandboxIdEnv} is not set.`,
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
          const post = poster(run, sandbox)

          return await runSession({
            adapter: claudeAdapter(),
            start: {
              sessionId: options.session,
              resume: Boolean(options.resume),
              model: options.model ?? null,
              cwd: process.cwd(),
            },
            ...inboxOf(run, sandbox, options.session),
            post: async (events) => {
              await post(events)
            },
            now: () => new Date(),
            sleep: (ms) => sleep(ms),
          })
        } finally {
          release()
        }
      }),
    )
}
