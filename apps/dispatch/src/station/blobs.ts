import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'

import { and, eq, lt } from 'drizzle-orm'

import type { MessageBody } from '@stationly/protocol'

import type { Db } from '../db/client.ts'
import { newId } from '../db/ids.ts'
import { blob } from '../db/schema.ts'

const grantTtlMs = 10 * 60 * 1000
const blobPath =
  /^\/v1\/stations\/(stn_[0-9A-HJKMNP-TV-Z]{26})\/blobs\/(blb_[0-9A-HJKMNP-TV-Z]{26})$/

type BlobKind = (typeof blob.$inferInsert)['kind']

const digest = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex')

export const blobFile = (dir: string, blobId: string) => join(dir, blobId)

export const storeBlob = (
  db: Db,
  dir: string,
  input: { kind: BlobKind; bytes: Buffer; ttlMs: number; service_id?: string | null },
) => {
  const id = newId('blob')
  const sha256 = createHash('sha256').update(input.bytes).digest('hex')
  const partial = `${blobFile(dir, id)}.partial`

  writeFileSync(partial, input.bytes, {
    mode: 0o600,
  })
  renameSync(partial, blobFile(dir, id))
  const expires_at = new Date(Date.now() + input.ttlMs)

  db.insert(blob)
    .values({
      id,
      kind: input.kind,
      size_bytes: input.bytes.length,
      sha256,
      expires_at,
      service_id: input.service_id ?? null,
    })
    .run()

  return {
    id,
    size_bytes: input.bytes.length,
    sha256,
    expires_at,
  }
}

export const sweepBlobs = (db: Db, dir: string, now = new Date()) => {
  const expired = db
    .select({
      id: blob.id,
    })
    .from(blob)
    .where(lt(blob.expires_at, now))
    .all()

  for (const row of expired) {
    rmSync(blobFile(dir, row.id), {
      force: true,
    })
    db.delete(blob).where(eq(blob.id, row.id)).run()
  }

  return expired.length
}

export const mintGrant = (
  db: Db,
  stationId: string,
  blobId: string,
  now = new Date(),
): MessageBody<'blob.granted'> => {
  const row = db.select().from(blob).where(eq(blob.id, blobId)).get()

  if (!row) {
    throw new Error(`blob ${blobId} does not exist`)
  }

  const token = randomBytes(32).toString('base64url')
  const expires = new Date(now.getTime() + grantTtlMs)

  db.update(blob)
    .set({
      grant_sha256: digest(token),
      grant_station_id: stationId,
      grant_expires_at: expires,
    })
    .where(eq(blob.id, blobId))
    .run()

  return {
    blob_id: blobId,
    size: row.size_bytes,
    sha256: row.sha256,
    token,
    expires_at: expires.toISOString(),
  }
}

const send = (res: ServerResponse, status: number, code: string, explanation: string) => {
  const body = JSON.stringify({
    error: {
      code,
      explanation,
      fix: 'Ask Dispatch for a fresh grant with blob.grant.',
      details: {},
    },
  })

  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

export const serveBlob = (db: Db, dir: string, req: IncomingMessage, res: ServerResponse) => {
  const match = blobPath.exec(new URL(req.url ?? '/', 'http://dispatch').pathname)

  if (!match) {
    return false
  }

  if (req.method !== 'GET') {
    send(res, 405, 'NOT_FOUND', 'blob fetch is GET only')

    return true
  }

  const [, stationId, blobId] = match
  const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1]
  const row = db
    .select()
    .from(blob)
    .where(and(eq(blob.id, blobId!), eq(blob.grant_station_id, stationId!)))
    .get()
  const presented = token ? digest(token) : ''
  const valid =
    !!row?.grant_sha256 &&
    !!row.grant_expires_at &&
    presented.length === row.grant_sha256.length &&
    timingSafeEqual(Buffer.from(presented), Buffer.from(row.grant_sha256)) &&
    Date.now() < row.grant_expires_at.getTime()

  if (!row || !valid) {
    send(res, 401, 'UNAUTHENTICATED', 'the blob grant is unknown, for another station, or expired')

    return true
  }

  const path = blobFile(dir, row.id)
  let size: number

  try {
    size = statSync(path).size
  } catch {
    send(res, 404, 'NOT_FOUND', `blob ${row.id} has no stored content`)

    return true
  }

  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': size,
    'x-content-sha256': row.sha256,
  })
  createReadStream(path).pipe(res)

  return true
}
