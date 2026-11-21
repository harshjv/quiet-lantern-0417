import assert from 'node:assert/strict'
import { test } from 'node:test'

import { span } from '../src/lib/format.ts'
import { attachUrl, outputFrame, stdinFrame } from '../src/lib/terminal.ts'

test('spans format with the two largest units', () => {
  assert.equal(span(45), '45 s')
  assert.equal(span(125), '2 min 5 s')
  assert.equal(span(4500), '1 h 15 min')
  assert.equal(span(90_000), '1 d 1 h')
  assert.equal(span(3600), '1 h')
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
