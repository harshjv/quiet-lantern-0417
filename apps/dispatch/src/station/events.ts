import { EventEmitter } from 'node:events'

import { eq } from 'drizzle-orm'

import type { Db } from '../db/client.ts'
import { newId } from '../db/ids.ts'
import { app, event, target } from '../db/schema.ts'

type Subject = {
  entity: string
  id: string
  project_id?: string
  preview_id?: string | null
  target_id?: string
} & Record<string, unknown>

export const payloadLimitBytes = 8 * 1024

export const eventBus = new EventEmitter()
eventBus.setMaxListeners(0)

export const appSubject = (db: Db, appId: string): Subject => {
  const row = db
    .select({
      kind: target.kind,
      target_id: app.target_id,
      project_id: target.project_id,
    })
    .from(app)
    .innerJoin(target, eq(target.id, app.target_id))
    .where(eq(app.id, appId))
    .get()

  return row
    ? {
        entity: 'app',
        id: appId,
        app_id: appId,
        project_id: row.project_id,
        preview_id: row.kind === 'preview' ? row.target_id : null,
      }
    : {
        entity: 'app',
        id: appId,
      }
}

const placedSubject = (db: Db, subject: Subject): Subject => {
  const { target_id: targetId, ...rest } = subject

  if (!targetId) {
    return rest
  }

  const row = db
    .select({
      kind: target.kind,
      project_id: target.project_id,
    })
    .from(target)
    .where(eq(target.id, targetId))
    .get()

  return row
    ? {
        ...rest,
        project_id: row.project_id,
        preview_id: row.kind === 'preview' ? targetId : null,
      }
    : rest
}

const bounded = (id: string, type: string, payload: Record<string, unknown>) => {
  if (Buffer.byteLength(JSON.stringify(payload)) <= payloadLimitBytes) {
    return payload
  }

  const kept: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(payload)) {
    if (typeof value !== 'object' || value === null) {
      kept[key] = value
    }
  }

  return {
    ...kept,
    truncated: true,
    ref: {
      entity: 'event',
      id,
      note: `the ${type} payload exceeded 8 KB; read the subject for detail`,
    },
  }
}

export const emitEvent = (
  db: Db,
  type: string,
  subject: Subject,
  payload: Record<string, unknown>,
) => {
  const id = newId('event')

  db.insert(event)
    .values({
      id,
      type,
      subject: placedSubject(db, subject),
      payload: bounded(id, type, payload),
      delivered: {},
    })
    .run()
  setImmediate(() => eventBus.emit('event', id))

  return id
}
