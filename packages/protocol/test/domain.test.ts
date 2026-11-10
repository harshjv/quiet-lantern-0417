import assert from 'node:assert/strict'
import { test } from 'node:test'

import { bytesText, fitSandboxMemory, gibibyte } from '../src/index.ts'

const mebibyte = 1024 ** 2

test('fitSandboxMemory rounds the free memory down to 256 MiB and caps it at 4 GiB', () => {
  assert.equal(fitSandboxMemory(3 * gibibyte + 255 * mebibyte), 3 * gibibyte)
  assert.equal(fitSandboxMemory(512 * mebibyte), 512 * mebibyte)
  assert.equal(fitSandboxMemory(4 * gibibyte), 4 * gibibyte)
  assert.equal(fitSandboxMemory(200 * gibibyte), 4 * gibibyte)
})

test('fitSandboxMemory keeps the 4 GiB default below 512 MiB and when no memory is reported', () => {
  assert.equal(fitSandboxMemory(512 * mebibyte - 1), 4 * gibibyte)
  assert.equal(fitSandboxMemory(0), 4 * gibibyte)
  assert.equal(fitSandboxMemory(null), 4 * gibibyte)
})

test('bytesText states sizes in binary units', () => {
  assert.equal(bytesText(512), '512 B')
  assert.equal(bytesText(256 * mebibyte), '256 MiB')
  assert.equal(bytesText(Math.round(2.8 * gibibyte)), '2.8 GiB')
  assert.equal(bytesText(4 * gibibyte), '4 GiB')
})
