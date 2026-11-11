import { APIError } from 'better-auth/api'
import { and, eq } from 'drizzle-orm'

import type { Db } from '../db/client.ts'
import { oauthAccessToken, oauthConsent, oauthRefreshToken, token } from '../db/schema.ts'

import type { Level } from './scopes.ts'

export const oauthAccessSeconds = 3600
export const oauthRefreshSeconds = 30 * 24 * 3600
export const oauthCodeSeconds = 600

export const levelScopes = {
  read: 'stationly:read',
  deploy: 'stationly:deploy',
  admin: 'stationly:admin',
} as const satisfies Record<Level, string>

export const levelOfScope = (scope: string): Level | null => {
  const found = Object.entries(levelScopes).find(([, value]) => value === scope)

  return found ? (found[0] as Level) : null
}

const pending = new Map<string, string>()

export const pendingGrant = (sessionId: string) => pending.get(sessionId)

export const withPendingGrant = async <T>(
  sessionId: string,
  tokenId: string,
  run: () => Promise<T>,
) => {
  pending.set(sessionId, tokenId)

  try {
    return await run()
  } finally {
    pending.delete(sessionId)
  }
}

export const liveGrant = (db: Db, tokenId: string | undefined) => {
  if (!tokenId) {
    return null
  }

  const row = db
    .select()
    .from(token)
    .where(and(eq(token.id, tokenId), eq(token.kind, 'oauth')))
    .get()

  if (!row || row.expires_at.getTime() <= Date.now()) {
    return null
  }

  return row
}

export const grantClaims = (db: Db, referenceId: string | undefined) => {
  const row = liveGrant(db, referenceId)

  if (!row) {
    throw new APIError('BAD_REQUEST', {
      error: 'invalid_grant',
      error_description: 'this OAuth grant was revoked or has expired',
    })
  }

  return {
    sly_token: row.id,
    sly_scopes: row.scopes,
  }
}

export const revokeGrantArtifacts = (tx: Pick<Db, 'delete'>, tokenId: string) => {
  tx.delete(oauthAccessToken).where(eq(oauthAccessToken.referenceId, tokenId)).run()
  tx.delete(oauthRefreshToken).where(eq(oauthRefreshToken.referenceId, tokenId)).run()
  tx.delete(oauthConsent).where(eq(oauthConsent.referenceId, tokenId)).run()
}
