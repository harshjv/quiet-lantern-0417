import assert from 'node:assert/strict'
import { test } from 'node:test'

import { bytesText, fitMachineMemory, gibibyte } from '../src/index.ts'

const mebibyte = 1024 ** 2

test('fitMachineMemory rounds the free memory down to 256 MiB and caps it at 4 GiB', () => {
  assert.equal(fitMachineMemory(3 * gibibyte + 255 * mebibyte), 3 * gibibyte)
  assert.equal(fitMachineMemory(512 * mebibyte), 512 * mebibyte)
  assert.equal(fitMachineMemory(4 * gibibyte), 4 * gibibyte)
  assert.equal(fitMachineMemory(200 * gibibyte), 4 * gibibyte)
})

test('fitMachineMemory keeps the 4 GiB default below 512 MiB and when no memory is reported', () => {
  assert.equal(fitMachineMemory(512 * mebibyte - 1), 4 * gibibyte)
  assert.equal(fitMachineMemory(0), 4 * gibibyte)
  assert.equal(fitMachineMemory(null), 4 * gibibyte)
})

test('bytesText states sizes in binary units', () => {
  assert.equal(bytesText(512), '512 B')
  assert.equal(bytesText(256 * mebibyte), '256 MiB')
  assert.equal(bytesText(Math.round(2.8 * gibibyte)), '2.8 GiB')
  assert.equal(bytesText(4 * gibibyte), '4 GiB')
})
