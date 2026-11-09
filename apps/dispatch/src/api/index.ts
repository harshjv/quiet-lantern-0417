import { isAPIError } from 'better-auth/api'
import { Elysia, ValidationError } from 'elysia'
import { recordUnauthenticated, surfaceOf } from '../auth/principal.ts'
import { SecretsError } from '../secrets/errors.ts'
import { assignRequestId, rememberIdempotencyKey, requestIdOf, type Deps } from './context.ts'
import { ApiError, envelope, fromSecretsError } from './errors.ts'
import { abandonIdempotent, beginIdempotent, finishIdempotent, mutationMethods } from './idempotency.ts'
import { createKit } from './kit.ts'
import { auditRoutes } from './routes/audit.ts'
import { githubRoutes } from './routes/github.ts'
import { manifestRoutes } from './routes/manifest.ts'
import { blobRoutes } from './routes/blobs.ts'
import { deployActionRoutes } from './routes/deploy-actions.ts'
import { eventRoutes } from './routes/events.ts'
import { logRoutes } from './routes/logs.ts'
import { notificationRoutes } from './routes/notifications.ts'
import { runRoutes } from './routes/runs.ts'
import { sandboxRoutes } from './routes/sandboxes.ts'
import { deploymentRoutes } from './routes/deployments.ts'
import { domainRoutes } from './routes/domains.ts'
import { environmentRoutes } from './routes/environments.ts'
import { meRoutes } from './routes/me.ts'
import { networkRoutes } from './routes/network.ts'
import { portRoutes } from './routes/ports.ts'
import { projectRoutes } from './routes/projects.ts'
import { serviceRoutes } from './routes/services.ts'
import { settingRoutes } from './routes/settings.ts'
import { stagedRoutes } from './routes/staged.ts'
import { platformRoutes } from './routes/platform.ts'
import { stationRoutes } from './routes/stations.ts'
import { tokenRoutes } from './routes/tokens.ts'
import { variableRoutes } from './routes/variables.ts'
import { volumeRoutes } from './routes/volumes.ts'
import { models } from './shapes.ts'

const pagePaths = new Set(['/device'])

const ownsHeaders = (path: string) => path.startsWith('/auth/') || path.startsWith('/.well-known/') || pagePaths.has(path)

const json = (status: number, body: unknown, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

const toApiError = (code: string | number, error: unknown): ApiError => {
  if (error instanceof ApiError) return error
  if (error instanceof SecretsError) return fromSecretsError(error)
  if (error instanceof ValidationError && error.type === 'response') {
    console.error(JSON.stringify({ event: 'response_schema_mismatch', path: error.all.map(e => e.path), message: error.all.map(e => e.message) }))
    return new ApiError('INTERNAL_ERROR', 'The response did not match its declared schema.')
  }
  if (code === 'VALIDATION' && error && typeof error === 'object' && 'all' in error) {
    const all = (error as { all: { path?: string; message?: string; summary?: string }[] }).all
    const issues = all.map(e => ({ path: e.path || '/', message: e.summary ?? e.message ?? 'invalid' }))
    return new ApiError('VALIDATION_FAILED', issues.map(i => `${i.path}: ${i.message}`).join('; ') || 'The request does not match its schema.', undefined, { issues })
  }
  if (code === 'PARSE') return new ApiError('VALIDATION_FAILED', 'The request body is not valid JSON.', undefined, { issues: [{ path: '/', message: 'unparseable body' }] })
  if (code === 'NOT_FOUND') return new ApiError('NOT_FOUND', 'No endpoint matches this method and path.', 'Read /openapi/json for the endpoint catalog.')
  if (isAPIError(error)) {
    const body = error.body as { message?: string; code?: string } | undefined
    return new ApiError('VALIDATION_FAILED', body?.message ?? error.message, undefined, { auth_code: body?.code ?? null })
  }
  console.error(JSON.stringify({ event: 'unhandled_error', message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : null }))
  return new ApiError('INTERNAL_ERROR', 'The request failed inside Dispatch.')
}

export const createApi = (deps: Deps) => {
  const kit = createKit(deps)
  const idempotencyKeys = new WeakMap<Request, string>()

  return new Elysia({ name: 'stationly-api', normalize: false }).use(models())
    .onRequest(({ request, set }) => {
      const requestId = assignRequestId(request)
      const path = new URL(request.url).pathname
      if (!ownsHeaders(path)) {
        set.headers['x-request-id'] = requestId
        set.headers['x-stationly-version'] = deps.version
      }
      const surface = surfaceOf(request, deps.auth)
      const wrong =
        (surface === null && path !== '/v1/healthz') || (surface === 'dashboard' && (path === '/openapi/json' || path.startsWith('/openapi')))
      if (wrong) {
        const error = new ApiError('WRONG_HOST', `This host does not serve ${path}.`)
        return json(error.status, envelope(error, requestId), { 'x-request-id': requestId })
      }
    })
    .onError({ as: 'global' }, async ({ code, error, request }) => {
      const apiError = toApiError(code, error)
      const requestId = requestIdOf(request)
      if (apiError.code === 'UNAUTHENTICATED') recordUnauthenticated(request)
      const key = idempotencyKeys.get(request)
      if (key) {
        const principal = await kit.principal(request).catch(() => null)
        if (principal) abandonIdempotent(deps.db, principal, key)
      }
      return json(apiError.status, envelope(apiError, requestId), { 'x-request-id': requestId, 'x-stationly-version': deps.version, ...apiError.headers })
    })
    .onBeforeHandle({ as: 'global' }, async ({ request, body }) => {
      const key = request.headers.get('idempotency-key')
      const path = new URL(request.url).pathname
      if (!key || !mutationMethods.has(request.method) || !path.startsWith('/v1/')) return
      const principal = await kit.principal(request)
      const replay = beginIdempotent(deps.db, principal, key, request, body)
      if (replay) {
        return json(replay.status, replay.response, { 'x-request-id': requestIdOf(request), 'x-stationly-version': deps.version, 'idempotent-replayed': 'true' })
      }
      idempotencyKeys.set(request, key)
      rememberIdempotencyKey(request, key)
    })
    .onAfterHandle({ as: 'global' }, async ({ request, responseValue, set }) => {
      const key = idempotencyKeys.get(request)
      if (!key) return
      const principal = await kit.principal(request)
      const status = typeof set.status === 'number' ? set.status : 200
      if (status >= 500) abandonIdempotent(deps.db, principal, key)
      else finishIdempotent(deps.db, principal, key, status, responseValue)
    })
    .use(meRoutes(kit))
    .use(projectRoutes(kit))
    .use(environmentRoutes(kit))
    .use(serviceRoutes(kit))
    .use(portRoutes(kit))
    .use(volumeRoutes(kit))
    .use(domainRoutes(kit))
    .use(networkRoutes(kit))
    .use(deploymentRoutes(kit))
    .use(deployActionRoutes(kit))
    .use(runRoutes(kit))
    .use(sandboxRoutes(kit))
    .use(blobRoutes(kit))
    .use(logRoutes(kit))
    .use(eventRoutes(kit))
    .use(notificationRoutes(kit))
    .use(variableRoutes(kit))
    .use(stagedRoutes(kit))
    .use(settingRoutes(kit))
    .use(tokenRoutes(kit))
    .use(stationRoutes(kit))
    .use(platformRoutes(kit))
    .use(auditRoutes(kit))
    .use(manifestRoutes(kit))
    .use(githubRoutes(kit))
}
