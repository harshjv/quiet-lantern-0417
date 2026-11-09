import { createHash } from 'node:crypto'
import { createWriteStream, renameSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { Type } from '@sinclair/typebox'
import { Elysia } from 'elysia'
import { newId } from '../../db/ids.ts'
import { blob } from '../../db/schema.ts'
import { blobFile } from '../../station/blobs.ts'
import { requireLevel } from '../access.ts'
import { audit } from '../context.ts'
import { fail } from '../errors.ts'
import type { Kit } from '../kit.ts'
import { serviceById } from '../lookup.ts'
import { models, replies } from '../shapes.ts'

const Blob = Type.Object({ blob_id: Type.String(), size_bytes: Type.Integer(), sha256: Type.String(), expires_at: Type.String() }, { additionalProperties: false })

export const maxUploadBytes = 512 * 1024 * 1024
const uploadTtlMs = 24 * 3600 * 1000

export const blobRoutes = (kit: Kit) => {
  const { db, blobDir } = kit.deps
  return new Elysia({ prefix: '/v1', normalize: false }).use(models()).post(
    '/blobs',
    async ({ request, set }) => {
      const call = await kit.call(request)
      const serviceRef = request.headers.get('x-stationly-service')
      if (!serviceRef) fail('VALIDATION_FAILED', 'X-Stationly-Service must name the service the upload is for.', undefined, { issues: [{ path: '/headers/x-stationly-service', message: 'required' }] })
      const ctx = serviceById(db, serviceRef!)
      requireLevel(call.principal, ctx.target, 'deploy')
      const length = Number(request.headers.get('content-length'))
      if (!Number.isInteger(length) || length <= 0) fail('VALIDATION_FAILED', 'Content-Length is required and must be positive.', undefined, { issues: [{ path: '/headers/content-length', message: 'required' }] })
      if (length > maxUploadBytes) fail('VALIDATION_FAILED', `The upload is ${length} bytes; the limit is ${maxUploadBytes}.`, 'Add large build inputs to .dockerignore, or push over SSH.', { issues: [{ path: '/headers/content-length', message: 'too large' }] })
      if (!request.body) fail('VALIDATION_FAILED', 'The request has no body.')
      const id = newId('blob')
      const partial = `${blobFile(blobDir, id)}.partial`
      const out = createWriteStream(partial, { mode: 0o600 })
      const hash = createHash('sha256')
      let size = 0
      try {
        for await (const chunk of request.body as unknown as AsyncIterable<Uint8Array>) {
          size += chunk.length
          if (size > length) fail('VALIDATION_FAILED', 'The body is longer than Content-Length.')
          hash.update(chunk)
          if (!out.write(chunk)) await once(out, 'drain')
        }
        out.end()
        await once(out, 'finish')
      } catch (error) {
        out.destroy()
        rmSync(partial, { force: true })
        throw error
      }
      if (size !== length) {
        rmSync(partial, { force: true })
        fail('VALIDATION_FAILED', `The body is ${size} bytes but Content-Length said ${length}.`)
      }
      renameSync(partial, blobFile(blobDir, id))
      const expires_at = new Date(Date.now() + uploadTtlMs)
      const sha256 = hash.digest('hex')
      db.insert(blob).values({ id, kind: 'push_tarball', size_bytes: size, sha256, expires_at, service_id: ctx.service.id }).run()
      audit(db, call, 'blob.upload', { entity: 'blob', id }, { after: { service_id: ctx.service.id, size_bytes: size, sha256 } })
      set.status = 201
      return { blob_id: id, size_bytes: size, sha256, expires_at: expires_at.toISOString() }
    },
    { parse: 'none', response: replies({ 201: Blob }), detail: { summary: 'Upload a gzip tarball of a local directory for sly push; deploy it with blob_id', tags: ['deployments'] } }
  )
}
