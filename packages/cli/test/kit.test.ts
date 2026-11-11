import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, test } from 'node:test'

import { version } from '../src/env.ts'
import { Exit, exitCodes } from '../src/errors.ts'
import { createHttp, waitingHttp } from '../src/http.ts'
import { connectWith, found, pollUntil, tokenCredentials, type Run } from '../src/kit.ts'
import { showLine, streamLogs } from '../src/logs.ts'
import { runWaitDeadline } from '../src/runs.ts'
import { attachRun } from '../src/sockets.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => void

let handle: Handler = (_req, res) => res.writeHead(404).end()
const upgrades: IncomingMessage[] = []
const server = createServer((req, res) => handle(req, res))

server.on('upgrade', (req: IncomingMessage, socket) => {
  upgrades.push(req)
  socket.destroy()
})
let run: Run

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  run = connectWith(
    {},
    tokenCredentials(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 'tok_test'),
  )
})

after(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const sink = () => {
  const written: string[] = []

  return {
    written,
    stream: {
      write: (chunk: string) => written.push(chunk) > 0,
    } as unknown as NodeJS.WriteStream,
  }
}

type LogLine = Parameters<typeof showLine>[1]

const line = (text: string, extra: Partial<LogLine> = {}): LogLine => ({
  at: '2026-11-07T00:00:00Z',
  role: 'service',
  stream: 'stdout',
  level: null,
  cursor: 'c0',
  text,
  ...extra,
})

const sse = (res: ServerResponse, events: string[]) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
  })
  res.end(events.join(''))
}

describe('pollUntil', () => {
  test('reads until the value is done and returns that value', async () => {
    let reads = 0
    const value = await pollUntil(
      () => Promise.resolve(++reads),
      (n) => n === 3,
    )

    assert.equal(value, 3)
    assert.equal(reads, 3)
  })

  test('returns the last value read once the deadline has passed', async () => {
    let reads = 0
    const value = await pollUntil(
      () => Promise.resolve(++reads),
      () => false,
      Date.now() - 1,
    )

    assert.equal(value, 1)
  })
})

describe('waiting client', () => {
  test('rides out a dropped connection, where a plain read fails with CONNECTION_FAILED', async () => {
    let requests = 0

    handle = (req, res) => {
      if (++requests % 2 === 1) {
        req.socket.destroy()

        return
      }

      res
        .writeHead(200, {
          'content-type': 'application/json',
        })
        .end('{"ok":true}')
    }

    assert.deepEqual(await run.waiting().http.get('/v1/ping').json(), {
      ok: true,
    })
    assert.equal(requests, 2)
    await assert.rejects(run.http.get('/v1/ping'), (error: unknown) => {
      assert.ok(error instanceof Exit)
      assert.equal(error.code, exitCodes.connection)
      assert.equal(error.envelope?.error.code, 'CONNECTION_FAILED')

      return true
    })
    assert.equal(requests, 3)
  })

  test('a wait rides out an outage longer than the one-shot budget, up to its own deadline', async () => {
    const outageEnds = Date.now() + 1500

    handle = (req, res) => {
      if (Date.now() < outageEnds) {
        req.socket.destroy()

        return
      }

      res
        .writeHead(200, {
          'content-type': 'application/json',
        })
        .end('{"ok":true}')
    }

    const http = createHttp({
      instance: run.credentials.instance,
      userAgent: run.userAgent,
      credentials: run.credentials,
      outageBudgetMs: 500,
    })

    await assert.rejects(http.post('/v1/ping'), (error: unknown) => {
      assert.ok(error instanceof Exit)
      assert.equal(error.envelope?.error.code, 'CONNECTION_FAILED')

      return true
    })
    assert.ok(Date.now() < outageEnds, 'the one-shot request outlasted the outage')
    assert.deepEqual(
      await waitingHttp(http, Date.now() + 10_000)
        .get('/v1/ping')
        .json(),
      {
        ok: true,
      },
    )
  })
})

describe('found', () => {
  const items = [
    {
      name: 'web',
    },
    {
      name: 'worker',
    },
  ]

  test('returns the first item that matches', () => {
    assert.equal(
      found(items, (item) => item.name.startsWith('w'), 'none', 'none'),
      items[0],
    )
  })

  test('throws a NOT_FOUND exit with the explanation and fix when nothing matches', () => {
    assert.throws(
      () => found(items, (item) => item.name === 'db', 'No service db.', 'Run sly services list.'),
      (error: unknown) => {
        assert.ok(error instanceof Exit)
        assert.equal(error.code, exitCodes.api)
        assert.deepEqual(error.envelope, {
          error: {
            code: 'NOT_FOUND',
            explanation: 'No service db.',
            fix: 'Run sly services list.',
          },
        })

        return true
      },
    )
  })
})

describe('showLine', () => {
  test('marks stderr with E and prefixes roles other than service', () => {
    const out = sink()

    showLine({}, line('ready'), out.stream)
    showLine(
      {},
      line('failed', {
        stream: 'stderr',
        role: 'build',
      }),
      out.stream,
    )
    assert.deepEqual(out.written, [
      '2026-11-07T00:00:00Z   ready\n',
      '2026-11-07T00:00:00Z E [build] failed\n',
    ])
  })

  test('writes the line as one JSON object under --json', () => {
    const out = sink()

    showLine(
      {
        json: true,
      },
      line('ready'),
      out.stream,
    )
    assert.deepEqual(out.written, [`${JSON.stringify(line('ready'))}\n`])
  })
})

describe('streamLogs', () => {
  test('follows the stream, resumes after the last id on reconnect and ends with exit 0', async () => {
    const seen: IncomingMessage[] = []

    handle = (req, res) => {
      seen.push(req)
      sse(
        res,
        seen.length === 1
          ? [`id: c1\nevent: log\ndata: ${JSON.stringify(line('one'))}\n\n`]
          : [
              `id: c2\nevent: log\ndata: ${JSON.stringify(line('two'))}\n\n`,
              'event: end\ndata: {"reason":"run_finished"}\n\n',
            ],
      )
    }

    const out = sink()
    const code = await streamLogs(
      run,
      {},
      {
        service: 'svc_TEST',
      },
      out.stream,
    )

    assert.equal(code, exitCodes.ok)
    assert.deepEqual(out.written, ['2026-11-07T00:00:00Z   one\n', '2026-11-07T00:00:00Z   two\n'])
    assert.equal(seen.length, 2)
    const query = new URL(seen[0]!.url!, 'http://x').searchParams

    assert.equal(query.get('follow'), 'true')
    assert.equal(query.get('service'), 'svc_TEST')
    assert.equal(seen[0]!.headers['last-event-id'], undefined)
    assert.equal(seen[1]!.headers['last-event-id'], 'c1')
  })

  test('turns an error event into an exit carrying its code and explanation', async () => {
    handle = (_req, res) =>
      sse(res, [
        'event: error\ndata: {"code":"STATION_OFFLINE","explanation":"station-1 is offline."}\n\n',
      ])
    await assert.rejects(streamLogs(run, {}, {}, sink().stream), (error: unknown) => {
      assert.ok(error instanceof Exit)
      assert.equal(error.code, exitCodes.api)
      assert.equal(error.envelope?.error.code, 'STATION_OFFLINE')
      assert.equal(error.envelope?.error.explanation, 'station-1 is offline.')

      return true
    })
  })
})

describe('attach', () => {
  test('opens the socket with the bearer token and the sly user agent', async () => {
    upgrades.length = 0
    const exit = await attachRun(
      run,
      {
        attach_url: '/v1/runs/run_TEST/attach',
      },
      {
        tty: false,
        stdin: false,
        json: false,
      },
    )

    assert.equal(exit, null)
    assert.equal(upgrades.length, 1)
    assert.match(upgrades[0]!.url!, /^\/v1\/runs\/run_TEST\/attach\?/)
    assert.equal(upgrades[0]!.headers.authorization, 'Bearer tok_test')
    assert.equal(upgrades[0]!.headers['user-agent'], `sly/${version}`)
  })
})

describe('run wait deadline', () => {
  test('a run with a deadline is waited on until 30 s after it', () => {
    assert.equal(
      runWaitDeadline({
        deadline_at: '2026-11-10T12:00:00.000Z',
      }),
      Date.parse('2026-11-10T12:00:30.000Z'),
    )
  })

  test('a run without a deadline keeps the one-shot outage budget', () => {
    assert.equal(
      runWaitDeadline({
        deadline_at: null,
      }),
      undefined,
    )
  })
})
