import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'

import type { AgentEventInputValue } from '@stationly/protocol'

import { relay, relayLimits, type PostResult, type RelayDeps } from '../src/agent-relay.ts'

let dir: string
let clock: number
let sleeps: number[]
let posts: { at: number; events: AgentEventInputValue[] }[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spool-'))
  clock = 1_000_000
  sleeps = []
  posts = []
})

afterEach(() => {
  rmSync(dir, {
    recursive: true,
    force: true,
  })
})

const spool = (n: number, payload: Record<string, unknown> = stop) => {
  const name = `${String(1731412345000000000n + BigInt(n)).padStart(19, '0')}-1.json`

  writeFileSync(
    join(dir, name),
    JSON.stringify({
      session_id: 'sess_1',
      ...payload,
    }),
  )

  return name
}

const stop = {
  hook_event_name: 'Stop',
}

const remaining = () => readdirSync(dir).filter((name) => name.endsWith('.json'))

const run = (answers: (PostResult | Error)[] = []) => {
  const deps: RelayDeps = {
    dir,
    version: () => Promise.resolve('2.1.322'),
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms)
      clock += ms

      return Promise.resolve()
    },
    post: (events) => {
      posts.push({
        at: clock,
        events,
      })

      const answer = answers.shift() ?? {
        status: 202,
      }

      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
    },
  }

  return relay(deps)
}

test('events post oldest first, files go after a 2xx, and an idle spool ends the relay', async () => {
  spool(2, {
    hook_event_name: 'SessionEnd',
    reason: 'logout',
  })
  spool(1, {
    hook_event_name: 'SessionStart',
    source: 'startup',
  })

  await run()

  assert.equal(posts.length, 1)
  assert.deepEqual(
    posts[0]!.events.map((event) => event.type),
    ['session.started', 'session.ended'],
  )
  assert.equal((posts[0]!.events[0]!.data as { version?: string }).version, '2.1.322')
  assert.deepEqual(remaining(), [])
  assert.ok(clock - 1_000_000 >= relayLimits.idleExitMs)
})

test('a batch holds at most 100 events and posts are a second apart', async () => {
  for (let n = 0; n < 250; n += 1) {
    spool(n)
  }

  await run()

  assert.deepEqual(
    posts.map((post) => post.events.length),
    [100, 100, 50],
  )
  assert.ok(posts[1]!.at - posts[0]!.at >= relayLimits.postIntervalMs)
  assert.ok(posts[2]!.at - posts[1]!.at >= relayLimits.postIntervalMs)
})

test('files that map to no event are deleted without a post', async () => {
  spool(1, {
    hook_event_name: 'PreCompact',
  })
  writeFileSync(join(dir, '1731412345000000099-1.json'), 'not json')

  await run()

  assert.equal(posts.length, 0)
  assert.deepEqual(remaining(), [])
})

test('a failure retries the same batch with a doubling delay that stops at 30 seconds', async () => {
  const name = spool(1)
  const failures = Array.from(
    {
      length: 7,
    },
    () => ({
      status: 503,
    }),
  )

  await run([...failures, new Error('connection refused')])

  assert.equal(posts.length, 9)
  assert.ok(posts.every((post) => post.events[0]!.id === name.replace('.json', '')))
  assert.deepEqual(
    sleeps.filter((ms) => ms > 0 && ms !== relayLimits.pollMs),
    [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000],
  )
  assert.deepEqual(remaining(), [])
})

test('a 429 waits for Retry-After when it is longer than the backoff', async () => {
  spool(1)

  await run([
    {
      status: 429,
      retryAfterS: 20,
    },
  ])

  assert.equal(posts.length, 2)
  assert.ok(posts[1]!.at - posts[0]!.at >= 20000)
})

test('any other 4xx is final: the batch is deleted and the relay ends', async () => {
  spool(1)
  spool(2)

  await run([
    {
      status: 404,
    },
  ])

  assert.equal(posts.length, 1)
  assert.equal(posts[0]!.events.length, 2)
  assert.deepEqual(remaining(), [])
})

test('a 400 that names a bad event drops only that event and retries the rest once', async () => {
  spool(1, {
    hook_event_name: 'SessionEnd',
    reason: 'a',
  })
  spool(2, {
    hook_event_name: 'SessionEnd',
    reason: 'bad',
  })
  spool(3, {
    hook_event_name: 'SessionEnd',
    reason: 'c',
  })

  await run([
    {
      status: 400,
      badIndexes: [1],
    },
  ])

  assert.equal(posts.length, 2)
  assert.deepEqual(
    posts[1]!.events.map((event) => (event.data as { reason: string }).reason),
    ['a', 'c'],
  )
  assert.deepEqual(remaining(), [])
})

test('a second 400 after the retry is final', async () => {
  spool(1)
  spool(2)
  spool(3)
  spool(4)

  await run([
    {
      status: 400,
      badIndexes: [0],
    },
    {
      status: 400,
      badIndexes: [0],
    },
  ])

  assert.equal(posts.length, 2)
  assert.deepEqual(remaining(), [])
})

test('a final 4xx leaves files past the batch for the next relay', async () => {
  for (let n = 0; n < 101; n += 1) {
    spool(n)
  }

  await run([
    {
      status: 403,
    },
  ])

  assert.equal(posts.length, 1)
  assert.equal(remaining().length, 1)
})

test('past 64 MiB the oldest files are dropped and an omitted event reports the count', async () => {
  const pad = 'x'.repeat(33 * 1024 * 1024)

  spool(1, {
    hook_event_name: 'Stop',
    pad,
  })
  spool(2, {
    hook_event_name: 'Stop',
    pad,
  })

  await run()

  assert.equal(posts.length, 1)
  assert.deepEqual(
    posts[0]!.events.map((event) => event.type),
    ['omitted', 'turn.ended'],
  )
  assert.deepEqual(posts[0]!.events[0]!.data, {
    count: 1,
  })
  assert.deepEqual(remaining(), [])
})

test('temporary and lock files are never read', async () => {
  mkdirSync(join(dir, 'sub'))
  writeFileSync(join(dir, '.lock'), '')
  writeFileSync(join(dir, '.1731412345000000000-1'), '{}')

  await run()

  assert.equal(posts.length, 0)
})

test('the size check counts bytes, so a non-ASCII event over the raw cap is dropped before it can fail the batch', async () => {
  const wide = '€'.repeat(11_000)

  spool(1, {
    hook_event_name: 'SessionStart',
    source: wide,
    model: wide,
    cwd: wide,
    prompt_id: wide,
    turn_id: wide,
    agent_id: wide,
  })
  spool(2)

  await run()

  assert.deepEqual(
    posts.flatMap((post) => post.events.map((event) => event.type)),
    ['turn.ended'],
  )
  assert.deepEqual(remaining(), [])
})
