import type { ServerContext } from '@modelcontextprotocol/server'

import { requestOf } from './operations.ts'
import type { Outcome, ToolDef } from './tools.ts'

export type Send = (path: string, init: RequestInit, request: ServerContext) => Promise<Response>

type Input = Record<string, unknown>

const defaultTimeout = 600

const maxTimeout = 3600

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
  if (progressToken !== undefined)
    await request.mcpReq.notify({
      method: 'notifications/progress',
      params: {
        progressToken,
        progress: step,
        message,
      },
    })
}

const stateOf = (body: unknown) => {
  const status = (body as { status?: unknown } | null)?.status
  return typeof status === 'string' ? `is ${status}` : 'is not done'
}

const poll = async (
  tool: ToolDef,
  wait: string,
  input: Input,
  send: Send,
  request: ServerContext,
) => {
  const { timeout_s: requested, ...rest } = input
  const limit = Math.min(typeof requested === 'number' ? requested : defaultTimeout, maxTimeout)
  const deadline = Date.now() + limit * 1000
  let step = 0
  await progress(request, ++step, `${tool.name}: waiting up to ${limit} s`)
  for (;;) {
    const seconds = Math.max(0, Math.min(maxWait, Math.ceil((deadline - Date.now()) / 1000)))
    const result = await once(
      tool,
      {
        ...rest,
        [wait]: seconds,
      },
      send,
      request,
    )
    const done = result.ok && (result.body as { done?: unknown }).done === true
    if (!result.ok || done || Date.now() >= deadline || request.mcpReq.signal.aborted) {
      await progress(
        request,
        ++step,
        `${tool.name}: ${!result.ok ? 'refused' : done ? 'done' : `stopped after ${limit} s, not done`}`,
      )
      return result
    }
    await progress(request, ++step, `${tool.name}: ${stateOf(result.body)}`)
  }
}

export const invoke = (
  tool: ToolDef,
  input: Input,
  send: Send,
  request: ServerContext,
): Promise<Outcome> =>
  tool.poll ? poll(tool, tool.poll, input, send, request) : once(tool, input, send, request)
