import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { App } from '../src/lib/api.ts'
import { healthChangeText, healthFacts, healthPortNote, healthWhy } from '../src/lib/health-text.ts'

const timing = {
  interval_s: 5,
  timeout_s: 3,
  startup_timeout_s: 120,
  passes: 2,
  failures: 3,
}

test('an http check reads as facts with its port, timing and thresholds', () => {
  assert.deepEqual(
    healthFacts({
      type: 'http',
      path: '/',
      port: 3000,
      ...timing,
    }),
    [
      ['Check', 'HTTP GET /'],
      ['Port', '3000'],
      ['Every', '5 s'],
      ['Timeout', '3 s'],
      ['Healthy after', '2 passes'],
      ['Failing after', '3 failures'],
    ],
  )
})

test('an http check names its Host header when one is set', () => {
  assert.deepEqual(
    healthFacts({
      type: 'http',
      path: '/ready',
      port: 8080,
      host: 'web.internal',
      ...timing,
    }).slice(0, 3),
    [
      ['Check', 'HTTP GET /ready'],
      ['Port', '8080'],
      ['Host', 'web.internal'],
    ],
  )
})

test('a tcp, image, alive and absent check each name their check', () => {
  assert.deepEqual(
    healthFacts({
      type: 'tcp',
      port: 5432,
      ...timing,
    }).slice(0, 2),
    [
      ['Check', 'TCP connect'],
      ['Port', '5432'],
    ],
  )
  assert.deepEqual(
    healthFacts({
      type: 'image',
    }),
    [['Check', 'The image’s HEALTHCHECK']],
  )
  assert.deepEqual(
    healthFacts({
      type: 'alive',
      seconds: 10,
    }),
    [['Check', 'Running for 10 s']],
  )
  assert.deepEqual(healthFacts(null), [['Check', 'None, judged by exit code']])
})

test('a default check says why it was chosen and a set one does not', () => {
  const http = {
    type: 'http' as const,
    path: '/',
    port: 3000,
    ...timing,
  }

  assert.equal(
    healthWhy({
      kind: 'web',
      health: http,
      health_default: true,
    }),
    'Default: the first HTTP port',
  )
  assert.equal(
    healthWhy({
      kind: 'web',
      health: {
        type: 'tcp',
        port: 5432,
        ...timing,
      },
      health_default: true,
    }),
    'Default: the first port',
  )
  assert.equal(
    healthWhy({
      kind: 'worker',
      health: {
        type: 'alive',
        seconds: 10,
      },
      health_default: true,
    }),
    'Default: a worker has no port',
  )
  assert.equal(
    healthWhy({
      kind: 'web',
      health: http,
      health_default: false,
    }),
    null,
  )
  assert.equal(
    healthWhy({
      kind: 'cron',
      health: null,
      health_default: true,
    }),
    null,
  )
})

test('several ports make plain that only the named one is checked', () => {
  const http = {
    type: 'http' as const,
    path: '/',
    port: 3000,
    ...timing,
  }

  assert.equal(
    healthPortNote(http, [
      {
        port: 3000,
      },
      {
        port: 9000,
      },
    ]),
    'Only port 3000 is checked; 9000 is not.',
  )
  assert.equal(
    healthPortNote(http, [
      {
        port: 3000,
      },
      {
        port: 9000,
      },
      {
        port: 9001,
      },
    ]),
    'Only port 3000 is checked; 9000, 9001 are not.',
  )
  assert.equal(
    healthPortNote(http, [
      {
        port: 3000,
      },
    ]),
    null,
  )
  assert.equal(
    healthPortNote(
      {
        type: 'alive',
        seconds: 10,
      },
      [
        {
          port: 3000,
        },
        {
          port: 9000,
        },
      ],
    ),
    null,
  )
})

const change = (
  fields: Partial<NonNullable<App['last_health_change']>>,
): NonNullable<App['last_health_change']> => ({
  at: '2026-11-13T10:00:00.000Z',
  from: 'healthy',
  to: 'failing',
  state: null,
  consecutive: null,
  last_check: null,
  status_hint: null,
  ...fields,
})

test('the reason an unhealthy app gives follows the newest health change', () => {
  assert.equal(
    healthChangeText(
      change({
        state: 'failed',
        consecutive: 3,
      }),
    ),
    'The health check has failed (3 in a row)',
  )
  assert.equal(
    healthChangeText(
      change({
        state: 'none',
        status_hint: 'stopped',
      }),
    ),
    'The container is not running',
  )
  assert.equal(healthChangeText(change({})), 'Went from healthy to failing')
})
