import assert from 'node:assert/strict'
import { test } from 'node:test'

import { parseDuration, parseSeconds, parseSize } from '../src/format.ts'

test('durations parse in single and combined units', () => {
  assert.equal(parseDuration('15m'), 900)
  assert.equal(parseDuration('4h'), 14_400)
  assert.equal(parseDuration('1h 30m'), 5400)
  assert.equal(parseDuration('2d'), 172_800)
  assert.equal(parseDuration('30d'), 2_592_000)
  assert.equal(parseDuration('soon'), null)
  assert.equal(parseDuration('1h soon'), null)
  assert.equal(parseDuration('2026-11-10T10:00:00Z'), null)
  assert.equal(parseDuration(''), null)
  assert.equal(parseDuration('10'), null)
})

test('seconds take a bare integer or a duration', () => {
  assert.equal(parseSeconds('90'), 90)
  assert.equal(parseSeconds('1h 30m'), 5400)
  assert.equal(parseSeconds('soon'), null)
})

test('sizes parse bytes and binary units', () => {
  assert.equal(parseSize('1024'), 1024)
  assert.equal(parseSize('512MiB'), 512 * 1024 ** 2)
  assert.equal(parseSize('8GiB'), 8 * 1024 ** 3)
  assert.equal(parseSize('8 gb'), 8 * 1024 ** 3)
  assert.equal(parseSize('1.5g'), 1.5 * 1024 ** 3)
  assert.equal(parseSize('8x'), null)
  assert.equal(parseSize(''), null)
})
