import assert from 'node:assert/strict'
import { test } from 'node:test'

import { optimistic } from '../src/lib/cache.ts'
import { changedKeys, signatureOf, unversioned, versionsOf } from '../src/lib/fresh.ts'
import { firstErrorIndex, isErrorLine } from '../src/lib/logs.ts'
import { hasBecome, isFirstLive, nextWatch, watching } from '../src/lib/moments.ts'
import { loaderTitle, pageTitle, placeOf, titled } from '../src/lib/title.ts'

test('titles put the page first and Stationly last', () => {
  assert.equal(pageTitle(), 'Stationly')
  assert.equal(pageTitle('Projects'), 'Projects · Stationly')
  assert.equal(pageTitle('web', placeOf('shop', 'production')), 'web · shop/production · Stationly')
  assert.equal(pageTitle('Staged change', ''), 'Staged change · Stationly')
})

test('route heads carry one title tag', () => {
  assert.deepEqual(titled('Account'), {
    meta: [
      {
        title: 'Account · Stationly',
      },
    ],
  })
  assert.deepEqual(
    loaderTitle({
      loaderData: {
        title: ['web #3', 'shop/production'],
      },
    }),
    titled('web #3', 'shop/production'),
  )
  assert.deepEqual(loaderTitle({}), titled())
})

test('rows highlight when they are new or their version changed', () => {
  const seen = new Map([
    ['a', '1'],
    ['b', '1'],
  ])

  assert.deepEqual(
    changedKeys(seen, [
      ['a', '1'],
      ['b', '2'],
      ['c', ''],
    ]),
    new Set(['b', 'c']),
  )
  assert.deepEqual(changedKeys(seen, [['a', '1']]), new Set())
})

test('optimistic rows never highlight, so the confirmed row does', () => {
  const rows = versionsOf(
    [
      optimistic({
        id: 'queued-web',
      }),
      {
        id: 'd1',
      },
    ],
    unversioned,
  )

  assert.deepEqual(rows, [['d1', '']])
  assert.equal(signatureOf(rows), 'd1@')
})

test('a moment plays only after the value was seen false', () => {
  const waiting = watching('claude-code', false)

  assert.equal(hasBecome(waiting, 'claude-code', true), true)
  const already = watching('claude-code', true)

  assert.equal(hasBecome(already, 'claude-code', true), false)
  const unknown = watching('claude-code', undefined)

  assert.equal(hasBecome(nextWatch(unknown, 'claude-code', true), 'claude-code', true), false)
  const seenFalse = nextWatch(unknown, 'claude-code', false)

  assert.equal(hasBecome(nextWatch(seenFalse, 'claude-code', true), 'claude-code', true), true)
  const switched = nextWatch(waiting, 'cursor', true)

  assert.equal(hasBecome(switched, 'cursor', true), false)
})

test('first live ignores redeploys of a service that was live before', () => {
  assert.equal(
    isFirstLive('d2', [
      {
        id: 'd2',
        status: 'active',
      },
      {
        id: 'd1',
        status: 'failed',
      },
    ]),
    true,
  )
  assert.equal(
    isFirstLive('d2', [
      {
        id: 'd2',
        status: 'active',
      },
      {
        id: 'd1',
        status: 'superseded',
      },
    ]),
    false,
  )
})

test('log error lines are found by common error words', () => {
  assert.equal(isErrorLine('Error: listen EADDRINUSE :::3000'), true)
  assert.equal(isErrorLine('npm ERR! code ELIFECYCLE'), true)
  assert.equal(isErrorLine('Traceback (most recent call last):'), true)
  assert.equal(isErrorLine('0 errors, 2 warnings'), false)
  assert.equal(
    firstErrorIndex([
      {
        text: 'starting',
      },
      {
        text: 'panic: runtime error',
      },
      {
        text: 'fatal',
      },
    ]),
    1,
  )
  assert.equal(
    firstErrorIndex([
      {
        text: 'ok',
      },
    ]),
    -1,
  )
})
