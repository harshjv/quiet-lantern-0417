import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, describe, test } from 'node:test'

import { version } from '../src/env.ts'
import { Exit, exitCodes, unreachable } from '../src/errors.ts'
import { connectWith, found, tokenCredentials, type Run } from '../src/kit.ts'
import { showLine, streamLogs } from '../src/logs.ts'
import { pollUntil } from '../src/outage.ts'
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

  test('rides out a connection failure and rethrows any other error', async () => {
    let reads = 0
    const value = await pollUntil(
      () =>
        ++reads === 1
          ? Promise.reject(unreachable('http://127.0.0.1:1', new Error('refused')))
          : Promise.resolve(reads),
      () => true,
    )
    assert.equal(value, 2)
    await assert.rejects(
      pollUntil(
        () => Promise.reject(new Error('boom')),
        () => true,
      ),
      /boom/,
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
