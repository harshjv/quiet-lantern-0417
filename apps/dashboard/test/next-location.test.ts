import assert from 'node:assert/strict'
import { test } from 'node:test'

import { nextLocation } from '../src/lib/next-location.ts'

test('the page to return to after sign-in keeps its query', () => {
  assert.deepEqual(nextLocation('/projects/web/production?tab=workspaces'), {
    to: '/projects/web/production',
    search: {
      tab: 'workspaces',
    },
  })
  assert.deepEqual(nextLocation('/sessions'), {
    to: '/sessions',
    search: {},
  })
})
