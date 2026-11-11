import { eq } from 'drizzle-orm'

import { requireLink } from '../api/deployments.ts'
import { fail, invalid } from '../api/errors.ts'
import type { Db } from '../db/client.ts'
import { station } from '../db/schema.ts'
import type { StationServer } from '../station/server.ts'

type StationRow = typeof station.$inferSelect

export type StorageDeps = { db: Db; stations: Pick<StationServer, 'ask' | 'isConnected'> }

export const requireGrowable = (st: StationRow, sizeBytes: number) => {
  const sandboxes = st.capabilities?.sandboxes

  if (!sandboxes) {
    fail(
      'STATION_CAPABILITY_MISSING',
      `Station ${st.name} reports no sandbox capability.`,
      'Install sandbox support on the station, then retry.',
      {
        missing: 'sandboxes',
        station_id: st.id,
      },
    )
  }

  if (sizeBytes <= sandboxes!.filesystem_bytes) {
    invalid([
      {
        path: '/size_bytes',
        message: `must exceed the current ${sandboxes!.filesystem_bytes} bytes`,
      },
    ])
  }

  if (sizeBytes > sandboxes!.filesystem_max_bytes) {
    invalid([
      {
        path: '/size_bytes',
        message: `exceeds the ${sandboxes!.filesystem_max_bytes} bytes the filesystem can grow to now`,
      },
    ])
  }

  return sandboxes!
}

export const growStorage = async (
  deps: StorageDeps,
  stationId: string,
  sizeBytes: number,
  onStationError: (error: unknown) => never,
) => {
  const { db, stations } = deps
  const st = db.select().from(station).where(eq(station.id, stationId)).get()!
  const sandboxes = requireGrowable(st, sizeBytes)

  requireLink(stations, st.id)
  const reply = await stations
    .ask(
      st.id,
      'sandbox.storage.grow',
      {
        size_bytes: sizeBytes,
      },
      {
        timeoutMs: 120_000,
      },
    )
    .catch(onStationError)
  const grown = reply.body

  if (grown.status === 'failed') {
    if (grown.step === null) {
      invalid([
        {
          path: '/size_bytes',
          message: grown.error ?? 'the station refused the size',
        },
      ])
    }

    fail(
      'SANDBOX_STORAGE_GROW_FAILED',
      `Growing the sandbox filesystem failed at ${grown.step}: ${grown.error ?? 'no detail'}.`,
      'Read the step and error, fix the host, then grow again; the filesystem is as it was or larger.',
      {
        step: grown.step,
        error: grown.error,
      },
    )
  }

  db.update(station)
    .set({
      capabilities: {
        ...st.capabilities!,
        sandboxes: {
          ...sandboxes,
          filesystem_bytes: grown.filesystem_bytes,
          filesystem_free_bytes: grown.filesystem_free_bytes,
        },
      },
    })
    .where(eq(station.id, st.id))
    .run()

  return {
    filesystem_bytes: grown.filesystem_bytes,
    filesystem_free_bytes: grown.filesystem_free_bytes,
    before: sandboxes.filesystem_bytes,
  }
}
