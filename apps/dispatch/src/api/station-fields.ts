import { eq } from 'drizzle-orm'

import type { Db } from '../db/client.ts'
import { server } from '../db/schema.ts'
import { runtimeRefusal } from '../sandboxes/runtime.ts'

import { refreshServerApps } from './app-status.ts'
import { fail } from './errors.ts'

export const stationFields = [
  'public_address',
  'concurrency_cap',
  'draining',
  'intermittent',
  'machine_limits',
  'default_machine_runtime',
] as const

export type StationField = (typeof stationFields)[number]

type StationRow = typeof server.$inferSelect

export const drainRefusal = (row: Pick<StationRow, 'name' | 'status'>) =>
  row.status === 'enrolling'
    ? `server ${row.name} has not enrolled yet; only an enrolled server can be drained`
    : null

const refuse = (path: string, message: string) =>
  fail('VALIDATION_FAILED', message, undefined, {
    issues: [
      {
        path,
        message,
      },
    ],
  })

export const applyStationField = (db: Db, id: string, field: StationField, after: unknown) => {
  const row = db.select().from(server).where(eq(server.id, id)).get()

  if (!row) {
    return fail('NOT_FOUND', `server ${id} does not exist.`)
  }

  switch (field) {
    case 'draining': {
      const refusal = after === true ? drainRefusal(row) : null

      if (refusal) {
        refuse('/draining', refusal)
      }

      db.update(server)
        .set({
          draining: after as boolean,
        })
        .where(eq(server.id, id))
        .run()

      return
    }

    case 'intermittent':
      db.update(server)
        .set({
          intermittent: after as boolean,
          ...(after === false && row.status === 'asleep'
            ? {
                status: 'offline' as const,
              }
            : {}),
        })
        .where(eq(server.id, id))
        .run()

      if (after === false && row.status === 'asleep') {
        refreshServerApps(db, id)
      }

      return
    case 'concurrency_cap':
      db.update(server)
        .set({
          concurrency_cap: after as number,
        })
        .where(eq(server.id, id))
        .run()

      return
    case 'public_address':
      db.update(server)
        .set({
          public_address: after as string,
        })
        .where(eq(server.id, id))
        .run()

      return
    case 'machine_limits':
      db.update(server)
        .set({
          machine_limits: after as StationRow['machine_limits'],
        })
        .where(eq(server.id, id))
        .run()

      return

    case 'default_machine_runtime': {
      const runtime = after as StationRow['default_machine_runtime']
      const refusal = runtimeRefusal(row, runtime)

      if (refusal) {
        refuse('/default_machine_runtime', refusal)
      }

      db.update(server)
        .set({
          default_machine_runtime: runtime,
        })
        .where(eq(server.id, id))
        .run()
    }
  }
}
