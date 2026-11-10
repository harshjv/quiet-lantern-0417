import assert from 'node:assert/strict'
import { test } from 'node:test'

import { span } from '../src/lib/format.ts'
import {
  allowlistText,
  attachUrl,
  outputFrame,
  parseAllowlist,
  parseDuration,
  remaining,
  stdinFrame,
  ttlProblem,
} from '../src/lib/sandbox.ts'

test('durations parse in single and combined units', () => {
  assert.equal(parseDuration('90'), 90)
  assert.equal(parseDuration('15m'), 900)
  assert.equal(parseDuration('4h'), 14_400)
  assert.equal(parseDuration('1h 30m'), 5400)
  assert.equal(parseDuration('2d'), 172_800)
  assert.equal(parseDuration('soon'), null)
  assert.equal(parseDuration(''), null)
})

test('ttl limits follow the API range', () => {
  assert.equal(ttlProblem(30)?.includes('at least'), true)
  assert.equal(ttlProblem(3_000_000)?.includes('at most'), true)
  assert.equal(ttlProblem(3600), null)
  assert.notEqual(ttlProblem(null), null)
})

test('spans format with the two largest units', () => {
  assert.equal(span(45), '45 s')
  assert.equal(span(125), '2 min 5 s')
  assert.equal(span(4500), '1 h 15 min')
  assert.equal(span(90_000), '1 d 1 h')
  assert.equal(span(3600), '1 h')
})

test('a running sandbox counts down to stop_at and a stopped one to delete_at', () => {
  const now = Date.parse('2026-11-08T10:00:00Z')
  assert.deepEqual(
    remaining(
      {
        status: 'running',
        stop_at: '2026-11-08T11:00:00Z',
        delete_at: null,
      },
      now,
    ),
    {
      label: 'left',
      text: '1 h',
      urgent: false,
    },
  )
  assert.deepEqual(
    remaining(
      {
        status: 'running',
        stop_at: '2026-11-08T10:05:00Z',
        delete_at: null,
      },
      now,
    ),
    {
      label: 'left',
      text: '5 min',
      urgent: true,
    },
  )
  assert.deepEqual(
    remaining(
      {
        status: 'stopped',
        stop_at: null,
        delete_at: '2026-11-15T10:00:00Z',
      },
      now,
    ),
    {
      label: 'until deletion',
      text: '7 d',
      urgent: false,
    },
  )
  assert.equal(
    remaining(
      {
        status: 'running',
        stop_at: null,
        delete_at: null,
      },
      now,
    ),
    null,
  )
})

test('attach frames carry the channel in the first byte', () => {
  assert.deepEqual([...stdinFrame('ls')], [0, 108, 115])
  const out = outputFrame(new Uint8Array([1, 104, 105]).buffer)
  assert.equal(out.channel, 1)
  assert.equal(new TextDecoder().decode(out.bytes), 'hi')
  assert.equal(
    attachUrl('/v1/runs/run_1/attach', 'https://dash.example.com', {
      rows: 24,
      cols: 80,
    }),
    'wss://dash.example.com/v1/runs/run_1/attach?rows=24&cols=80',
  )
  assert.equal(
    attachUrl('/v1/runs/run_1/attach', 'http://127.0.0.1:7900', {
      rows: 30,
      cols: 100,
    }),
    'ws://127.0.0.1:7900/v1/runs/run_1/attach?rows=30&cols=100',
  )
})

test('allowlist lines parse to API entries and back', () => {
  const parsed = parseAllowlist('registry.npmjs.org\n*.github.com:443,80 pypi.org')
  assert.equal(parsed.problem, null)
  assert.deepEqual(parsed.entries, [
    {
      domain: 'registry.npmjs.org',
      wildcard: false,
      ports: [],
    },
    {
      domain: 'github.com',
      wildcard: true,
      ports: [443, 80],
    },
    {
      domain: 'pypi.org',
      wildcard: false,
      ports: [],
    },
  ])
  assert.equal(allowlistText(parsed.entries), 'registry.npmjs.org\n*.github.com:443,80\npypi.org')
  assert.notEqual(parseAllowlist('not a domain').problem, null)
  assert.notEqual(parseAllowlist('example.com:70000').problem, null)
})
