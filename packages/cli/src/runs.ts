import { runTerminalStatuses } from '@stationly/protocol'

import { exitCodes } from './errors.ts'
import { send, type Api, type Data, type Globals, type Run } from './kit.ts'
import { pollUntil } from './outage.ts'
import { json, progress } from './output.ts'

export type RunRow = Data<ReturnType<Api['runs']>['get']>

const terminalRun = new Set<string>(runTerminalStatuses)

export const waitRun = (run: Run, id: string) =>
  pollUntil(
    async () =>
      (
        await send(
          run.api.v1
            .runs({
              id,
            })
            .get({
              query: {
                wait_s: 10,
                fields: 'failure',
              },
            }),
        )
      ).data,
    (row) => terminalRun.has(row.status),
  )

export const reportRun = (globals: Globals, row: RunRow) => {
  progress(`${row.id}: ${row.status}, exit code ${row.exit_code ?? '-'}`)
  if (globals.json) json(row)
  if (row.status === 'succeeded') return exitCodes.ok
  process.stderr.write(`${row.failure?.code ?? 'EXIT_NONZERO'}\n`)
  return exitCodes.api
}
