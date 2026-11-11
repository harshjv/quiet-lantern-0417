import { eq } from 'drizzle-orm'

import type { Db } from '../db/client.ts'
import { newId } from '../db/ids.ts'
import { apikey, token } from '../db/schema.ts'

import { v1Permission, type AuthService } from './auth.ts'
import { revokeGrantArtifacts } from './grants.ts'
import type { Scope } from './scopes.ts'

export type TokenRow = typeof token.$inferSelect

type Mint = {
  userId: string
  name: string
  kind: 'scoped' | 'personal'
  scopes: Scope[]
  seconds: number
}

export const tokenRow = (db: Db, id: string) =>
  db.select().from(token).where(eq(token.id, id)).get()

export const mintToken = async (auth: AuthService, db: Db, mint: Mint) => {
  const id = newId('token')
  const created = await auth.current.api.createApiKey({
    body: {
      userId: mint.userId,
      expiresIn: mint.seconds,
      metadata: {
        token_id: id,
      },
      permissions: v1Permission,
    },
  })

  db.insert(token)
    .values({
      id,
      user_id: mint.userId,
      name: mint.name,
      kind: mint.kind,
      scopes: mint.scopes,
      expires_at: new Date(created.expiresAt ?? Date.now() + mint.seconds * 1000),
      api_key_id: created.id,
    })
    .run()

  return {
    row: tokenRow(db, id)!,
    key: created.key,
  }
}

export const extendToken = async (auth: AuthService, db: Db, row: TokenRow, seconds: number) => {
  const updated = await auth.current.api.updateApiKey({
    body: {
      keyId: row.api_key_id!,
      userId: row.user_id,
      expiresIn: seconds,
    },
  })
  const expires = new Date(updated.expiresAt ?? Date.now() + seconds * 1000)

  db.update(token)
    .set({
      expires_at: expires,
    })
    .where(eq(token.id, row.id))
    .run()

  return expires
}

export const dropToken = (db: Pick<Db, 'delete'>, row: TokenRow) => {
  if (row.api_key_id) {
    db.delete(apikey).where(eq(apikey.id, row.api_key_id)).run()
  }

  if (row.kind === 'oauth') {
    revokeGrantArtifacts(db, row.id)
  }

  db.delete(token).where(eq(token.id, row.id)).run()
}
