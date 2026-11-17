import { eq } from 'drizzle-orm'

import { requireLink } from '../api/deployments.ts'
import { fail, invalid } from '../api/errors.ts'
import type { Db } from '../db/client.ts'
import { server } from '../db/schema.ts'
import type { StationServer } from '../station/server.ts'

type StationRow = typeof server.$inferSelect

export type StorageDeps = { db: Db; stations: Pick<StationServer, 'ask' | 'isConnected'> }

export const requireGrowable = (st: StationRow, sizeBytes: number) => {
  const machines = st.capabilities?.sandboxes

  if (!machines) {
    fail(
      'SERVER_CAPABILITY_MISSING',
      `Server ${st.name} reports no machine capability.`,
      'Install machine support on the server, then retry.',
      {
        missing: 'machines',
        server_id: st.id,
      },
    )
  }

  if (sizeBytes <= machines!.filesystem_bytes) {
    invalid([
      {
        path: '/size_bytes',
        message: `must exceed the current ${machines!.filesystem_bytes} bytes`,
      },
    ])
  }

  if (sizeBytes > machines!.filesystem_max_bytes) {
    invalid([
      {
        path: '/size_bytes',
        message: `exceeds the ${machines!.filesystem_max_bytes} bytes the filesystem can grow to now`,
      },
    ])
  }

  return machines!
}

export const growStorage = async (
  deps: StorageDeps,
  stationId: string,
  sizeBytes: number,
  onStationError: (error: unknown) => never,
) => {
  const { db, stations } = deps
  const st = db.select().from(server).where(eq(server.id, stationId)).get()!
  const machines = requireGrowable(st, sizeBytes)

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
          message: grown.error ?? 'the server refused the size',
        },
      ])
    }

    fail(
      'MACHINE_STORAGE_GROW_FAILED',
      `Growing the machine filesystem failed at ${grown.step}: ${grown.error ?? 'no detail'}.`,
      'Read the step and error, fix the host, then grow again; the filesystem is as it was or larger.',
      {
        step: grown.step,
        error: grown.error,
      },
    )
  }

  db.update(server)
    .set({
      capabilities: {
        ...st.capabilities!,
        sandboxes: {
          ...machines,
          filesystem_bytes: grown.filesystem_bytes,
          filesystem_free_bytes: grown.filesystem_free_bytes,
        },
      },
    })
    .where(eq(server.id, st.id))
    .run()

  return {
    filesystem_bytes: grown.filesystem_bytes,
    filesystem_free_bytes: grown.filesystem_free_bytes,
    before: machines.filesystem_bytes,
  }
}
