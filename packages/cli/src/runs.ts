import { runTerminalStatuses } from '@stationly/protocol'
import type { Options } from './command.ts'
import { exitCodes } from './errors.ts'
import { acrossOutage } from './outage.ts'
import { progress } from './output.ts'

export type RunRow = { id: string; status: string; exit_code: number | null; failure?: { code?: string; summary?: string } | null }

const terminalRun = new Set<string>(runTerminalStatuses)

export const waitRun = async (row: RunRow, read: () => Promise<RunRow>) => {
  let current = row
  while (!terminalRun.has(current.status)) current = await acrossOutage(read)
  return current
}

export const reportRun = (options: Options, row: RunRow) => {
  progress(`${row.id}: ${row.status}, exit code ${row.exit_code ?? '-'}`)
  if (options.json) process.stdout.write(`${JSON.stringify(row, null, 2)}\n`)
  if (row.status === 'succeeded') return exitCodes.ok
  process.stderr.write(`${row.failure?.code ?? 'EXIT_NONZERO'}\n`)
  return exitCodes.api
}
