import { and, desc, eq } from 'drizzle-orm'

import type { MessageBody } from '@stationly/protocol'

import type { Db } from '../db/client.ts'
import { deployment, drift, service, station, station_generation } from '../db/schema.ts'
import {
  buildContent,
  contentDigest,
  contentOf,
  GenerationError,
  keyOf,
  objectAt,
  seal,
  type Built,
  type Exclusion,
  type GenerationContent,
  type Skip,
} from '../generation/build.ts'

import { emitEvent, serviceSubject } from './events.ts'
import { deploymentSubject, failedPayload } from './outbox.ts'

type GenerationRow = typeof station_generation.$inferSelect

export const latestGeneration = (db: Db, stationId: string) =>
  db
    .select()
    .from(station_generation)
    .where(eq(station_generation.station_id, stationId))
    .orderBy(desc(station_generation.generation))
    .limit(1)
    .get()

export const generationNumbered = (db: Db, stationId: string, number: number) =>
  db
    .select()
    .from(station_generation)
    .where(
      and(eq(station_generation.station_id, stationId), eq(station_generation.generation, number)),
    )
    .get()

const sealProblem = (content: GenerationContent) => {
  try {
    seal(content, {
      number: 1,
      previous: null,
      issued_at: new Date(),
      resolution: null,
    })
    return null
  } catch (error) {
    if (!(error instanceof GenerationError)) throw error
    return {
      message: error.message,
      path: typeof error.details.path === 'string' ? error.details.path : '',
    }
  }
}

const maxExclusionPasses = 64

export const buildDesired = (db: Db, stationId: string): Built => {
  const skip: Skip = new Map()
  for (let pass = 0; pass < maxExclusionPasses; pass++) {
    const built = buildContent(db, stationId, skip)
    const problem = sealProblem(built.content)
    if (!problem) return built
    const at = objectAt(problem.path)
    if (!at || skip.has(keyOf(at.object, at.id)))
      throw new GenerationError(problem.message, {
        path: problem.path,
      })
    skip.set(keyOf(at.object, at.id), problem.message)
  }
  throw new GenerationError(
    `more than ${maxExclusionPasses} objects of station ${stationId} fail the generation schema`,
  )
}

const imageFix = (serviceId: string) => ({
  code: 'RESOLVE_IMAGE',
  text: 'The image reference is not pinned to a digest. Set the image source again so Dispatch resolves the tag to its digest, then deploy.',
  action: {
    tool: 'update_service',
    input: {
      service: serviceId,
    },
  },
})

const failExcluded = (db: Db, stationId: string, excluded: Exclusion[]) => {
  const failed: string[] = []
  for (const e of excluded) {
    if (e.object !== 'deployment' || e.dispatched) continue
    const dep = db.select().from(deployment).where(eq(deployment.id, e.id)).get()
    if (!dep || dep.finished_at || dep.status !== 'queued') continue
    const svc = db
      .select({
        name: service.name,
      })
      .from(service)
      .where(eq(service.id, dep.service_id))
      .get()
    const failure = {
      entity: {
        type: 'deployment' as const,
        id: dep.id,
      },
      phase: 'preflight' as const,
      code: 'GENERATION_INVALID',
      summary: `Deployment ${dep.number} of ${svc?.name ?? dep.service_id} cannot be sent to station ${stationId}, so Dispatch failed it and sent the station's other changes without it: ${e.explanation}`,
      fixes: [
        e.explanation.includes('/image_ref')
          ? imageFix(dep.service_id)
          : {
              code: 'FIX_CONFIGURATION',
              text: 'Correct the service setting the summary names, then deploy again.',
              action: {
                tool: 'update_service',
                input: {
                  service: dep.service_id,
                },
              },
            },
      ],
    }
    db.transaction((tx) => {
      tx.update(deployment)
        .set({
          status: 'failed',
          failure,
          finished_at: new Date(),
        })
        .where(eq(deployment.id, dep.id))
        .run()
      emitEvent(
        tx,
        'deployment.failed',
        deploymentSubject(tx, dep.id),
        failedPayload(dep.id, dep.number, failure),
      )
    })
    failed.push(dep.id)
  }
  return failed
}

const reported = new Map<string, Map<string, string>>()

const reportExcluded = (db: Db, stationId: string, excluded: Exclusion[]) => {
  const seen = reported.get(stationId) ?? new Map<string, string>()
  const now = new Map<string, string>()
  for (const e of excluded) {
    if (e.object === 'deployment' && !e.dispatched) continue
    now.set(e.key, e.explanation)
    if (seen.get(e.key) === e.explanation) continue
    emitEvent(
      db,
      'doctor.finding',
      e.object === 'service'
        ? {
            ...serviceSubject(db, e.id),
          }
        : {
            entity: 'station',
            id: stationId,
          },
      {
        check: 'generation',
        station: stationId,
        severity: 'fail',
        previous: seen.has(e.key) ? 'fail' : 'ok',
        code: 'GENERATION_INVALID',
        detail: `${e.object} ${e.id} ${e.carried ? 'keeps its last applied version' : 'is left out'} of station ${stationId}'s desired state: ${e.explanation}`,
        fix: e.explanation.includes('/image_ref')
          ? imageFix(e.object === 'service' ? e.id : '').text
          : 'Correct the object the detail names; the station keeps receiving every other change meanwhile.',
      },
    )
  }
  reported.set(stationId, now)
}

export const ensureDesired = (
  db: Db,
  stationId: string,
  floor: number,
): { row: GenerationRow; created: boolean; excluded: Exclusion[]; failed: string[] } => {
  const { content, excluded } = buildDesired(db, stationId)
  const failed = failExcluded(db, stationId, excluded)
  reportExcluded(db, stationId, excluded)
  const latest = latestGeneration(db, stationId)
  if (latest && contentDigest(contentOf(latest.document)) === contentDigest(content))
    return {
      row: latest,
      created: false,
      excluded,
      failed,
    }
  return db.transaction(() => {
    const st = db
      .select({
        generation: station.generation,
      })
      .from(station)
      .where(eq(station.id, stationId))
      .get()!
    const number = Math.max(latest?.generation ?? 0, st.generation, floor) + 1
    const doc = seal(content, {
      number,
      previous: st.generation || null,
      issued_at: new Date(),
      resolution: null,
    })
    const row = db
      .insert(station_generation)
      .values({
        station_id: stationId,
        generation: number,
        document: doc,
        hash: doc.hash,
      })
      .returning()
      .get()
    return {
      row,
      created: true,
      excluded,
      failed,
    }
  })
}

export const recordAck = (db: Db, stationId: string, ack: MessageBody<'generation.ack'>) => {
  const row = generationNumbered(db, stationId, ack.number)
  if (!row || row.hash !== ack.hash)
    return {
      known: false as const,
    }
  db.update(station_generation)
    .set({
      ack: ack.status,
      failure: ack.status === 'rejected' ? (ack.failure ?? null) : null,
    })
    .where(eq(station_generation.id, row.id))
    .run()
  if (ack.status !== 'rejected') {
    const st = db
      .select({
        generation: station.generation,
      })
      .from(station)
      .where(eq(station.id, stationId))
      .get()!
    if (ack.number >= st.generation) {
      db.update(station)
        .set({
          generation: ack.number,
          generation_hash: ack.status === 'applied' ? ack.hash : null,
        })
        .where(eq(station.id, stationId))
        .run()
    }
  }
  return {
    known: true as const,
    row,
  }
}

export type Reconnect =
  { kind: 'fresh' } | { kind: 'known'; row: GenerationRow } | { kind: 'drift'; driftId: string }

export const reconnectRule = (
  db: Db,
  stationId: string,
  applied: MessageBody<'hello'>['applied'],
): Reconnect => {
  if (applied.number === 0)
    return {
      kind: 'fresh',
    }
  const row = generationNumbered(db, stationId, applied.number)
  if (row && row.hash === applied.hash) {
    if (applied.status && applied.status !== 'rejected' && row.ack !== applied.status) {
      recordAck(db, stationId, {
        number: row.generation,
        hash: row.hash,
        status: applied.status,
        results: [],
        duration_ms: 0,
      })
    }
    return {
      kind: 'known',
      row,
    }
  }
  const latest = latestGeneration(db, stationId)
  const open = db
    .select()
    .from(drift)
    .where(
      and(
        eq(drift.station_id, stationId),
        eq(drift.object, 'generation'),
        eq(drift.status, 'open'),
      ),
    )
    .get()
  if (open)
    return {
      kind: 'drift',
      driftId: open.id,
    }
  const desired = latest
    ? {
        number: latest.generation,
        hash: latest.hash,
      }
    : null
  const inserted = db
    .insert(drift)
    .values({
      station_id: stationId,
      object: 'generation',
      observed: applied,
      desired,
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
      drift_id: inserted.id,
      entities: ['generation'],
      desired,
      observed: applied,
      reason: row
        ? 'the station applied a generation whose hash differs from the one Dispatch issued'
        : 'the station reports a generation number Dispatch did not issue',
    },
  )
  return {
    kind: 'drift',
    driftId: inserted.id,
  }
}
