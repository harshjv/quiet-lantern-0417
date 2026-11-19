import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { NetworkMap } from '../src/lib/api.ts'
import { rcode } from '../src/lib/labels.ts'
import {
  blockedText,
  domainState,
  drainingText,
  endpointText,
  hopDetail,
  portSpecText,
  portText,
  rateText,
  servingText,
  stepText,
} from '../src/lib/network-text.ts'

type MapApp = NetworkMap['apps'][number]
type Switch = MapApp['switch']

const deployment = {
  id: 'dep_14',
  number: 14,
  address: '10.20.3.5',
}

const app = (sw: Partial<Switch>): Pick<MapApp, 'name' | 'switch'> => ({
  name: 'web',
  switch: {
    state: 'serving',
    deployment: null,
    draining: null,
    ...sw,
  },
})

test('serving names the deployment and keeps its address as the hint', () => {
  assert.deepEqual(
    servingText(
      app({
        deployment,
      }),
    ),
    {
      label: 'Deployment #14',
      tone: null,
      hint: '10.20.3.5',
    },
  )
})

test('routing states read as sentences about the app', () => {
  assert.equal(
    servingText(
      app({
        state: 'pending',
        deployment: {
          ...deployment,
          number: 15,
        },
      }),
    ).label,
    'Switching to #15',
  )
  assert.equal(
    servingText(
      app({
        state: 'pending',
      }),
    ).label,
    'Switching to a new deployment',
  )
  assert.equal(
    servingText(
      app({
        state: 'no_target',
      }),
    ).label,
    'Not running. Calls to web are refused.',
  )
  const mismatch = servingText(
    app({
      state: 'mismatch',
    }),
  )

  assert.equal(mismatch.label, 'Routing is out of date')
  assert.equal(mismatch.tone, 'danger')
  assert.match(mismatch.hint ?? '', /Redeploy web/)
})

test('draining shows the old deployment finishing its connections', () => {
  assert.equal(drainingText(app({}).switch), null)
  assert.equal(
    drainingText(
      app({
        draining: {
          id: 'dep_13',
          number: 13,
          address: null,
          since: null,
        },
      }).switch,
    ),
    '#13 finishing open connections',
  )
})

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

test('ports, endpoints and rates use one notation', () => {
  assert.equal(portText(5432, 'tcp'), '5432 TCP')
  assert.equal(
    portSpecText({
      port: 9090,
      protocol: 'http',
      grpc: true,
    }),
    '9090 gRPC',
  )
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

test('blocked attempts count in words', () => {
  assert.equal(blockedText(1), 'Blocked once')
  assert.equal(blockedText(3), 'Blocked 3 times')
})

test('hop details read as pairs and hide internals', () => {
  assert.equal(
    hopDetail({
      deployment: 14,
      station: 'home',
      generation: 412,
      virtual_ip: '10.200.0.7',
      reason: 'container exited',
      empty: null,
    }),
    'Deployment #14 · server home · stable address 10.200.0.7 · container exited',
  )
  assert.equal(
    hopDetail({
      path: 'host_address',
      listening: [],
    }),
    'rule “The server and Stationly’s own apps” · listening on nothing',
  )
  assert.equal(
    hopDetail({
      listening: [
        {
          address: '127.0.0.1',
          port: 5432,
          protocol: 'tcp',
        },
      ],
    }),
    'listening on 127.0.0.1:5432 TCP',
  )
  assert.doesNotMatch(
    hopDetail({
      expires_at: '2026-11-10T14:03:12Z',
    }),
    /T14:03:12Z/,
  )
})

test('steps name the apps they check', () => {
  const entity = {
    from: 'web',
    to: 'db:5432',
  }

  assert.equal(stepText('source', entity), 'web is running')
  assert.equal(stepText('target', entity), 'db is running and healthy')
  assert.equal(stepText('listening', entity), 'db listens on the port')
  assert.equal(stepText('switch', entity), 'Routing (the Switch)')
})

test('name lookup results read as words and keep unknown codes', () => {
  assert.equal(rcode('NXDOMAIN'), 'No such name')
  assert.equal(rcode('BADCOOKIE'), 'BADCOOKIE')
})
