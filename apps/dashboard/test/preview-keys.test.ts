import assert from 'node:assert/strict'
import { test } from 'node:test'

import { hasNoValue, noValueLabel } from '../src/lib/variables.ts'

test('a sealed key with no version reads as having no value in this environment', () => {
  assert.equal(noValueLabel, 'No value in this environment')
  assert.equal(
    hasNoValue({
      kind: 'sealed',
      head_version: null,
    }),
    true,
  )
})

test('a sealed key with a value, and every other kind, does not', () => {
  assert.equal(
    hasNoValue({
      kind: 'sealed',
      head_version: 3,
    }),
    false,
  )
  assert.equal(
    hasNoValue({
      kind: 'literal',
      head_version: null,
    }),
    false,
  )
  assert.equal(
    hasNoValue({
      kind: 'reference',
      head_version: null,
    }),
    false,
  )
})
