import {
  OAuthError,
  OAuthErrorCode,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  originValidationResponse,
  requireBearerAuth,
  type AuthInfo,
  type McpRequestContext
} from '@modelcontextprotocol/server'
import { buildServer, type Level } from '@stationly/mcp'
import { ApiError, envelope } from '../api/errors.ts'
import type { Deps } from '../api/context.ts'
import { requestIdOf } from '../api/context.ts'
import { authenticate, surfaceOf, type Principal } from '../auth/principal.ts'
import { isInstanceAdmin, levels, type Scope } from '../auth/scopes.ts'
import type { Dispatch, Session } from './api.ts'
import { catalog, instructions } from './catalog.ts'

const loopbackOrigins = ['127.0.0.1', 'localhost', '[::1]']

const hostOf = (origin: string) => new URL(origin).hostname

const highest = (scopes: Scope[]): Level | null =>
  scopes.reduce<Level | null>((best, scope) => (best === null || levels.indexOf(scope.level) > levels.indexOf(best) ? scope.level : best), null)

type Grant = { principal: Principal; session: Session }

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export type McpRoute = { handle: (request: Request) => Promise<Response>; connect: (dispatch: Dispatch) => void }

export const createMcpRoute = (deps: Deps): McpRoute => {
  let dispatch: Dispatch | null = null

  const handler = createMcpHandler(
    (ctx: McpRequestContext) => {
      const grant = ctx.authInfo?.extra?.grant as Grant | undefined
      if (!grant) throw new Error('the /mcp gate passed no grant')
      const scopes = grant.principal.scopes
      return buildServer({
        name: 'stationly',
        version: deps.version,
        instructions,
        tools: catalog,
        caller: { level: highest(scopes), instanceAdmin: isInstanceAdmin(scopes) },
        context: grant.session
      })
    },
    { legacy: 'stateless', responseMode: 'auto', onerror: error => console.error(JSON.stringify({ event: 'mcp_error', message: error.message })) }
  )

  const handle = async (request: Request): Promise<Response> => {
    const surface = surfaceOf(request, deps.auth)
    if (surface === 'dashboard' || surface === null) {
      return json(404, envelope(new ApiError('WRONG_HOST', 'This host does not serve /mcp.'), requestIdOf(request)))
    }
    const surfaceOrigins = [hostOf(deps.auth.surface.apiOrigin), hostOf(deps.auth.surface.dashboardOrigin)]
    const rejected = originValidationResponse(request, surface === 'local' ? [...surfaceOrigins, ...loopbackOrigins] : surfaceOrigins)
    if (rejected) return rejected
    const host = request.headers.get('host') ?? new URL(request.url).host
    const origin = surface === 'api' ? deps.auth.surface.apiOrigin : `${new URL(request.url).protocol}//${host}`
    const resource = new URL(`${origin}/mcp`)
    const gate = requireBearerAuth({
      expectedResource: resource,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource),
      verifier: {
        verifyAccessToken: async (token): Promise<AuthInfo> => {
          let principal: Principal
          try {
            principal = await authenticate(deps.db, deps.auth, request)
          } catch (error) {
            throw new OAuthError(OAuthErrorCode.InvalidToken, error instanceof ApiError ? error.message : 'the token could not be verified')
          }
          if (principal.token_kind === 'session') throw new OAuthError(OAuthErrorCode.InvalidToken, 'a sly session is never accepted on /mcp; use a scoped token or OAuth')
          if (!dispatch) throw new Error('the /mcp route is not connected to the API')
          const session: Session = { origin, token, userAgent: request.headers.get('user-agent')?.split(' ')[0] ?? null, dispatch }
          const grant: Grant = { principal, session }
          return {
            token,
            clientId: principal.token_id ?? principal.actor.id ?? principal.user_id,
            scopes: principal.scopes.map(s => `${s.project_id}:${s.environment_id}:${s.level}`),
            expiresAt: Math.floor(principal.expires_at.getTime() / 1000),
            resource: principal.resource ? new URL(principal.resource) : resource,
            extra: { grant }
          }
        }
      }
    })
    const auth = await gate(request)
    if (auth instanceof Response) return auth
    return handler.fetch(request, { authInfo: auth })
  }

  return { handle, connect: next => void (dispatch = next) }
}
