import { and, eq, isNotNull } from 'drizzle-orm'

import { recordAudit } from '../db/audit.ts'
import type { Db } from '../db/client.ts'
import { sandbox } from '../db/schema.ts'
import { readSetting } from '../db/settings.ts'
import type { Log } from '../log.ts'
import { every } from '../schedule.ts'

import { activityOf, inUse } from './activity.ts'
import { stopSandbox, systemActor } from './lifecycle.ts'

export type IdleStopDeps = { db: Db; stations: { reconcile(stationId?: string): void } }

export const idleStopSeconds = (db: Db) => readSetting(db, 'sandbox.workspace_idle_stop_s')

export const runIdleStop = (deps: IdleStopDeps, now = new Date()) => {
  const { db } = deps
  const idle = idleStopSeconds(db)
  const stopped: string[] = []

  if (idle === 0) {
    return stopped
  }

  const touched = new Set<string>()

  for (const row of db
    .select()
    .from(sandbox)
    .where(
      and(
        eq(sandbox.status, 'running'),
        eq(sandbox.desired_state, 'running'),
        isNotNull(sandbox.workspace),
      ),
    )
    .all()) {
    const last = activityOf(db, row)

    if (!last || now.getTime() - last.getTime() < idle * 1000 || inUse(db, row)) {
      continue
    }

    stopSandbox(db, row, 'idle')
    recordAudit(db, {
      actor: systemActor,
      action: 'sandbox.stop',
      target: {
        entity: 'sandbox',
        id: row.id,
      },
      before: {
        status: row.status,
      },
    })
    stopped.push(row.id)
    touched.add(row.station_id)
  }

  for (const id of touched) {
    deps.stations.reconcile(id)
  }

  return stopped
}

export const startIdleStop = (deps: IdleStopDeps, log: Log) =>
  every(60, 'sandbox.idle_stop_failed', log, () => {
    const stopped = runIdleStop(deps)

    if (stopped.length) {
      log('sandbox.idle_stop', {
        sandboxes: stopped,
      })
    }
  })
