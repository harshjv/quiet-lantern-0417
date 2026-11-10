import { sseHeaders, stream, type Api, type Globals, type Run } from './kit.ts'
import { lineText, type LogLine } from './renderers/observability.ts'
import { followSse, streamed } from './sse.ts'

export type LogQuery = NonNullable<NonNullable<Parameters<Api['logs']['get']>[0]>['query']>

export const showLine = (
  globals: Globals,
  line: LogLine,
  sink: NodeJS.WriteStream = process.stdout,
) => sink.write(`${globals.json ? JSON.stringify(line) : lineText(line)}\n`)

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
    streamed('log stream', (event) => {
      if (event.event === 'log') showLine(globals, JSON.parse(event.data) as LogLine, sink)
    }),
  )
