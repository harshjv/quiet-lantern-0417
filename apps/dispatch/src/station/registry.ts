import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'

import type { MessageBody } from '@stationly/protocol'

import type { Db } from '../db/client.ts'
import { app, deployment, project, server, target } from '../db/schema.ts'

type Item = MessageBody<'registry.delete'>['items'][number]

const terminal = new Set(['superseded', 'failed', 'cancelled'])

const split = (imageRef: string, registry: string) => {
  if (!imageRef.startsWith(`${registry}/`)) {
    return null
  }

  const rest = imageRef.slice(registry.length + 1)
  const at = rest.indexOf('@')

  if (at < 0) {
    return null
  }

  return {
    repository: rest.slice(0, at),
    digest: rest.slice(at + 1),
  }
}

export const retentionItems = (db: Db, stationId: string): Item[] => {
  const st = db.select().from(server).where(eq(server.id, stationId)).get()

  if (!st?.registry_address) {
    return []
  }

  const apps = db
    .select({
      id: app.id,
      current: app.current_deployment_id,
      keep: project.image_retention_count,
    })
    .from(app)
    .innerJoin(target, eq(target.id, app.target_id))
    .innerJoin(project, eq(project.id, target.project_id))
    .where(eq(app.server_id, stationId))
    .all()
  const items = new Map<string, Item>()

  for (const svc of apps) {
    const deps = db
      .select()
      .from(deployment)
      .where(and(eq(deployment.app_id, svc.id), isNotNull(deployment.image_ref)))
      .orderBy(desc(deployment.number))
      .all()
    const withImage = deps.filter((d) => split(d.image_ref!, st.registry_address!))
    const newest = [...new Set(withImage.map((d) => d.image_ref!))].slice(0, svc.keep)
    const keptRefs = new Set(newest)

    for (const d of withImage) {
      if (d.id === svc.current || !terminal.has(d.status)) {
        keptRefs.add(d.image_ref!)
      }
    }

    for (const d of withImage) {
      if (keptRefs.has(d.image_ref!) || d.image_pruned_at) {
        continue
      }

      const parts = split(d.image_ref!, st.registry_address)!

      items.set(d.image_ref!, {
        ...parts,
        reason: `deployment ${d.number} of ${svc.id} is outside image_retention_count ${svc.keep}`,
      })
    }
  }

  return [...items.values()].slice(0, 500)
}

export const recordDeletes = (
  db: Db,
  stationId: string,
  result: MessageBody<'registry.delete.result'>,
) => {
  const st = db
    .select({
      registry_address: server.registry_address,
    })
    .from(server)
    .where(eq(server.id, stationId))
    .get()

  if (!st?.registry_address) {
    return 0
  }

  const refs = result.items
    .filter((i) => i.status === 'deleted' || i.status === 'absent')
    .map((i) => `${st.registry_address}/${i.repository}@${i.digest}`)

  if (!refs.length) {
    return 0
  }

  return db
    .update(deployment)
    .set({
      image_pruned_at: new Date(),
    })
    .where(and(inArray(deployment.image_ref, refs), isNull(deployment.image_pruned_at)))
    .run().changes
}
