import { eq } from 'drizzle-orm'

import { machine, server } from '../db/schema.ts'
import { startMachine } from '../sandboxes/lifecycle.ts'

import { audit, type Call } from './context.ts'
import { requireConnected } from './deployments.ts'
import { fail } from './errors.ts'
import type { Kit } from './kit.ts'

export const wakeMachine = (
  kit: Kit,
  call: Call,
  box: typeof machine.$inferSelect | undefined,
  owner: string,
  refusal: string,
) => {
  if (!box) {
    fail(
      'MACHINE_NOT_RUNNING',
      `The computer of ${owner} is gone, so ${refusal}.`,
      'Start a new task.',
      {
        status: 'deleted',
      },
    )
  }

  if (box!.status === 'stopped') {
    requireConnected(kit.deps, box!.server_id)
    startMachine(
      kit.deps.db,
      kit.deps.db.select().from(server).where(eq(server.id, box!.server_id)).get()!,
      call.principal,
      box!,
      null,
    )
    audit(
      kit.deps.db,
      call,
      'machine.start',
      {
        entity: 'machine',
        id: box!.id,
      },
      {
        before: {
          status: box!.status,
        },
      },
    )
    kit.deps.stations.reconcile(box!.server_id)

    return true
  }

  if (!['creating', 'starting', 'running'].includes(box!.status)) {
    fail(
      'MACHINE_NOT_RUNNING',
      `The computer of ${owner} is ${box!.status}, so ${refusal}.`,
      'Start a new task.',
      {
        status: box!.status,
      },
    )
  }

  return false
}
