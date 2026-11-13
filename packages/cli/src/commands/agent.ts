import { createApiClient } from '@stationly/api-client'
import type { AgentEventInputValue } from '@stationly/protocol'

import { realDeps, relay, type PostResult } from '../agent-relay.ts'
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

const poster = ({ credentials, userAgent }: Run, sandbox: string) => {
  const api = createApiClient(credentials.instance, async (input, init) => {
    const request = new Request(input, init)

    for (const [name, value] of Object.entries(
      await credentialHeaders(credentials, request.method, request.url),
    )) {
      request.headers.set(name, value)
    }

    request.headers.set('user-agent', userAgent)

    return fetch(request)
  })

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
}
