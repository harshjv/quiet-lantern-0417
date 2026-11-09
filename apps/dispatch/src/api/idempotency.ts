import { createHash } from 'node:crypto'
import canonicalize from 'canonicalize'
import { and, eq, lt } from 'drizzle-orm'
import type { Principal } from '../auth/principal.ts'
import type { Db } from '../db/client.ts'
import { idempotency_record } from '../db/schema.ts'
import { fail } from './errors.ts'

const retentionMs = 24 * 3600 * 1000

export const mutationMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

const actorKey = (principal: Principal) => `${principal.actor.type}:${principal.actor.id}`

const fingerprint = (method: string, url: URL, body: unknown) =>
  createHash('sha256')
    .update(canonicalize({ method, path: url.pathname, query: url.search, body: body ?? null }) ?? '', 'utf8')
    .digest('hex')

export type Replay = { status: number; response: unknown }

export const beginIdempotent = (db: Db, principal: Principal, key: string, request: Request, body: unknown): Replay | null => {
  if (!/^[\x21-\x7e]{1,255}$/.test(key)) fail('VALIDATION_FAILED', 'Idempotency-Key must be 1 to 255 visible ASCII characters.', undefined, { issues: [{ path: 'header:idempotency-key', message: 'invalid' }] })
  const now = new Date()
  db.delete(idempotency_record).where(lt(idempotency_record.expires_at, now)).run()
  const url = new URL(request.url)
  const hash = fingerprint(request.method, url, body)
  const actor = actorKey(principal)
  const existing = db
    .select()
    .from(idempotency_record)
    .where(and(eq(idempotency_record.actor, actor), eq(idempotency_record.key, key)))
    .get()
  if (existing) {
    if (existing.request_sha256 !== hash) {
      fail('IDEMPOTENCY_MISMATCH', `Idempotency-Key ${key} was used with a different request.`, 'Use a new Idempotency-Key for a different request.', {
        method: existing.method,
        path: existing.path
      })
    }
    if (existing.status === null) fail('IDEMPOTENCY_MISMATCH', `A request with Idempotency-Key ${key} is still running.`, 'Retry after the first request finishes.')
    return { status: existing.status!, response: existing.response }
  }
  db.insert(idempotency_record)
    .values({ actor, key, method: request.method, path: url.pathname, request_sha256: hash, created_at: now, expires_at: new Date(now.getTime() + retentionMs) })
    .run()
  return null
}

export const finishIdempotent = (db: Db, principal: Principal, key: string, status: number, response: unknown) =>
  db
    .update(idempotency_record)
    .set({ status, response: response ?? null })
    .where(and(eq(idempotency_record.actor, actorKey(principal)), eq(idempotency_record.key, key)))
    .run()

export const abandonIdempotent = (db: Db, principal: Principal, key: string) =>
  db
    .delete(idempotency_record)
    .where(and(eq(idempotency_record.actor, actorKey(principal)), eq(idempotency_record.key, key)))
    .run()
