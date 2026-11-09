import { treaty } from '@elysia/eden'
import { CLIENT_INFO_META_KEY } from '@modelcontextprotocol/server'
import type { Outcome } from '@stationly/mcp'
import type { ServerContext } from '@modelcontextprotocol/server'
import type { App } from '../app.ts'

export type Dispatch = (request: Request) => Response | Promise<Response>

export type Session = {
  origin: string
  token: string
  userAgent: string | null
  dispatch: Dispatch
}

export type Api = ReturnType<typeof treaty<App>>

const clientName = (request: ServerContext, fallback: string | null) => {
  const lifted = request.mcpReq.envelope as Record<string, unknown> | undefined
  const info = (lifted?.[CLIENT_INFO_META_KEY] ?? request.mcpReq._meta?.[CLIENT_INFO_META_KEY]) as { name?: unknown } | undefined
  const name = typeof info?.name === 'string' ? info.name.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 48) : ''
  return name ? `mcp/${name}` : fallback
}

const fetcherOf = (session: Session) =>
  ((input: string | URL | Request, init?: RequestInit) => Promise.resolve(session.dispatch(new Request(input, init)))) as typeof fetch

export const headersFor = (session: Session, request: ServerContext, idempotencyKey?: string) => {
  const agent = clientName(request, session.userAgent)
  return {
    authorization: `Bearer ${session.token}`,
    ...(agent ? { 'user-agent': agent } : {}),
    ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {})
  }
}

export const apiFor = (session: Session, request: ServerContext, idempotencyKey?: string): Api =>
  treaty<App>(session.origin, { fetcher: fetcherOf(session), headers: headersFor(session, request, idempotencyKey), parseDate: false })

type EdenResult = { data: unknown; error: { value: unknown } | null }

export const outcome = (result: EdenResult): Outcome => (result.error ? { ok: false, envelope: result.error.value } : { ok: true, body: result.data })

export const raw = async (session: Session, request: ServerContext, path: string): Promise<Outcome> => {
  const response = await session.dispatch(new Request(`${session.origin}${path}`, { headers: headersFor(session, request) }))
  const body: unknown = await response.json()
  return response.ok ? { ok: true, body } : { ok: false, envelope: body }
}
