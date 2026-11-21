import assert from 'node:assert/strict'
import { test } from 'node:test'

import { domainState, endpointText, rateText } from '../src/lib/network-text.ts'

test('domain state names the first thing that is not live', () => {
  const live = {
    status: 'active',
    route: {
      result: 'ok',
    },
  } as Parameters<typeof domainState>[0]

  assert.equal(domainState(live).label, 'Live')
  assert.equal(
    domainState({
      ...live,
      status: 'error',
    }).label,
    'Not working',
  )
  assert.equal(
    domainState({
      ...live,
      status: 'pending',
    }).label,
    'Not reachable yet',
  )
  assert.equal(
    domainState({
      ...live,
      route: {
        ...live.route,
        result: null,
      },
    }).label,
    'Waiting for the server',
  )
  assert.equal(
    domainState({
      ...live,
      route: {
        ...live.route,
        result: 'failed',
      },
    }).label,
    'The server couldn’t apply it',
  )
})

test('endpoints and rates use one notation', () => {
  assert.equal(
    endpointText({
      address: '10.0.0.1',
      port: 2375,
      protocol: 'tcp',
    }),
    '10.0.0.1:2375 TCP',
  )
  assert.equal(rateText(512), '512 B/s')
  assert.equal(rateText(1_200_000), '1.2 MB/s')
})
