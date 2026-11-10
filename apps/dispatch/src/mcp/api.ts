import { CLIENT_INFO_META_KEY, type ServerContext } from '@modelcontextprotocol/server'
import { generateTools, type OpenApiDocument, type Send, type ToolDef } from '@stationly/mcp'

export type Dispatch = (request: Request) => Response | Promise<Response>

export type Session = {
  origin: string
  token: string
  userAgent: string | null
  dispatch: Dispatch
}

const clientName = (request: ServerContext, fallback: string | null) => {
  const lifted = request.mcpReq.envelope as Record<string, unknown> | undefined
  const info = (lifted?.[CLIENT_INFO_META_KEY] ?? request.mcpReq._meta?.[CLIENT_INFO_META_KEY]) as { name?: unknown } | undefined
  const name = typeof info?.name === 'string' ? info.name.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 48) : ''
  return name ? `mcp/${name}` : fallback
}

export const sendFor =
  (session: Session): Send =>
  async (path, init, request) => {
    const agent = clientName(request, session.userAgent)
    const headers = { ...(init.headers as Record<string, string>), authorization: `Bearer ${session.token}`, ...(agent ? { 'user-agent': agent } : {}) }
    return session.dispatch(new Request(`${session.origin}${path}`, { ...init, headers }))
  }

export const loadTools = async (session: Session): Promise<ToolDef[]> => {
  const response = await session.dispatch(new Request(`${session.origin}/openapi/json`, { headers: { accept: 'application/json' } }))
  if (!response.ok) throw new Error(`GET /openapi/json answered ${response.status}`)
  return generateTools((await response.json()) as OpenApiDocument)
}
