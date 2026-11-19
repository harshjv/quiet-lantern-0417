import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { eq } from 'drizzle-orm'

import type { Generation } from '@stationly/protocol'

import { setupInstance } from '../src/auth/bootstrap.ts'
import { server } from '../src/db/schema.ts'

import {
  adminEmail,
  adminPassword,
  startDispatch,
  startFakeStation,
  testHostnames,
  type Dispatch,
} from './helpers/dispatch.ts'
import type { FakeStation } from './helpers/fake-station.ts'
import {
  createApp,
  createPreview,
  createProject,
  pinPlatform,
  seedLockfile,
} from './helpers/seed.ts'

const { dashboard, api } = testHostnames
const actor = {
  type: 'system' as const,
  id: null,
  client: 'test',
}

describe('the generation carries Dispatch routes', () => {
  let h: Dispatch
  let fake: FakeStation

  before(async () => {
    h = await startDispatch()
    seedLockfile(h)
    fake = await startFakeStation(h)
    h.db
      .update(server)
      .set({
        hosts_dispatch: true,
      })
      .where(eq(server.id, fake.stationId))
      .run()
  })

  after(async () => {
    await h.close()
  })

  const next = async (predicate: (doc: Generation) => boolean) => {
    h.deps.stations.reconcile(fake.stationId)

    return (await fake.waitForGeneration((d) =>
      predicate(d as unknown as Generation),
    )) as unknown as Generation
  }

  test('a station that hosts Dispatch gets the dispatch system target at the first address of the virtual prefix', async () => {
    const doc = await next((d) => 'dispatch' in d.system_targets)
    const target = doc.system_targets.dispatch!

    assert.equal(target.component, 'dispatch')
    assert.equal(target.virtual_ip, '100.64.0.1')
    assert.equal(target.port, 7900)
    assert.match(target.hash, /^sha256:[0-9a-f]{64}$/)
  })

  test('both hostnames route through the tunnel to Dispatch', async () => {
    const doc = await next((d) => 'system-api' in d.gateway.routes)

    assert.deepEqual(Object.keys(doc.gateway.routes).sort(), ['system-api', 'system-dashboard'])

    for (const [id, host] of [
      ['system-api', api],
      ['system-dashboard', dashboard],
    ] as const) {
      const r = doc.gateway.routes[id]!

      assert.equal(r.hostname, host)
      assert.deepEqual(r.target, {
        system: 'dispatch',
        virtual_ip: '100.64.0.1',
        port: 7900,
      })
    }
  })

  test('a station that does not host Dispatch gets neither the target nor the routes', async () => {
    h.db
      .update(server)
      .set({
        hosts_dispatch: false,
      })
      .where(eq(server.id, fake.stationId))
      .run()
    const doc = await next((d) => !('dispatch' in d.system_targets))

    assert.deepEqual(doc.system_targets, {})
    assert.deepEqual(Object.keys(doc.gateway.routes), [])
    h.db
      .update(server)
      .set({
        hosts_dispatch: true,
      })
      .where(eq(server.id, fake.stationId))
      .run()
  })

  test('an app domain cannot take Dispatch hostname, and Dispatch cannot take a routed one', async () => {
    pinPlatform(h, {
      gateway: true,
    })
    const environmentId = (await createPreview(h, (await createProject(h, 'gw')).name, 'staging'))
      .id
    const web = await createApp(h, environmentId, {
      name: 'web',
      ref: 'nginx:1.27',
      ports: [
        {
          port: 80,
        },
      ],
    })
    const taken = await h.call('POST', `/v1/ports/${web.ports[0].id}/domains`, {
      token: h.admin.token,
      body: {
        hostname: api,
      },
    })

    assert.equal(taken.status, 409, taken.text)
    assert.equal(taken.body.error.code, 'NAME_TAKEN')
    assert.equal(taken.body.error.details.setting, 'hostnames.api')
    const routed = await h.call('POST', `/v1/ports/${web.ports[0].id}/domains`, {
      token: h.admin.token,
      body: {
        hostname: 'shop.stationly.test',
      },
    })

    assert.ok(routed.status === 201 || routed.status === 202, routed.text)
    const moved = await h.call('PATCH', '/v1/settings', {
      cookie: h.admin.cookie,
      origin: 'http://127.0.0.1:7900',
      body: {
        'hostnames.api': 'shop.stationly.test',
      },
    })

    assert.equal(moved.body.error.code, 'NAME_TAKEN', moved.text)
  })
})

describe('the hostnames stay set', () => {
  let h: Dispatch

  before(async () => {
    h = await startDispatch()
  })

  after(async () => {
    await h.close()
  })

  test('one hostname alone cannot be cleared', async () => {
    const half = await h.call('PATCH', '/v1/settings', {
      cookie: h.admin.cookie,
      origin: 'http://127.0.0.1:7900',
      body: {
        'hostnames.api': null,
      },
    })

    assert.equal(half.body.error.code, 'VALIDATION_FAILED', half.text)
  })
})

describe('the setup login link', () => {
  let h: Dispatch
  let link: string

  before(async () => {
    h = await startDispatch({
      setup: false,
    })
    const out = await setupInstance(
      {
        db: h.deps.db,
        keyring: h.deps.keyring,
        auth: h.deps.auth,
      },
      {
        email: adminEmail,
        password: adminPassword,
        hostnames: {
          dashboard,
          api,
        },
      },
      actor,
    )

    link = out.login_link!
  })

  after(async () => {
    await h.close()
  })

  test('points at the dashboard host over HTTPS and returns there', () => {
    const url = new URL(link)

    assert.equal(url.origin, `https://${dashboard}`)
    assert.equal(url.pathname, '/auth/magic-link/verify')
    assert.equal(url.searchParams.get('callbackURL'), `https://${dashboard}/`)
  })

  test('verifies once on the dashboard host as the Gateway forwards it, with a host-only secure session cookie', async () => {
    const forwarded = {
      'x-forwarded-for': '198.51.100.7',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': dashboard,
    }
    const first = await h.fetch(
      new Request(link, {
        headers: forwarded,
        redirect: 'manual',
      }),
    )

    assert.equal(first.status, 302, await first.clone().text())
    assert.equal(first.headers.get('location'), `https://${dashboard}/`)
    const cookies = first.headers.getSetCookie()
    const session = cookies.find((c) => c.startsWith('__Secure-better-auth.session_token='))

    assert.ok(session, cookies.join(' | '))
    assert.match(session, /;\s*Secure/i)
    assert.doesNotMatch(session, /Domain=/i)
    const cookie = session.split(';')[0]!
    const me = await h.fetch(
      new Request(`https://${dashboard}/v1/me`, {
        headers: {
          ...forwarded,
          cookie,
        },
      }),
    )

    assert.equal(me.status, 200, await me.clone().text())
    const onApi = await h.fetch(
      new Request(`https://${api}/v1/me`, {
        headers: {
          ...forwarded,
          'x-forwarded-host': api,
          cookie,
        },
      }),
    )

    assert.equal(onApi.status, 401, 'the dashboard session cookie is not accepted on the API host')
    const again = await h.fetch(
      new Request(link, {
        headers: forwarded,
        redirect: 'manual',
      }),
    )

    assert.equal(
      again.headers
        .getSetCookie()
        .some((c) => c.startsWith('__Secure-better-auth.session_token=') && !/Max-Age=0/i.test(c)),
      false,
    )
  })
})
