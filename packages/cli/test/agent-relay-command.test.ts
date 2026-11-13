import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, before, beforeEach, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'

const entry = new URL('../src/index.ts', import.meta.url).pathname

type Seen = {
  url: string
  authorization: string | undefined
  body: { events: { id: string; type: string }[] }
}

let server: Server
let status: number
let statuses: number[]
let bodies: unknown[]
let seen: Seen[]
let home: string
let child: ChildProcess | null

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let text = ''

    req.on('data', (chunk: Buffer) => {
      text += chunk.toString()
    })
    req.on('end', () => resolve(text))
  })

before(async () => {
  server = createServer((req, res) => {
    void readBody(req).then((text) => {
      seen.push({
        url: req.url ?? '',
        authorization: req.headers.authorization,
        body: JSON.parse(text) as Seen['body'],
      })

      const answer = statuses.shift() ?? status

      res
        .writeHead(answer, {
          'content-type': 'application/json',
          ...(answer === 429
            ? {
                'retry-after': '1',
              }
            : {}),
        })
        .end(
          JSON.stringify(
            bodies.shift() ?? {
              accepted: 1,
              duplicates: 0,
            },
          ),
        )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
})

after(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  status = 202
  statuses = []
  bodies = []
  seen = []
  child = null
  home = mkdtempSync(join(tmpdir(), 'sly-relay-'))
})

afterEach(() => {
  child?.kill()
  rmSync(home, {
    recursive: true,
    force: true,
  })
})

const spoolDir = () => join(home, '.local', 'state', 'stationly', 'spool')

const spool = (name: string, payload: Record<string, unknown>) => {
  mkdirSync(spoolDir(), {
    recursive: true,
  })
  writeFileSync(join(spoolDir(), name), JSON.stringify(payload))
}

const env = (sandbox: string | null) => ({
  PATH: process.env.PATH,
  HOME: home,
  XDG_CONFIG_HOME: join(home, 'config'),
  STATIONLY_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  STATIONLY_TOKEN: 'tok_workspace',
  ...(sandbox
    ? {
        STATIONLY_SANDBOX_ID: sandbox,
      }
    : {}),
})

const until = async (condition: () => boolean) => {
  for (let waited = 0; waited < 20000 && !condition(); waited += 50) {
    await sleep(50)
  }
}

test('the relay posts the spooled events to the sandbox with the workspace token and deletes the file', async () => {
  const name = '1731412345000000001-7.json'

  spool(name, {
    session_id: 'sess_1',
    hook_event_name: 'UserPromptSubmit',
    prompt: 'fix the build',
  })
  child = spawn(process.execPath, [entry, 'agent', 'relay'], {
    env: env('sbx_01'),
  })
  await until(() => seen.length > 0 && !existsSync(join(spoolDir(), name)))

  assert.equal(seen.length, 1)
  assert.equal(seen[0]!.url, '/v1/sandboxes/sbx_01/agent/events')
  assert.equal(seen[0]!.authorization, 'Bearer tok_workspace')
  assert.deepEqual(
    seen[0]!.body.events.map((event) => [event.id, event.type]),
    [['1731412345000000001-7', 'prompt']],
  )
  assert.equal(existsSync(join(spoolDir(), name)), false)
})

test('a refusal other than 429 is final: the relay deletes the batch and exits', async () => {
  const name = '1731412345000000001-7.json'

  status = 404
  spool(name, {
    session_id: 'sess_1',
    hook_event_name: 'Stop',
  })
  child = spawn(process.execPath, [entry, 'agent', 'relay'], {
    env: env('sbx_01'),
  })

  const code = await new Promise<number | null>((resolve) => child!.on('exit', resolve))

  assert.equal(code, 0)
  assert.equal(seen.length, 1)
  assert.equal(existsSync(join(spoolDir(), name)), false)
})

test('the relay needs the sandbox id the runtime sets', () => {
  const result = spawnSync(process.execPath, [entry, 'agent', 'relay'], {
    env: env(null),
    encoding: 'utf8',
  })

  assert.equal(result.status, 2)
  assert.match(result.stderr, /STATIONLY_SANDBOX_ID/)
  assert.equal(seen.length, 0)
})

test('a 429 is retried with its Retry-After and the same events', async () => {
  const name = '1731412345000000001-7.json'

  statuses = [429]
  spool(name, {
    session_id: 'sess_1',
    hook_event_name: 'Stop',
  })
  child = spawn(process.execPath, [entry, 'agent', 'relay'], {
    env: env('sbx_01'),
  })
  await until(() => seen.length > 1 && !existsSync(join(spoolDir(), name)))

  assert.equal(seen.length, 2)
  assert.deepEqual(seen[0]!.body, seen[1]!.body)
  assert.equal(existsSync(join(spoolDir(), name)), false)
})

test('a 400 that names an event drops that spool file and posts the rest', async () => {
  const bad = '1731412345000000001-7.json'
  const good = '1731412345000000002-7.json'

  statuses = [400]
  bodies = [
    {
      error: {
        code: 'VALIDATION_FAILED',
        explanation: '/events/0/data: bad',
        fix: '',
        details: {
          issues: [
            {
              path: '/events/0/data',
              message: 'bad',
            },
          ],
        },
        request_id: 'req_1',
      },
    },
  ]
  spool(bad, {
    session_id: 'sess_1',
    hook_event_name: 'UserPromptSubmit',
    prompt: 'one',
  })
  spool(good, {
    session_id: 'sess_1',
    hook_event_name: 'UserPromptSubmit',
    prompt: 'two',
  })
  child = spawn(process.execPath, [entry, 'agent', 'relay'], {
    env: env('sbx_01'),
  })
  await until(() => seen.length > 1 && !existsSync(join(spoolDir(), good)))

  assert.equal(seen.length, 2)
  assert.equal(seen[0]!.body.events.length, 2)
  assert.deepEqual(
    seen[1]!.body.events.map((event) => event.id),
    ['1731412345000000002-7'],
  )
  assert.equal(existsSync(join(spoolDir(), bad)), false)
})
