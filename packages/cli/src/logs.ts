import { exitCodes } from './errors.ts'
import { sseHeaders, stream, type Api, type Data, type Globals, type Run } from './kit.ts'
import { progress } from './output.ts'
import { followSse, streamFailure } from './sse.ts'

export type LogQuery = NonNullable<NonNullable<Parameters<Api['logs']['get']>[0]>['query']>

type LogLine = Data<Api['logs']['get']>['untrusted']['lines'][number]

export const showLine = (
  globals: Globals,
  line: LogLine,
  sink: NodeJS.WriteStream = process.stdout,
) =>
  sink.write(
    globals.json
      ? `${JSON.stringify(line)}\n`
      : `${line.at} ${line.stream === 'stderr' ? 'E' : ' '} ${line.role && line.role !== 'service' ? `[${line.role}] ` : ''}${line.text}\n`,
  )

export const streamLogs = (
  run: Run,
  globals: Globals,
  query: LogQuery,
  sink: NodeJS.WriteStream = process.stdout,
) =>
  followSse(
    (lastId) =>
      stream(
        run.api.v1.logs.get({
          query: {
            ...query,
            follow: true,
          },
          headers: sseHeaders(lastId),
        }),
      ),
    (event) => {
      if (event.event === 'log') showLine(globals, JSON.parse(event.data) as LogLine, sink)
      else if (event.event === 'end') {
        progress(`log stream ended: ${(JSON.parse(event.data) as { reason: string }).reason}`)
        return exitCodes.ok
      } else if (event.event === 'error') throw streamFailure(event.data)
      return undefined
    },
  )
