import { and, eq, inArray } from 'drizzle-orm'

import type { Db } from '../db/client.ts'
import { app, app_port, domain, target } from '../db/schema.ts'

import type { TaskRow } from './status.ts'

export const previewOf = (db: Db, row: Pick<TaskRow, 'preview_id'>) =>
  row.preview_id ? db.select().from(target).where(eq(target.id, row.preview_id)).get() : undefined

export const previewAddress = (db: Db, previewId: string) => {
  const ports = db
    .select({
      id: app_port.id,
    })
    .from(app_port)
    .innerJoin(app, eq(app.id, app_port.app_id))
    .where(and(eq(app.target_id, previewId)))
    .all()
  const routed = ports.length
    ? db
        .select()
        .from(domain)
        .where(
          inArray(
            domain.app_port_id,
            ports.map((port) => port.id),
          ),
        )
        .get()
    : undefined

  return routed ? `https://${routed.hostname}` : null
}
