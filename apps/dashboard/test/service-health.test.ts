import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Service } from '../src/lib/api.ts'
import { healthChangeText, healthLine, healthPortNote, healthWhy } from '../src/lib/health-text.ts'

const timing = {
  interval_s: 5,
  timeout_s: 3,
  startup_timeout_s: 120,
  passes: 2,
  failures: 3,
}

test('an http check reads as one line with its port, timing and thresholds', () => {
  assert.equal(
    healthLine({
      type: 'http',
      path: '/',
      port: 3000,
      ...timing,
    }),
    'HTTP GET / on port 3000 · every 5 s, 3 s timeout · 2 passes to go live, 3 failures to turn red',
  )
})

test('an http check names its Host header when one is set', () => {
  assert.equal(
    healthLine({
      type: 'http',
      path: '/ready',
      port: 8080,
      host: 'web.internal',
      ...timing,
    }),
    'HTTP GET /ready on port 8080 with Host web.internal · every 5 s, 3 s timeout · 2 passes to go live, 3 failures to turn red',
  )
})

test('a tcp, image, alive and absent check each read in one line', () => {
  assert.equal(
    healthLine({
      type: 'tcp',
      port: 5432,
      ...timing,
    }),
    'TCP connect to port 5432 · every 5 s, 3 s timeout · 2 passes to go live, 3 failures to turn red',
  )
  assert.equal(
    healthLine({
      type: 'image',
    }),
    'The image’s own HEALTHCHECK',
  )
  assert.equal(
    healthLine({
      type: 'alive',
      seconds: 10,
    }),
    'Running for 10 s without exiting',
  )
  assert.equal(healthLine(null), 'No health check; runs are judged by their exit code')
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
    'Default for a web service: the first http port',
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
    'Default for a web service with no http port: the first port',
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
    'Default for a worker: it has no port to check',
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
  fields: Partial<NonNullable<Service['last_health_change']>>,
): NonNullable<Service['last_health_change']> => ({
  at: '2026-11-13T10:00:00.000Z',
  from: 'green',
  to: 'amber',
  state: null,
  consecutive: null,
  last_check: null,
  status_hint: null,
  ...fields,
})

test('the reason an unhealthy service gives follows the newest health change', () => {
  assert.equal(
    healthChangeText(
      change({
        state: 'failing',
        consecutive: 2,
      }),
    ),
    'The health check is failing (2 in a row)',
  )
  assert.equal(
    healthChangeText(
      change({
        to: 'red',
        state: 'failed',
        consecutive: 3,
      }),
    ),
    'The health check has failed (3 in a row)',
  )
  assert.equal(
    healthChangeText(
      change({
        to: 'red',
        state: 'none',
        status_hint: 'stopped',
      }),
    ),
    'The container is not running',
  )
  assert.equal(healthChangeText(change({})), 'Went from green to amber')
})
