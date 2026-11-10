import { and, eq, inArray } from 'drizzle-orm'

import type { MessageBody, Observed } from '@stationly/protocol'

import type { Db } from '../db/client.ts'
import { drift, station_generation } from '../db/schema.ts'

import { emitEvent } from './events.ts'
import { latestGeneration } from './generations.ts'

const settleMs = 30_000

type Finding = { key: string; desired: unknown; observed: unknown; reason: string }

export const mergeObserved = (
  current: Observed | undefined,
  update: MessageBody<'observed.update'>,
): Observed | undefined => {
  if (!current) return undefined
  const next = {
    ...current,
    observed_at: update.observed_at,
  } as Record<string, unknown>
  for (const [key, value] of Object.entries(update)) {
    if (key === 'observed_at' || value === undefined) continue
    const base = next[key]
    next[key] =
      key === 'station' || key === 'gateway' || typeof base !== 'object' || base === null
        ? value
        : {
            ...base,
            ...(value as object),
          }
  }
  return next as Observed
}

const findings = (db: Db, stationId: string, observed: Observed, now: number): Finding[] => {
  const acked = db
    .select()
    .from(station_generation)
    .where(
      and(
        eq(station_generation.station_id, stationId),
        inArray(station_generation.ack, ['applied', 'partial']),
      ),
    )
    .all()
    .sort((a, b) => b.generation - a.generation)[0]
  const out: Finding[] = []
  for (const u of observed.unknown) {
    if (!Object.keys(u.labels ?? {}).some((label) => label.startsWith('stationly.'))) continue
    out.push({
      key: `unknown/${u.kind}/${u.docker_id ?? u.id}`,
      desired: null,
      observed: u,
      reason: 'an object carrying Stationly labels that no desired key accounts for',
    })
  }
  if (
    !acked ||
    observed.applied.number !== acked.generation ||
    now - acked.updated_at.getTime() < settleMs
  )
    return out
  const doc = acked.document
  for (const [id, env] of Object.entries(doc.environments)) {
    const o = observed.environments[id]
    if (o && o.applied_hash !== env.hash)
      out.push({
        key: `environments/${id}`,
        desired: env.hash,
        observed: o.applied_hash,
        reason: 'applied_hash differs from the desired hash',
      })
  }
  for (const [id, box] of Object.entries(doc.sandboxes ?? {})) {
    const o = observed.sandboxes?.[id]
    if (o && o.applied_hash !== null && o.applied_hash !== box.hash)
      out.push({
        key: `sandboxes/${id}`,
        desired: box.hash,
        observed: o.applied_hash,
        reason: 'applied_hash differs from the desired hash',
      })
  }
  for (const [id, svc] of Object.entries(doc.services)) {
    const o = observed.services[id]
    if (!o) continue
    if (o.applied_hash !== null && o.applied_hash !== svc.hash)
      out.push({
        key: `services/${id}`,
        desired: svc.hash,
        observed: o.applied_hash,
        reason: 'applied_hash differs from the desired hash',
      })
    const longRunning = svc.kind === 'web' || svc.kind === 'worker'
    if (
      longRunning &&
      svc.desired_state === 'running' &&
      svc.current &&
      !o.containers.some((c) => c.state === 'running') &&
      !Object.values(doc.deployments).some((d) => d.service_id === id)
    )
      out.push({
        key: `services/${id}/containers`,
        desired: 'running',
        observed: o.containers.map((c) => c.state),
        reason: 'a desired-running service has no running container set',
      })
  }
  return out
}

export const evaluateDrift = (db: Db, stationId: string, observed: Observed, now = Date.now()) => {
  const found = findings(db, stationId, observed, now)
  const open = db
    .select()
    .from(drift)
    .where(and(eq(drift.station_id, stationId), eq(drift.status, 'open')))
    .all()
    .filter((d) => d.object !== 'generation')
  const openKeys = new Map(open.map((d) => [d.object, d]))
  const foundKeys = new Set(found.map((f) => f.key))
  const opened: string[] = []
  for (const f of found) {
    if (openKeys.has(f.key)) continue
    const row = db
      .insert(drift)
      .values({
        station_id: stationId,
        object: f.key,
        observed: f.observed,
        desired: f.desired,
      })
      .returning({
        id: drift.id,
      })
      .get()
    emitEvent(
      db,
      'station.drift',
      {
        entity: 'station',
        id: stationId,
      },
      {
        drift_id: row.id,
        entities: [f.key],
        desired: f.desired,
        observed: f.observed,
        reason: f.reason,
      },
    )
    opened.push(f.key)
  }
  const resolved: string[] = []
  for (const d of open) {
    if (foundKeys.has(d.object)) continue
    db.update(drift)
      .set({
        status: 'resolved',
      })
      .where(eq(drift.id, d.id))
      .run()
    resolved.push(d.object)
  }
  return {
    opened,
    resolved,
    desired: latestGeneration(db, stationId)?.generation ?? 0,
  }
}
