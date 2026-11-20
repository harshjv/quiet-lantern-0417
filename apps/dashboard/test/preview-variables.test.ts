import assert from 'node:assert/strict'
import { test } from 'node:test'

import { hasNoValue, noValueLabel } from '../src/lib/variables.ts'

test('a secret environment variable with no version reads as having no value here', () => {
  assert.equal(noValueLabel, 'No value here')
  assert.equal(
    hasNoValue({
      kind: 'secret',
      head_version: null,
    }),
    true,
  )
})

test('a secret environment variable with a value, and every other kind, does not', () => {
  assert.equal(
    hasNoValue({
      kind: 'secret',
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
