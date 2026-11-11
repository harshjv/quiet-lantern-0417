import { adviseSandboxRuntime, type sandboxRuntimeValues } from '@stationly/protocol'

import { fail } from '../api/errors.ts'
import type { station } from '../db/schema.ts'

type StationRow = typeof station.$inferSelect

type SandboxRuntimeValue = (typeof sandboxRuntimeValues)[number]

export const offeredRuntimes = (st: Pick<StationRow, 'capabilities'>) =>
  st.capabilities?.sandboxes?.runtimes ?? []

export const sandboxRuntimeAdvice = (st: Pick<StationRow, 'capabilities'>) => {
  const host = st.capabilities?.host

  return host ? adviseSandboxRuntime(host, offeredRuntimes(st)) : null
}

const isOffered = (
  st: Pick<StationRow, 'capabilities'>,
  runtime: string,
): runtime is SandboxRuntimeValue => (offeredRuntimes(st) as string[]).includes(runtime)

export const runtimeRefusal = (
  row: Pick<StationRow, 'name' | 'capabilities'>,
  runtime: string | null,
) => {
  if (runtime === null || isOffered(row, runtime)) {
    return null
  }

  const offered = offeredRuntimes(row)

  return `station ${row.name} does not offer the sandbox runtime ${runtime}; it offers ${offered.length ? offered.join(', ') : 'none'}`
}

export const defaultRuntime = (st: StationRow) =>
  st.default_sandbox_runtime ?? sandboxRuntimeAdvice(st)?.default ?? offeredRuntimes(st)[0]

export const requireRuntime = (st: StationRow, requested: SandboxRuntimeValue | undefined) => {
  const offered = offeredRuntimes(st)
  const runtime = requested ?? defaultRuntime(st)

  if (runtime !== undefined && offered.includes(runtime)) {
    return runtime
  }

  return fail(
    'SANDBOX_RUNTIME_UNAVAILABLE',
    runtime === undefined
      ? `Station ${st.name} offers no sandbox runtime.`
      : `Station ${st.name} does not offer the sandbox runtime ${runtime}; it offers ${offered.length ? offered.join(', ') : 'none'}.`,
    offered.length
      ? `Create the sandbox with runtime ${offered[0]}, or on a station that offers ${runtime}.`
      : `Upgrade stationd on ${st.name} with sly platform upgrade so it reports its sandbox runtimes, then retry.`,
    {
      station: st.id,
      runtime: runtime ?? null,
      offered,
    },
  )
}
