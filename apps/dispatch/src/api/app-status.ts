import { and, desc, eq, ne } from 'drizzle-orm'

import { deploymentOpenStatuses } from '@stationly/protocol'

import type { Db } from '../db/client.ts'
import { app, deployment, server } from '../db/schema.ts'
import { appSubject, emitEvent } from '../station/events.ts'

type AppRow = typeof app.$inferSelect
type DeploymentRow = typeof deployment.$inferSelect

export type AppStatus = AppRow['status']

export type DerivedStatus = Pick<AppRow, 'status' | 'status_reason'>

export type StatusInputs = {
  desired_state: AppRow['desired_state']
  server_status: (typeof server.$inferSelect)['status'] | null
  newest: Pick<DeploymentRow, 'status'> | null
  current: Pick<DeploymentRow, 'status' | 'health_failed'> | null
}

const open = new Set<string>(deploymentOpenStatuses)

const derived = (status: AppStatus, status_reason: AppRow['status_reason'] = null) => ({
  status,
  status_reason,
})

export const deriveAppStatus = (input: StatusInputs): DerivedStatus => {
  if (input.desired_state === 'stopped') {
    return derived('stopped')
  }

  if (input.server_status === 'asleep') {
    return derived('asleep', 'server_asleep')
  }

  if (input.newest && open.has(input.newest.status)) {
    return derived('deploying')
  }

  if (
    input.newest?.status !== 'failed' &&
    input.current?.status === 'active' &&
    !input.current.health_failed
  ) {
    return derived('healthy')
  }

  if (!input.current && input.newest?.status !== 'failed') {
    return derived('not_deployed')
  }

  return derived('failing')
}

export const appStatusOf = (
  db: Db,
  row: Pick<AppRow, 'id' | 'desired_state' | 'server_id' | 'current_deployment_id'>,
): DerivedStatus =>
  deriveAppStatus({
    desired_state: row.desired_state,
    server_status:
      db
        .select({
          status: server.status,
        })
        .from(server)
        .where(eq(server.id, row.server_id))
        .get()?.status ?? null,
    newest:
      db
        .select({
          status: deployment.status,
        })
        .from(deployment)
        .where(eq(deployment.app_id, row.id))
        .orderBy(desc(deployment.number))
        .limit(1)
        .get() ?? null,
    current: row.current_deployment_id
      ? (db
          .select({
            status: deployment.status,
            health_failed: deployment.health_failed,
          })
          .from(deployment)
          .where(eq(deployment.id, row.current_deployment_id))
          .get() ?? null)
      : null,
  })

export const refreshAppStatus = (db: Db, appId: string, details: Record<string, unknown>) => {
  const row = db.select().from(app).where(eq(app.id, appId)).get()

  if (!row) {
    return false
  }

  const next = appStatusOf(db, row)

  if (row.status === next.status && row.status_reason === next.status_reason) {
    return false
  }

  db.update(app).set(next).where(eq(app.id, appId)).run()

  if (row.status !== next.status) {
    emitEvent(db, 'health.changed', appSubject(db, appId), {
      from: row.status,
      to: next.status,
      ...details,
    })
  }

  return true
}

export const refreshDeploymentApp = (db: Db, deploymentId: string) => {
  const dep = db
    .select({
      app_id: deployment.app_id,
    })
    .from(deployment)
    .where(eq(deployment.id, deploymentId))
    .get()

  return dep
    ? refreshAppStatus(db, dep.app_id, {
        source: 'deployment',
        deployment_id: deploymentId,
      })
    : false
}

export const refreshServerApps = (db: Db, serverId: string) => {
  for (const { id } of db
    .select({
      id: app.id,
    })
    .from(app)
    .where(eq(app.server_id, serverId))
    .all()) {
    refreshAppStatus(db, id, {
      source: 'server',
      server_id: serverId,
    })
  }
}

export const recordHealth = (db: Db, deploymentId: string, failed: boolean) =>
  db
    .update(deployment)
    .set({
      health_failed: failed,
    })
    .where(and(eq(deployment.id, deploymentId), ne(deployment.health_failed, failed)))
    .run()

export const heartbeatFailed = (hint: string, health: string) =>
  health === 'failed' || (health === 'none' && hint === 'stopped')
