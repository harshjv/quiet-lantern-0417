import { eq } from 'drizzle-orm'

import type { Db } from '../db/client.ts'
import { station } from '../db/schema.ts'

import { fail } from './errors.ts'

export const stationFields = [
  'public_address',
  'concurrency_cap',
  'draining',
  'intermittent',
  'sandbox_limits',
] as const

export type StationField = (typeof stationFields)[number]

type StationRow = typeof station.$inferSelect

export const drainRefusal = (row: Pick<StationRow, 'name' | 'status'>) =>
  row.status === 'enrolling'
    ? `station ${row.name} has not enrolled yet; only an enrolled station can be drained`
    : null

export const applyStationField = (db: Db, id: string, field: StationField, after: unknown) => {
  const row = db.select().from(station).where(eq(station.id, id)).get()
  if (!row) return fail('NOT_FOUND', `station ${id} does not exist.`)
  switch (field) {
    case 'draining': {
      const refusal = after === true ? drainRefusal(row) : null
      if (refusal)
        fail('VALIDATION_FAILED', refusal, undefined, {
          issues: [
            {
              path: '/draining',
              message: refusal,
            },
          ],
        })
      db.update(station)
        .set({
          draining: after as boolean,
        })
        .where(eq(station.id, id))
        .run()
      return
    }
    case 'intermittent':
      db.update(station)
        .set({
          intermittent: after as boolean,
          ...(after === false && row.status === 'asleep'
            ? {
                status: 'offline' as const,
              }
            : {}),
        })
        .where(eq(station.id, id))
        .run()
      return
    case 'concurrency_cap':
      db.update(station)
        .set({
          concurrency_cap: after as number,
        })
        .where(eq(station.id, id))
        .run()
      return
    case 'public_address':
      db.update(station)
        .set({
          public_address: after as string,
        })
        .where(eq(station.id, id))
        .run()
      return
    case 'sandbox_limits':
      db.update(station)
        .set({
          sandbox_limits: after as StationRow['sandbox_limits'],
        })
        .where(eq(station.id, id))
        .run()
  }
}
