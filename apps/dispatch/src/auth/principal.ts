import { tokenLevelValues, type Actor } from '@stationly/protocol'
import type { Static } from '@sinclair/typebox'
import { eq } from 'drizzle-orm'
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from 'jose'
import { ApiError } from '../api/errors.ts'
import type { Db } from '../db/client.ts'
import { token } from '../db/schema.ts'
import { apiKeyFromHeaders, apiKeyPrefix, canonicalOrigin, v1Permission, type AuthService } from './auth.ts'
import { liveGrant } from './grants.ts'
import { ProofError, proofHeader, publicUrl, verifyProof } from './proof.ts'
import { fullAdmin, type Scope } from './scopes.ts'

export type ActorValue = Static<typeof Actor>

export type Surface = 'api' | 'dashboard' | 'local'

export type Principal = {
  actor: ActorValue
  human: boolean
  user_id: string
  token_kind: 'session' | 'personal' | 'scoped' | 'oauth'
  token_id: string | null
  credential: string
  scopes: Scope[]
  expires_at: Date
  resource: string | null
}

const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]'])

export const surfaceOf = (request: Request, auth: AuthService): Surface | null => {
  const host = request.headers.get('host') ?? new URL(request.url).host
  const hostname = host.replace(/:\d+$/, '')
  if (loopbackHosts.has(hostname) || `https://${host}` === auth.surface.addressOrigin) return 'local'
  if (`https://${host}` === auth.surface.apiOrigin) return 'api'
  if (`https://${host}` === auth.surface.dashboardOrigin) return 'dashboard'
  return null
}

const clientOf = (request: Request) => {
  const agent = request.headers.get('user-agent')?.split(' ')[0]?.slice(0, 64)
  return agent && agent.includes('/') ? agent : null
}

const unauthenticated = (explanation: string) => new ApiError('UNAUTHENTICATED', explanation)

const unauthenticatedWindowMs = 60_000
const unauthenticatedMax = 30
const failures = new Map<string, { start: number; count: number }>()

const ipOf = (request: Request) => request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local'

export const recordUnauthenticated = (request: Request) => {
  const ip = ipOf(request)
  const now = Date.now()
  const entry = failures.get(ip)
  if (!entry || now - entry.start > unauthenticatedWindowMs) failures.set(ip, { start: now, count: 1 })
  else entry.count += 1
}

const checkUnauthenticatedLimit = (request: Request) => {
  const entry = failures.get(ipOf(request))
  if (!entry || Date.now() - entry.start > unauthenticatedWindowMs || entry.count < unauthenticatedMax) return
  const retry = Math.ceil((entry.start + unauthenticatedWindowMs - Date.now()) / 1000)
  throw new ApiError('RATE_LIMITED', 'Too many unauthenticated requests from this address.', undefined, { retry_after_s: retry }, { 'retry-after': String(retry) })
}

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS'])

export const bearerOf = (headers: Headers) => headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? null

const isJwt = (value: string) => value.split('.').length === 3

const isScopeList = (value: unknown): value is Scope[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(
    item =>
      item !== null &&
      typeof item === 'object' &&
      typeof (item as Scope).project_id === 'string' &&
      typeof (item as Scope).environment_id === 'string' &&
      tokenLevelValues.includes((item as Scope).level)
  )

const oauthPrincipal = async (db: Db, auth: AuthService, request: Request, value: string): Promise<Principal> => {
  let payload: JWTPayload
  try {
    const keys = (await auth.current.api.getJwks()) as JSONWebKeySet
    payload = (
      await jwtVerify(value, createLocalJWKSet(keys), {
        issuer: auth.surface.baseURL,
        audience: auth.surface.mcpResource,
        typ: 'at+jwt',
        requiredClaims: ['exp', 'sub', 'azp']
      })
    ).payload
  } catch (error) {
    const failure = error as { code?: string; claim?: string; reason?: string; message?: string }
    throw unauthenticated(`The OAuth access token was refused: ${failure.code ?? failure.message ?? 'invalid'}${failure.claim ? ` (${failure.claim} ${failure.reason ?? 'check failed'})` : ''}.`)
  }
  const row = liveGrant(db, typeof payload.sly_token === 'string' ? payload.sly_token : undefined)
  if (!row || row.user_id !== payload.sub || !isScopeList(payload.sly_scopes)) throw unauthenticated('The OAuth grant behind this access token was revoked or has expired.')
  db.update(token).set({ last_used_at: new Date() }).where(eq(token.id, row.id)).run()
  return {
    actor: { type: 'oauth_client', id: row.id, client: clientOf(request) ?? row.client_id },
    human: false,
    user_id: row.user_id,
    token_kind: 'oauth',
    token_id: row.id,
    credential: row.id,
    scopes: payload.sly_scopes,
    expires_at: new Date(payload.exp! * 1000),
    resource: auth.surface.mcpResource
  }
}

export const verifySlySession = async (auth: AuthService, request: Request, value: string) => {
  const found = await auth.current.api.getSession({ headers: new Headers({ authorization: `Bearer ${value}` }), query: { disableRefresh: true } })
  const popJkt = found?.session.popJkt
  if (!found || !popJkt) throw unauthenticated('The bearer value is not a Stationly token, an OAuth access token or a live sly session.')
  const context = await auth.current.$context
  try {
    await verifyProof(context.internalAdapter, {
      proof: request.headers.get(proofHeader),
      method: request.method,
      url: publicUrl(request, canonicalOrigin(auth.surface, request)),
      accessToken: value,
      expectedJkt: popJkt
    })
  } catch (error) {
    if (error instanceof ProofError) throw unauthenticated(`A sly session needs a proof of possession from the machine that logged in: ${error.message}.`)
    throw error
  }
  return found
}

const sessionPrincipal = async (auth: AuthService, request: Request, value: string): Promise<Principal> => {
  const found = await verifySlySession(auth, request, value)
  return {
    actor: { type: 'user', id: found.user.id, client: clientOf(request) },
    human: true,
    user_id: found.user.id,
    token_kind: 'session',
    token_id: null,
    credential: found.session.id,
    scopes: fullAdmin,
    expires_at: new Date(found.session.expiresAt),
    resource: null
  }
}

const authBearerPaths = new Set(['/auth/sign-out'])

const pageOnlyPaths = new Set(['/auth/oauth2/consent', '/auth/oauth2/continue', '/auth/device', '/auth/device/approve', '/auth/device/deny'])

export const gateAuthRequest = async (auth: AuthService, request: Request) => {
  if (pageOnlyPaths.has(new URL(request.url).pathname)) {
    throw new ApiError('NOT_FOUND', 'Consent and device approval are completed on the server-rendered pages, not by calling this endpoint.', 'Open /auth/consent or /device in a browser.')
  }
  const value = bearerOf(request.headers)
  if (!value || value.startsWith(apiKeyPrefix) || isJwt(value)) return null
  if (!authBearerPaths.has(new URL(request.url).pathname)) {
    throw unauthenticated('A sly session is accepted on /auth only for sign-out; use the dashboard or the login page for everything else.')
  }
  await verifySlySession(auth, request, value)
  return null
}

export const authenticate = async (db: Db, auth: AuthService, request: Request): Promise<Principal> => {
  try {
    return await identify(db, auth, request)
  } catch (error) {
    if (error instanceof ApiError && error.code === 'UNAUTHENTICATED') checkUnauthenticatedLimit(request)
    throw error
  }
}

const identify = async (db: Db, auth: AuthService, request: Request): Promise<Principal> => {
  const surface = surfaceOf(request, auth)
  const key = apiKeyFromHeaders(request.headers)
  if (key) {
    const result = await auth.current.api.verifyApiKey({ body: { key, permissions: v1Permission } })
    if (!result.valid || !result.key) {
      if (result.error?.code === 'RATE_LIMITED') {
        const tryAgainIn = Number((result.error as { details?: { tryAgainIn?: number } }).details?.tryAgainIn ?? 60_000)
        const retry = Math.max(1, Math.ceil(tryAgainIn / 1000))
        throw new ApiError('RATE_LIMITED', 'This token exceeded its request rate.', undefined, { retry_after_s: retry }, { 'retry-after': String(retry) })
      }
      throw unauthenticated(`The token was refused: ${result.error?.code ?? 'invalid'}.`)
    }
    const row = db.select().from(token).where(eq(token.api_key_id, result.key.id)).get()
    if (!row || (row.kind !== 'personal' && row.kind !== 'scoped')) throw unauthenticated('The token is not a personal or scoped Stationly token.')
    db.update(token).set({ last_used_at: new Date() }).where(eq(token.id, row.id)).run()
    return {
      actor: { type: 'token', id: row.id, client: clientOf(request) },
      human: false,
      user_id: row.user_id,
      token_kind: row.kind,
      token_id: row.id,
      credential: row.id,
      scopes: row.kind === 'personal' ? fullAdmin : row.scopes,
      expires_at: row.expires_at,
      resource: null
    }
  }
  const value = bearerOf(request.headers)
  if (value) return isJwt(value) ? oauthPrincipal(db, auth, request, value) : sessionPrincipal(auth, request, value)
  if (surface === 'dashboard' || surface === 'local') {
    const headers = new Headers(request.headers)
    headers.delete('authorization')
    const session = await auth.current.api.getSession({ headers })
    if (session) {
      if (!safeMethods.has(request.method)) {
        const origin = request.headers.get('origin')
        if (!origin || !auth.surface.trustedOrigins.includes(origin)) {
          throw unauthenticated('A session cookie on a mutation must come with an Origin header from the dashboard.')
        }
      }
      return {
        actor: { type: 'user', id: session.user.id, client: clientOf(request) },
        human: true,
        user_id: session.user.id,
        token_kind: 'session',
        token_id: null,
        credential: session.session.id,
        scopes: fullAdmin,
        expires_at: new Date(session.session.expiresAt),
        resource: null
      }
    }
  }
  throw unauthenticated('No credential was sent.')
}

export const principalCache = (db: Db, auth: AuthService) => {
  const cache = new WeakMap<Request, Promise<Principal>>()
  return (request: Request) => {
    let found = cache.get(request)
    if (!found) {
      found = authenticate(db, auth, request)
      cache.set(request, found)
    }
    return found
  }
}
