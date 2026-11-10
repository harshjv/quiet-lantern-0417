import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { NetworkMap } from '../src/lib/api.ts'
import { rcode } from '../src/lib/labels.ts'
import {
  blockedText,
  domainState,
  drainingText,
  endpointText,
  exposureState,
  exposureText,
  hopDetail,
  portSpecText,
  portText,
  rateText,
  servingText,
  stepText,
} from '../src/lib/network-text.ts'

type MapService = NetworkMap['services'][number]
type Switch = MapService['switch']

const deployment = {
  id: 'dep_14',
  number: 14,
  address: '10.20.3.5',
}

const service = (sw: Partial<Switch>): Pick<MapService, 'name' | 'switch'> => ({
  name: 'web',
  switch: {
    state: 'serving',
    deployment: null,
    draining: null,
    ...sw,
  },
})

const map = {
  subnets: [
    {
      station: {
        id: 'sta_home',
        name: 'home',
      },
    },
  ],
} as unknown as Pick<NetworkMap, 'subnets'>

test('serving names the deployment and keeps its address as the hint', () => {
  assert.deepEqual(
    servingText(
      service({
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

test('routing states read as sentences about the service', () => {
  assert.equal(
    servingText(
      service({
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
      service({
        state: 'pending',
      }),
    ).label,
    'Switching to a new deployment',
  )
  assert.equal(
    servingText(
      service({
        state: 'no_target',
      }),
    ).label,
    'Not running. Calls to web are refused.',
  )
  const mismatch = servingText(
    service({
      state: 'mismatch',
    }),
  )
  assert.equal(mismatch.label, 'Routing is out of date')
  assert.equal(mismatch.tone, 'danger')
  assert.match(mismatch.hint ?? '', /Redeploy web/)
})

test('draining shows the old deployment finishing its connections', () => {
  assert.equal(drainingText(service({}).switch), null)
  assert.equal(
    drainingText(
      service({
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
    certificate: {
      status: 'valid',
    },
    route: {
      result: 'ok',
    },
  } as Parameters<typeof domainState>[0]
  assert.equal(domainState(live).label, 'Live, certificate valid')
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
      certificate: {
        ...live.certificate,
        status: 'pending',
      },
    }).label,
    'Waiting for certificate',
  )
  assert.equal(
    domainState({
      ...live,
      route: {
        ...live.route,
        result: null,
      },
    }).label,
    'Waiting for the station',
  )
  assert.equal(
    domainState({
      ...live,
      route: {
        ...live.route,
        result: 'failed',
      },
    }).label,
    'The station couldn’t apply it',
  )
})

test('a public TCP port without a reported result waits for the station', () => {
  assert.equal(exposureState(undefined).label, 'Waiting for the station')
  assert.equal(
    exposureState({
      result: 'ok',
    }).label,
    'Live',
  )
})

test('a public TCP port reads as words, with or without a public address', () => {
  const exposure = {
    public: '203.0.113.5:30001',
    port: 5432,
    host_port: 30001,
    station_id: 'sta_home',
  } as MapService['exposures'][number]
  assert.equal(exposureText(map, exposure), '203.0.113.5:30001 to port 5432')
  assert.equal(
    exposureText(map, {
      ...exposure,
      public: null,
    }),
    'Port 30001 on home (no public address)',
  )
  assert.equal(
    exposureText(map, {
      ...exposure,
      public: null,
      station_id: 'sta_gone',
    }),
    'Port 30001 on the station (no public address)',
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
    'Deployment #14 · station home · stable address 10.200.0.7 · container exited',
  )
  assert.equal(
    hopDetail({
      path: 'host_address',
      listening: [],
    }),
    'rule “The station and Stationly’s own services” · listening on nothing',
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

test('steps name the services they check', () => {
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
