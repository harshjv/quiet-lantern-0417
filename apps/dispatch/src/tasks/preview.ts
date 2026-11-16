import { and, eq, inArray } from 'drizzle-orm'

import type { Db } from '../db/client.ts'
import { domain, environment, service, service_port } from '../db/schema.ts'

import type { TaskRow } from './status.ts'

export const previewOf = (db: Db, row: Pick<TaskRow, 'preview_environment_id'>) =>
  row.preview_environment_id
    ? db.select().from(environment).where(eq(environment.id, row.preview_environment_id)).get()
    : undefined

export const previewAddress = (db: Db, environmentId: string) => {
  const ports = db
    .select({
      id: service_port.id,
    })
    .from(service_port)
    .innerJoin(service, eq(service.id, service_port.service_id))
    .where(and(eq(service.environment_id, environmentId)))
    .all()
  const routed = ports.length
    ? db
        .select()
        .from(domain)
        .where(
          inArray(
            domain.service_port_id,
            ports.map((port) => port.id),
          ),
        )
        .get()
    : undefined

  return routed ? `https://${routed.hostname}` : null
}
