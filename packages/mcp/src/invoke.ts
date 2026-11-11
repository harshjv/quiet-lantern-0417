import type { ServerContext } from '@modelcontextprotocol/server'

import { requestOf } from './operations.ts'
import type { Outcome, ToolDef } from './tools.ts'

export type Send = (path: string, init: RequestInit, request: ServerContext) => Promise<Response>

type Input = Record<string, unknown>

export const pollTimeout = {
  default: 600,
  max: 3600,
}

const maxWait = 10

export const internalEnvelope = (error: unknown) => ({
  error: {
    code: 'INTERNAL_ERROR',
    explanation: error instanceof Error ? error.message : String(error),
    fix: 'Retry; if it keeps failing, report the explanation.',
  },
})

const outcomeOf = async (response: Response): Promise<Outcome> => {
  const text = await response.text()
  let body: unknown

  try {
    body = JSON.parse(text)
  } catch {
    return {
      ok: false,
      envelope: internalEnvelope(
        new Error(`Dispatch answered ${response.status} with a body that is not JSON`),
      ),
    }
  }

  return response.ok
    ? {
        ok: true,
        body,
      }
    : {
        ok: false,
        envelope: body,
      }
}

const once = async (tool: ToolDef, input: Input, send: Send, request: ServerContext) => {
  const { path, init } = requestOf(tool, input)

  return outcomeOf(
    await send(
      path,
      {
        ...init,
        signal: request.mcpReq.signal,
      },
      request,
    ),
  )
}

const progress = async (request: ServerContext, step: number, message: string) => {
  const progressToken = request.mcpReq._meta?.progressToken

  if (progressToken !== undefined) {
    await request.mcpReq.notify({
      method: 'notifications/progress',
      params: {
        progressToken,
        progress: step,
        message,
      },
    })
  }
}

const stateOf = (body: unknown) => {
  const status = (body as { status?: unknown } | null)?.status

  return typeof status === 'string' ? `is ${status}` : 'is not done'
}

export type Attempt = (input: Input) => Promise<Outcome>

export type Report = (step: number, message: string) => Promise<void> | void

export type Repeat = {
  name: string
  wait: string
  input: Input
  attempt: Attempt
  report: Report
  aborted?: () => boolean
}

export const repeatUntilDone = async ({
  name,
  wait,
  input,
  attempt,
  report,
  aborted = () => false,
}: Repeat) => {
  const { timeout_s: requested, ...rest } = input
  const limit = Math.min(
    typeof requested === 'number' ? requested : pollTimeout.default,
    pollTimeout.max,
  )
  const deadline = Date.now() + limit * 1000
  let step = 0

  await report(++step, `${name}: waiting up to ${limit} s`)

  for (;;) {
    const seconds = Math.max(0, Math.min(maxWait, Math.ceil((deadline - Date.now()) / 1000)))
    const result = await attempt({
      ...rest,
      [wait]: seconds,
    })
    const done = result.ok && (result.body as { done?: unknown }).done === true

    if (!result.ok || done || Date.now() >= deadline || aborted()) {
      await report(
        ++step,
        `${name}: ${!result.ok ? 'refused' : done ? 'done' : `stopped after ${limit} s, not done`}`,
      )

      return result
    }

    await report(++step, `${name}: ${stateOf(result.body)}`)
  }
}

export const invoke = (
  tool: ToolDef,
  input: Input,
  send: Send,
  request: ServerContext,
): Promise<Outcome> =>
  tool.poll
    ? repeatUntilDone({
        name: tool.name,
        wait: tool.poll,
        input,
        attempt: (next) => once(tool, next, send, request),
        report: (step, message) => progress(request, step, message),
        aborted: () => request.mcpReq.signal.aborted,
      })
    : once(tool, input, send, request)
