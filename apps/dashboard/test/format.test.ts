import assert from 'node:assert/strict'
import { test } from 'node:test'

import { repositoryName, shortAgo } from '../src/lib/format.ts'

test('a repository shows as owner/name', () => {
  assert.equal(repositoryName('https://github.com/harshjv/stationly.git'), 'harshjv/stationly')
  assert.equal(repositoryName('https://github.com/harshjv/stationly'), 'harshjv/stationly')
  assert.equal(repositoryName('https://git.example.com:8443/a/b/c'), 'b/c')
})

test('ages are short', () => {
  const now = new Date('2026-11-13T12:00:00Z')
  const ago = (seconds: number) =>
    shortAgo(new Date(now.getTime() - seconds * 1000).toISOString(), now)

  assert.equal(ago(10), 'now')
  assert.equal(ago(5 * 60), '5m')
  assert.equal(ago(3 * 3600), '3h')
  assert.equal(ago(26 * 3600), '1d')
  assert.equal(ago(15 * 86400), '2w')
})
