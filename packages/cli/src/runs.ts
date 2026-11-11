import { exitCodes } from './errors.ts'
import { pollUntil, send, type Api, type Data, type Globals, type Run } from './kit.ts'
import { json, progress } from './output.ts'
import { runEnded } from './renderers/deployments.ts'

export type RunRow = Data<ReturnType<Api['runs']>['get']>

const deadlineMarginMs = 30_000

export const runWaitDeadline = (row: { deadline_at?: string | null }) =>
  row.deadline_at ? Date.parse(row.deadline_at) + deadlineMarginMs : undefined

const readRun = async (client: ReturnType<Run['waiting']>, id: string) =>
  (
    await send(
      client.api.v1
        .runs({
          id,
        })
        .get({
          query: {
            wait_s: 10,
            fields: 'failure,deadline_at',
          },
        }),
    )
  ).data

export const waitRun = async (run: Run, id: string) => {
  const first = await readRun(run.waiting(), id)

  if (runEnded(first.status)) {
    return first
  }

  const client = run.waiting(runWaitDeadline(first))

  return pollUntil(
    () => readRun(client, id),
    (row) => runEnded(row.status),
  )
}

export const reportRun = (globals: Globals, row: RunRow) => {
  progress(`${row.id}: ${row.status}, exit code ${row.exit_code ?? '-'}`)

  if (globals.json) {
    json(row)
  }

  if (row.status === 'succeeded') {
    return exitCodes.ok
  }

  process.stderr.write(`${row.failure?.code ?? 'EXIT_NONZERO'}\n`)

  return exitCodes.api
}
