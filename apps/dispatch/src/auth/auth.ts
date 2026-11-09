import { hkdfSync } from 'node:crypto'
import { apiKey } from '@better-auth/api-key'
import { cimd } from '@better-auth/cimd'
import { drizzleAdapter } from '@better-auth/drizzle-adapter'
import { mcp } from '@better-auth/mcp'
import type { ClientMetadataResourceFetch } from '@better-auth/oauth-provider'
import { passkey } from '@better-auth/passkey'
import { betterAuth } from 'better-auth'
import { APIError } from 'better-auth/api'
import { admin, bearer, deviceAuthorization, jwt, magicLink, twoFactor } from 'better-auth/plugins'
import { count, eq, inArray } from 'drizzle-orm'
import type { Db } from '../db/client.ts'
import * as schema from '../db/schema.ts'
import { grantClaims, levelScopes, oauthAccessSeconds, oauthCodeSeconds, oauthRefreshSeconds, pendingGrant } from './grants.ts'
import { ProofError, proofHeader, publicUrl, verifyProof } from './proof.ts'

export const apiKeyPrefix = 'sly_'
export const minPasswordLength = 12
export const personalTokenDefaultSeconds = 90 * 24 * 3600
export const personalTokenMaxSeconds = 365 * 24 * 3600
export const scopedTokenDefaultSeconds = 3600
export const scopedTokenMaxSeconds = 30 * 24 * 3600
export const v1Permission = { v1: ['access'] }
export const slySessionSeconds = 12 * 3600
export const slyClientId = 'sly'
export const loginLinkSeconds = 15 * 60

const loginLinks = new Map<string, string>()

export const takeLoginLink = (email: string) => {
  const key = email.toLowerCase()
  const url = loginLinks.get(key) ?? null
  loginLinks.delete(key)
  return url
}

export const apiKeyFromHeaders = (headers: Headers | undefined) => {
  const authorization = headers?.get('authorization')
  const bearer = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1]
  if (bearer?.startsWith(apiKeyPrefix)) return bearer
  return headers?.get('x-api-key') ?? null
}

export type AuthSurface = {
  baseURL: string
  dashboardOrigin: string
  apiOrigin: string
  rpID: string
  addressOrigin: string | null
  passkeyOrigins: string[]
  trustedOrigins: string[]
  mcpResource: string
}

export const canonicalOrigin = (surface: AuthSurface, request: Request) => {
  const host = request.headers.get('host') ?? new URL(request.url).host
  const origin = `https://${host}`
  return origin === surface.apiOrigin || origin === surface.dashboardOrigin ? origin : null
}

const surfaceKeys = ['hostnames.dashboard', 'hostnames.api', 'auth.passkey_rp_id'] as const

export const authSurface = (db: Db, localOrigin: string): AuthSurface => {
  const rows = db.select().from(schema.setting).where(inArray(schema.setting.key, [...surfaceKeys])).all()
  const value = (key: (typeof surfaceKeys)[number]) => {
    const found = rows.find(row => row.key === key)?.value
    return typeof found === 'string' && found.length > 0 ? found : null
  }
  const dashboard = value('hostnames.dashboard')
  const api = value('hostnames.api')
  const local = new URL(localOrigin)
  const loopbackOrigins = [localOrigin, `http://localhost:${local.port}`]
  if (!dashboard || !api) {
    const address = db.select({ public_address: schema.station.public_address }).from(schema.station).where(eq(schema.station.hosts_dispatch, true)).get()?.public_address
    const addressOrigin = address ? `https://${address}` : null
    return {
      baseURL: `${localOrigin}/auth`,
      dashboardOrigin: localOrigin,
      apiOrigin: localOrigin,
      addressOrigin,
      rpID: 'localhost',
      passkeyOrigins: [`http://localhost:${local.port}`],
      trustedOrigins: addressOrigin ? [...loopbackOrigins, addressOrigin] : loopbackOrigins,
      mcpResource: `${localOrigin}/mcp`
    }
  }
  const dashboardOrigin = `https://${dashboard}`
  const apiOrigin = `https://${api}`
  return {
    baseURL: `${apiOrigin}/auth`,
    dashboardOrigin,
    apiOrigin,
    addressOrigin: null,
    rpID: value('auth.passkey_rp_id') ?? dashboard,
    passkeyOrigins: [dashboardOrigin, apiOrigin],
    trustedOrigins: [dashboardOrigin, ...loopbackOrigins],
    mcpResource: `${apiOrigin}/mcp`
  }
}

export const authSecret = (masterKey: Buffer) =>
  Buffer.from(hkdfSync('sha256', masterKey, Buffer.alloc(0), 'stationly/better-auth-secret', 32)).toString('base64url')

export const userExists = (db: Db) => (db.select({ n: count() }).from(schema.user).get()?.n ?? 0) > 0

const dynamicRegistrationEnabled = (db: Db) => db.select().from(schema.setting).where(eq(schema.setting.key, 'oauth.dynamic_registration')).get()?.value === true

export type AuthOptions = { dynamicRegistration: boolean; fetchMetadata: ClientMetadataResourceFetch }

export const createAuth = (db: Db, surface: AuthSurface, secret: string, options: AuthOptions) =>
  betterAuth({
    appName: 'stationly',
    baseURL: surface.baseURL,
    basePath: '/auth',
    secret,
    database: drizzleAdapter(db, { provider: 'sqlite', schema }),
    telemetry: { enabled: false },
    trustedOrigins: [...new Set([...surface.trustedOrigins, surface.apiOrigin])],
    rateLimit: { enabled: true },
    disabledPaths: ['/token', '/sign-in/magic-link'],
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength,
      requireEmailVerification: false
    },
    session: {
      expiresIn: 7 * 24 * 3600,
      updateAge: 24 * 3600,
      additionalFields: { popJkt: { type: 'string', required: false, input: false } }
    },
    advanced: {
      ipAddress: { ipAddressHeaders: ['x-forwarded-for'] },
      useSecureCookies: surface.baseURL.startsWith('https://'),
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' }
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session, ctx) => {
            if (ctx?.path !== '/device/token') return
            const request = ctx.request
            if (!request) throw new APIError('BAD_REQUEST', { error: 'invalid_dpop_proof', error_description: 'sly login must reach /auth/device/token over HTTP' })
            try {
              const proof = await verifyProof(ctx.context.internalAdapter, {
                proof: request.headers.get(proofHeader),
                method: 'POST',
                url: publicUrl(request, canonicalOrigin(surface, request))
              })
              return { data: { ...session, expiresAt: new Date(Date.now() + slySessionSeconds * 1000), popJkt: proof.jkt } }
            } catch (error) {
              if (error instanceof ProofError) throw new APIError('BAD_REQUEST', { error: 'invalid_dpop_proof', error_description: error.message })
              throw error
            }
          }
        }
      }
    },
    plugins: [
      twoFactor({ issuer: 'stationly', trustDeviceMaxAge: 30 * 24 * 3600 }),
      passkey({
        rpID: surface.rpID,
        rpName: 'stationly',
        origin: surface.passkeyOrigins,
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        authentication: {
          afterVerification: async ({ verification }) => {
            if (!verification.authenticationInfo.userVerified) throw new Error('passkey assertion without user verification')
          }
        }
      }),
      apiKey({
        defaultPrefix: apiKeyPrefix,
        customAPIKeyGetter: ctx => apiKeyFromHeaders(ctx.headers),
        enableMetadata: true,
        keyExpiration: { defaultExpiresIn: personalTokenDefaultSeconds, minExpiresIn: 1 / 24 },
        rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 600 },
        enableSessionForAPIKeys: false
      }),
      deviceAuthorization({
        verificationUri: `${surface.dashboardOrigin}/device`,
        expiresIn: '10m',
        interval: '5s',
        validateClient: clientId => clientId === slyClientId
      }),
      bearer(),
      admin(),
      magicLink({
        expiresIn: loginLinkSeconds,
        disableSignUp: true,
        storeToken: 'hashed',
        sendMagicLink: async ({ email, url }) => {
          loginLinks.set(email.toLowerCase(), url)
        }
      }),
      jwt({ disableSettingJwtHeader: true }),
      mcp({
        resource: surface.mcpResource,
        loginPage: '/auth/login',
        consentPage: '/auth/consent',
        scopes: ['openid', 'offline_access', ...Object.values(levelScopes)],
        grantTypes: ['authorization_code', 'refresh_token'],
        accessTokenExpiresIn: oauthAccessSeconds,
        refreshTokenExpiresIn: oauthRefreshSeconds,
        codeExpiresIn: oauthCodeSeconds,
        allowDynamicClientRegistration: options.dynamicRegistration,
        allowUnauthenticatedClientRegistration: options.dynamicRegistration,
        clientRegistrationDefaultApplicationType: 'infer',
        postLogin: {
          page: '/auth/consent',
          shouldRedirect: () => false,
          consentReferenceId: ({ session }) => pendingGrant(session.id)
        },
        customAccessTokenClaims: ({ referenceId }) => grantClaims(db, referenceId)
      }),
      cimd({ fetchClientMetadataResource: options.fetchMetadata, metadataProfile: 'mcp-2026-07-28' })
    ]
  })

export type Auth = ReturnType<typeof createAuth>

export class AuthService {
  private auth: Auth
  readonly surfaceOf: () => AuthSurface
  private readonly db: Db
  private readonly secret: string
  private readonly fetchMetadata: ClientMetadataResourceFetch
  readonly localOrigin: string
  surface: AuthSurface

  constructor(db: Db, masterKey: Buffer, localOrigin: string, fetchMetadata: ClientMetadataResourceFetch) {
    this.db = db
    this.localOrigin = localOrigin
    this.secret = authSecret(masterKey)
    this.fetchMetadata = fetchMetadata
    this.surfaceOf = () => authSurface(db, localOrigin)
    this.surface = this.surfaceOf()
    this.auth = this.build()
  }

  private build() {
    return createAuth(this.db, this.surface, this.secret, {
      dynamicRegistration: dynamicRegistrationEnabled(this.db),
      fetchMetadata: this.fetchMetadata
    })
  }

  get current() {
    return this.auth
  }

  get secretKey() {
    return this.secret
  }

  rebuild() {
    this.surface = this.surfaceOf()
    this.auth = this.build()
  }
}
