import { adviseMachineRuntime, type machineRuntimeValues } from '@stationly/protocol'

import { fail } from '../api/errors.ts'
import type { server } from '../db/schema.ts'

type StationRow = typeof server.$inferSelect

type MachineRuntimeValue = (typeof machineRuntimeValues)[number]

export const offeredRuntimes = (st: Pick<StationRow, 'capabilities'>) =>
  st.capabilities?.sandboxes?.runtimes ?? []

export const machineRuntimeAdvice = (st: Pick<StationRow, 'capabilities'>) => {
  const host = st.capabilities?.host

  return host ? adviseMachineRuntime(host, offeredRuntimes(st)) : null
}

const isOffered = (
  st: Pick<StationRow, 'capabilities'>,
  runtime: string,
): runtime is MachineRuntimeValue => (offeredRuntimes(st) as string[]).includes(runtime)

export const runtimeRefusal = (
  row: Pick<StationRow, 'name' | 'capabilities'>,
  runtime: string | null,
) => {
  if (runtime === null || isOffered(row, runtime)) {
    return null
  }

  const offered = offeredRuntimes(row)

  return `server ${row.name} does not offer the machine runtime ${runtime}; it offers ${offered.length ? offered.join(', ') : 'none'}`
}

export const defaultRuntime = (st: StationRow) =>
  st.default_machine_runtime ?? machineRuntimeAdvice(st)?.default ?? offeredRuntimes(st)[0]

export const requireRuntime = (st: StationRow, requested: MachineRuntimeValue | undefined) => {
  const offered = offeredRuntimes(st)
  const runtime = requested ?? defaultRuntime(st)

  if (runtime !== undefined && offered.includes(runtime)) {
    return runtime
  }

  return fail(
    'MACHINE_RUNTIME_UNAVAILABLE',
    runtime === undefined
      ? `Server ${st.name} offers no machine runtime.`
      : `Server ${st.name} does not offer the machine runtime ${runtime}; it offers ${offered.length ? offered.join(', ') : 'none'}.`,
    offered.length
      ? `Create the machine with runtime ${offered[0]}, or on a server that offers ${runtime}.`
      : `Upgrade stationd on ${st.name} with sly platform upgrade so it reports its machine runtimes, then retry.`,
    {
      server: st.id,
      runtime: runtime ?? null,
      offered,
    },
  )
}
