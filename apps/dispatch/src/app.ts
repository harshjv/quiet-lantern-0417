import { node } from '@elysia/node'
import { openapi } from '@elysia/openapi'
import { and, eq } from 'drizzle-orm'
import { Elysia } from 'elysia'

import type { Deps } from './api/context.ts'
import { ApiError, notFoundError, refusal, stamped } from './api/errors.ts'
import { createApi } from './api/index.ts'
import { createAuthPages } from './auth/pages.ts'
import {
  authenticate,
  gateAuthRequest,
  recordUnauthenticated,
  surfaceOf,
} from './auth/principal.ts'
import { rememberSentUrl } from './auth/proof.ts'
import type { Dashboard } from './dashboard.ts'
import type { Db } from './db/client.ts'
import { environment, project, sandbox, service } from './db/schema.ts'
import { createMcpRoute } from './mcp/route.ts'

export const createApp = (deps: Deps) => {
  const mcp = createMcpRoute(deps)
  const authHandler = async (request: Request) => {
    try {
      await gateAuthRequest(deps.auth, request)
    } catch (error) {
      if (!(error instanceof ApiError)) throw error
      if (error.code === 'UNAUTHENTICATED') recordUnauthenticated(request)
      return refusal(request, error, deps.version)
    }
    return stamped(request, await deps.auth.current.handler(request), deps.version)
  }
  const metadata = async (request: Request) => {
    const surface = surfaceOf(request, deps.auth)
    if (surface !== 'api' && surface !== 'local')
      return refusal(
        request,
        new ApiError('WRONG_HOST', 'OAuth metadata is served on the API host only.'),
        deps.version,
      )
    return stamped(request, await deps.auth.current.handler(request), deps.version)
  }
  const app = new Elysia({
    adapter: node(),
    normalize: false,
  })
    .use(
      openapi({
        path: '/openapi',
        provider: null,
        exclude: {
          paths: [/^\/auth/],
        },
        documentation: {
          info: {
            title: 'Stationly',
            version: deps.version,
            description:
              'The Stationly Dispatch API. Errors use the envelope { error: { code, explanation, fix, details, request_id } }.',
          },
          components: {
            securitySchemes: {
              token: {
                type: 'http',
                scheme: 'bearer',
                description: 'An sly_ personal or scoped token',
              },
            },
          },
          security: [
            {
              token: [],
            },
          ],
        },
      }),
    )
    .get(
      '/v1/healthz',
      () => ({
        status: 'ok' as const,
      }),
      {
        detail: {
          hide: true,
        },
      },
    )
    .use(createAuthPages(deps))
    .all('/auth/*', ({ request }) => authHandler(request), {
      parse: 'none',
      detail: {
        hide: true,
      },
    })
    .get('/.well-known/oauth-authorization-server/auth', ({ request }) => metadata(request), {
      detail: {
        hide: true,
      },
    })
    .get('/.well-known/oauth-protected-resource', ({ request }) => metadata(request), {
      detail: {
        hide: true,
      },
    })
    .get('/.well-known/oauth-protected-resource/mcp', ({ request }) => metadata(request), {
      detail: {
        hide: true,
      },
    })
    .all('/mcp', ({ request }) => mcp.handle(request), {
      parse: 'none',
      detail: {
        hide: true,
      },
    })
    .use(createApi(deps))
  mcp.connect((request) => createFetch(deps, app)(request))
  return app
}

export type App = ReturnType<typeof createApp>

const byRef = (ref: string, prefix: string) => ref.startsWith(`${prefix}_`)

type Missing = { entity: string; ref: string }

const flatPath = (db: Db, pathname: string): string | Missing | null => {
  const parts = pathname.split('/').slice(2)
  if (parts[0] !== 'projects' || parts.length < 4 || parts[2] !== 'environments') return null
  const [, projectRef, , environmentRef, ...rest] = parts.map(decodeURIComponent) as [
    string,
    string,
    string,
    string,
    ...string[],
  ]
  const proj = db
    .select({
      id: project.id,
    })
    .from(project)
    .where(byRef(projectRef, 'prj') ? eq(project.id, projectRef) : eq(project.name, projectRef))
    .get()
  if (!proj)
    return {
      entity: 'project',
      ref: projectRef,
    }
  const env = db
    .select({
      id: environment.id,
    })
    .from(environment)
    .where(
      and(
        eq(environment.project_id, proj.id),
        byRef(environmentRef, 'env')
          ? eq(environment.id, environmentRef)
          : eq(environment.name, environmentRef),
      ),
    )
    .get()
  if (!env)
    return {
      entity: 'environment',
      ref: environmentRef,
    }
  if (rest[0] === 'services' && rest.length >= 2) {
    const svc = db
      .select({
        id: service.id,
      })
      .from(service)
      .where(
        and(
          eq(service.environment_id, env.id),
          byRef(rest[1]!, 'svc') ? eq(service.id, rest[1]!) : eq(service.name, rest[1]!),
        ),
      )
      .get()
    if (!svc)
      return {
        entity: 'service',
        ref: rest[1]!,
      }
    return ['/v1/services', svc.id, ...rest.slice(2)].join('/')
  }
  if (rest[0] === 'sandboxes' && rest.length >= 2) {
    const box = db
      .select({
        id: sandbox.id,
      })
      .from(sandbox)
      .where(
        and(
          eq(sandbox.environment_id, env.id),
          byRef(rest[1]!, 'sbx') ? eq(sandbox.id, rest[1]!) : eq(sandbox.name, rest[1]!),
        ),
      )
      .get()
    if (!box)
      return {
        entity: 'sandbox',
        ref: rest[1]!,
      }
    return ['/v1/sandboxes', box.id, ...rest.slice(2)].join('/')
  }
  return ['/v1/environments', env.id, ...rest].join('/')
}

const missingTarget = async (deps: Deps, request: Request, missing: Missing) => {
  try {
    await authenticate(deps.db, deps.auth, request)
  } catch (error) {
    if (error instanceof ApiError) return refusal(request, error, deps.version)
    throw error
  }
  return refusal(request, notFoundError(missing.entity, missing.ref), deps.version)
}

export const createFetch = (deps: Deps, app: App, dashboard?: Dashboard) => (request: Request) => {
  const page = dashboard?.handle(request, surfaceOf(request, deps.auth))
  if (page) return page
  const url = new URL(request.url)
  const flat = url.pathname.startsWith('/v1/projects/') ? flatPath(deps.db, url.pathname) : null
  if (!flat) return app.fetch(request)
  if (typeof flat !== 'string') return missingTarget(deps, request, flat)
  url.pathname = flat
  const init: RequestInit & { duplex: 'half' } = {
    method: request.method,
    headers: request.headers,
    body: request.body,
    duplex: 'half',
    signal: request.signal,
  }
  const rewritten = new Request(url, init)
  rememberSentUrl(rewritten, request.url)
  return app.fetch(rewritten)
}
