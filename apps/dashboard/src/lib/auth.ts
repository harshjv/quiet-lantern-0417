import { passkeyClient } from '@better-auth/passkey/client'
import { queryOptions } from '@tanstack/react-query'
import { createAuthClient } from 'better-auth/client'
import { twoFactorClient } from 'better-auth/client/plugins'

export const authClient = createAuthClient({
  baseURL: `${window.location.origin}/auth`,
  plugins: [twoFactorClient(), passkeyClient()],
})

export type AuthUser = {
  id: string
  email: string
  name: string
  twoFactorEnabled?: boolean | null
}

export const sessionQuery = queryOptions({
  queryKey: ['auth', 'session'],
  queryFn: async () => {
    const { data, error } = await authClient.getSession()

    if (error) {
      throw new Error(error.message ?? 'Stationly couldn’t read your session.')
    }

    return data
      ? {
          user: data.user,
          expiresAt: new Date(data.session.expiresAt).toISOString(),
        }
      : null
  },
  staleTime: 60_000,
})

export const passkeysQuery = queryOptions({
  queryKey: ['auth', 'passkeys'],
  queryFn: async () => {
    const { data, error } = await authClient.passkey.listUserPasskeys()

    if (error) {
      throw new Error(error.message ?? 'Stationly couldn’t list your passkeys.')
    }

    return (data ?? []).map((p) => ({
      id: p.id,
      name: p.name ?? null,
      deviceType: p.deviceType,
      backedUp: p.backedUp,
      createdAt: p.createdAt ? new Date(p.createdAt).toISOString() : null,
    }))
  },
})

const ipLiteral = /^(\d{1,3}\.){3}\d{1,3}$|^\[.*\]$/

export const passkeysAvailable = () =>
  window.location.protocol === 'https:' &&
  !ipLiteral.test(window.location.hostname) &&
  typeof window.PublicKeyCredential === 'function'

export const safeNext = (next: string | undefined) =>
  next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : null

export const serverPage = (path: string) =>
  path === '/device' || path.startsWith('/device?') || path.startsWith('/github/')

export const authMessage = (
  error: { message?: string; code?: string; status?: number } | null | undefined,
  fallback: string,
) => error?.message || (error?.code ? error.code.replaceAll('_', ' ').toLowerCase() : fallback)
