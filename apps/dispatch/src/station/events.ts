import { EventEmitter } from 'node:events'

import { eq } from 'drizzle-orm'

import type { Db } from '../db/client.ts'
import { newId } from '../db/ids.ts'
import { environment, event, service } from '../db/schema.ts'

type Subject = {
  entity: string
  id: string
  project_id?: string
  environment_id?: string
} & Record<string, unknown>

export const payloadLimitBytes = 8 * 1024

export const eventBus = new EventEmitter()
eventBus.setMaxListeners(0)

export const serviceSubject = (db: Db, serviceId: string): Subject => {
  const row = db
    .select({
      environment_id: service.environment_id,
      project_id: environment.project_id,
    })
    .from(service)
    .innerJoin(environment, eq(environment.id, service.environment_id))
    .where(eq(service.id, serviceId))
    .get()

  return row
    ? {
        entity: 'service',
        id: serviceId,
        service_id: serviceId,
        project_id: row.project_id,
        environment_id: row.environment_id,
      }
    : {
        entity: 'service',
        id: serviceId,
      }
}

const environmentSubject = (db: Db, subject: Subject): Subject => {
  if (subject.project_id || !subject.environment_id) {
    return subject
  }

  const env = db
    .select({
      project_id: environment.project_id,
    })
    .from(environment)
    .where(eq(environment.id, subject.environment_id))
    .get()

  return env
    ? {
        ...subject,
        project_id: env.project_id,
      }
    : subject
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
      subject: environmentSubject(db, subject),
      payload: bounded(id, type, payload),
      delivered: {},
    })
    .run()
  setImmediate(() => eventBus.emit('event', id))

  return id
}
