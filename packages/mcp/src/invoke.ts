import type { ServerContext } from '@modelcontextprotocol/server'
import { slugPaths } from './openapi.ts'
import type { Outcome, ToolDef } from './tools.ts'

export type Send = (path: string, init: RequestInit, request: ServerContext) => Promise<Response>

type Input = Record<string, unknown>

const parents = ['projects', 'environments']

const defaultTimeout = 600

const maxTimeout = 3600

const maxWait = 10

export const internalEnvelope = (error: unknown) => ({
  error: {
    code: 'INTERNAL_ERROR',
    explanation: error instanceof Error ? error.message : String(error),
    fix: 'Retry; if it keeps failing, report the explanation.'
  }
})

const pathOf = (template: string, input: Input) =>
  template.replace(/\/([^/]+)\/\{([^}]+)\}/g, (_, collection: string, name: string) => {
    const value = String(input[name])
    const segments = slugPaths[name] ? value.split('/') : [value]
    return segments.map((segment, i) => `/${i === segments.length - 1 ? collection : (parents[i] ?? collection)}/${encodeURIComponent(segment)}`).join('')
  })

const outcomeOf = async (response: Response): Promise<Outcome> => {
  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { ok: false, envelope: internalEnvelope(new Error(`Dispatch answered ${response.status} with a body that is not JSON`)) }
  }
  return response.ok ? { ok: true, body } : { ok: false, envelope: body }
}

const once = async (tool: ToolDef, input: Input, send: Send, request: ServerContext) => {
  const { idempotency_key: key, ...rest } = input
  const query = new URLSearchParams()
  for (const name of tool.query) if (rest[name] !== undefined) query.set(name, String(rest[name]))
  const body = Object.fromEntries(Object.entries(rest).filter(([name]) => !tool.params.includes(name)))
  const search = query.size ? `?${query}` : ''
  const headers: Record<string, string> = { accept: 'application/json', ...(typeof key === 'string' ? { 'idempotency-key': key } : {}) }
  const init: RequestInit = tool.body
    ? { method: tool.method, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: request.mcpReq.signal }
    : { method: tool.method, headers, signal: request.mcpReq.signal }
  return outcomeOf(await send(`${pathOf(tool.path, rest)}${search}`, init, request))
}

const progress = async (request: ServerContext, step: number, message: string) => {
  const progressToken = request.mcpReq._meta?.progressToken
  if (progressToken !== undefined) await request.mcpReq.notify({ method: 'notifications/progress', params: { progressToken, progress: step, message } })
}

const stateOf = (body: unknown) => {
  const status = (body as { status?: unknown } | null)?.status
  return typeof status === 'string' ? `is ${status}` : 'is not done'
}

const poll = async (tool: ToolDef, wait: string, input: Input, send: Send, request: ServerContext) => {
  const { timeout_s: requested, ...rest } = input
  const limit = Math.min(typeof requested === 'number' ? requested : defaultTimeout, maxTimeout)
  const deadline = Date.now() + limit * 1000
  let step = 0
  await progress(request, ++step, `${tool.name}: waiting up to ${limit} s`)
  for (;;) {
    const seconds = Math.max(0, Math.min(maxWait, Math.ceil((deadline - Date.now()) / 1000)))
    const result = await once(tool, { ...rest, [wait]: seconds }, send, request)
    const done = result.ok && (result.body as { done?: unknown }).done === true
    if (!result.ok || done || Date.now() >= deadline || request.mcpReq.signal.aborted) {
      await progress(request, ++step, `${tool.name}: ${!result.ok ? 'refused' : done ? 'done' : `stopped after ${limit} s, not done`}`)
      return result
    }
    await progress(request, ++step, `${tool.name}: ${stateOf(result.body)}`)
  }
}

export const invoke = (tool: ToolDef, input: Input, send: Send, request: ServerContext): Promise<Outcome> =>
  tool.poll ? poll(tool, tool.poll, input, send, request) : once(tool, input, send, request)
