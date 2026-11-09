import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import type { Generation } from '@stationly/protocol'
import { eq } from 'drizzle-orm'
import { setupInstance } from '../src/auth/bootstrap.ts'
import { setting, station } from '../src/db/schema.ts'
import { adminEmail, adminPassword, startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import type { FakeStation } from './helpers/fake-station.ts'
import { createProject, createService, pinPlatform, seedLockfile } from './helpers/seed.ts'

const publicAddress = '198.51.100.10'
const dashboard = 'dash.sly.test'
const api = 'api.sly.test'
const actor = { type: 'system' as const, id: null, client: 'test' }

const putSetting = (h: Dispatch, key: string, value: unknown) =>
  h.db.insert(setting).values({ key, value, updated_by: actor }).onConflictDoUpdate({ target: setting.key, set: { value } }).run()

const dropSetting = (h: Dispatch, key: string) => h.db.delete(setting).where(eq(setting.key, key)).run()

describe('the generation carries Dispatch routes', () => {
  let h: Dispatch
  let fake: FakeStation

  before(async () => {
    h = await startDispatch()
    seedLockfile(h)
    fake = await startFakeStation(h)
    h.db.update(station).set({ hosts_dispatch: true }).where(eq(station.id, fake.stationId)).run()
  })

  after(async () => {
    await h.close()
  })

  const next = async (predicate: (doc: Generation) => boolean) => {
    h.deps.stations.reconcile(fake.stationId)
    return (await fake.waitForGeneration(d => predicate(d as unknown as Generation))) as unknown as Generation
  }

  test('a station that hosts Dispatch gets the dispatch system target at the first address of the virtual prefix', async () => {
    const doc = await next(d => 'dispatch' in d.system_targets)
    const target = doc.system_targets.dispatch!
    assert.equal(target.component, 'dispatch')
    assert.equal(target.virtual_ip, '100.64.0.1')
    assert.equal(target.port, 7900)
    assert.match(target.hash, /^sha256:[0-9a-f]{64}$/)
  })

  test('without a public address and without hostnames there is no Dispatch route and the web ports stay closed', async () => {
    const doc = await next(d => 'dispatch' in d.system_targets)
    assert.deepEqual(Object.keys(doc.gateway.routes), [])
    assert.equal(doc.station.inbound.web_ports, 'closed')
  })

  test('hostnames without a public address leave the routes out with an explanation', async () => {
    putSetting(h, 'hostnames.dashboard', dashboard)
    putSetting(h, 'hostnames.api', api)
    h.deps.stations.reconcile(fake.stationId)
    const built = (await import('../src/station/generations.ts')).buildDesired(h.db, fake.stationId)
    assert.deepEqual(Object.keys(built.content.gateway.routes), [])
    const reasons = built.excluded.filter(e => e.object === 'route').map(e => `${e.id}: ${e.explanation}`)
    assert.equal(reasons.length, 2)
    for (const r of reasons) assert.match(r, /public_address/)
  })

  test('with a public address both hostnames route directly to Dispatch with the classic resolver and redirect HTTP', async () => {
    h.db.update(station).set({ public_address: publicAddress }).where(eq(station.id, fake.stationId)).run()
    const doc = await next(d => 'system-api' in d.gateway.routes)
    assert.deepEqual(Object.keys(doc.gateway.routes).sort(), ['system-api', 'system-dashboard'])
    for (const [id, host] of [['system-api', api], ['system-dashboard', dashboard]] as const) {
      const r = doc.gateway.routes[id]!
      assert.equal(r.hostname, host)
      assert.equal(r.ingress, 'direct')
      assert.deepEqual(r.target, { system: 'dispatch', virtual_ip: '100.64.0.1', port: 7900 })
      assert.deepEqual(r.tls, { resolver: 'letsencrypt' })
      assert.equal(r.redirect_http, true)
    }
    assert.equal(doc.station.inbound.web_ports, 'open')
    assert.equal(doc.station.public_address, publicAddress)
  })

  test('a domainless station routes its public address with the shortlived resolver', async () => {
    dropSetting(h, 'hostnames.dashboard')
    dropSetting(h, 'hostnames.api')
    const doc = await next(d => 'system-address' in d.gateway.routes)
    assert.deepEqual(Object.keys(doc.gateway.routes), ['system-address'])
    const r = doc.gateway.routes['system-address']!
    assert.equal(r.hostname, publicAddress)
    assert.deepEqual(r.tls, { resolver: 'letsencrypt-shortlived' })
    assert.equal(r.redirect_http, true)
  })

  test('a station that does not host Dispatch gets neither the target nor the routes', async () => {
    h.db.update(station).set({ hosts_dispatch: false }).where(eq(station.id, fake.stationId)).run()
    const doc = await next(d => !('dispatch' in d.system_targets))
    assert.deepEqual(doc.system_targets, {})
    assert.deepEqual(Object.keys(doc.gateway.routes), [])
    h.db.update(station).set({ hosts_dispatch: true }).where(eq(station.id, fake.stationId)).run()
  })

  test('a service domain cannot take Dispatch hostname, and Dispatch cannot take a routed one', async () => {
    putSetting(h, 'hostnames.dashboard', dashboard)
    putSetting(h, 'hostnames.api', api)
    pinPlatform(h, { gateway: true })
    const environmentId = (await createProject(h, 'gw')).default_environment_id
    const web = await createService(h, environmentId, { name: 'web', ref: 'nginx:1.27', ports: [{ port: 80 }] })
    const taken = await h.call('POST', `/v1/ports/${web.ports[0].id}/domains`, { token: h.admin.token, body: { hostname: api } })
    assert.equal(taken.status, 409, taken.text)
    assert.equal(taken.body.error.code, 'NAME_TAKEN')
    assert.equal(taken.body.error.details.setting, 'hostnames.api')
    const routed = await h.call('POST', `/v1/ports/${web.ports[0].id}/domains`, { token: h.admin.token, body: { hostname: 'shop.sly.test' } })
    assert.ok(routed.status === 201 || routed.status === 202, routed.text)
    const moved = await h.call('PATCH', '/v1/settings', { cookie: h.admin.cookie, origin: 'http://127.0.0.1:7900', body: { 'hostnames.api': 'shop.sly.test' } })
    assert.equal(moved.body.error.code, 'NAME_TAKEN', moved.text)
  })
})

describe('clearing the hostnames makes the station domainless', () => {
  let h: Dispatch
  let cookie: string

  before(async () => {
    h = await startDispatch()
    const set = await h.call('PATCH', '/v1/settings', { cookie: h.admin.cookie, origin: 'http://127.0.0.1:7900', body: { 'hostnames.dashboard': dashboard, 'hostnames.api': api } })
    assert.equal(set.status, 200, set.text)
    const again = await h.call('POST', '/auth/sign-in/email', { origin: 'http://127.0.0.1:7900', headers: { 'x-forwarded-for': '198.51.100.99' }, body: { email: adminEmail, password: adminPassword } })
    cookie = again.headers.getSetCookie().map(c => c.split(';')[0]!).join('; ')
  })

  after(async () => {
    await h.close()
  })

  test('one hostname alone is refused', async () => {
    const half = await h.call('PATCH', '/v1/settings', { cookie, origin: 'http://127.0.0.1:7900', body: { 'hostnames.api': null } })
    assert.equal(half.body.error.code, 'VALIDATION_FAILED', half.text)
  })

  test('clearing both needs a passkey reset from a human, then drops the RP ID', async () => {
    const body = { 'hostnames.dashboard': null, 'hostnames.api': null }
    const plain = await h.call('PATCH', '/v1/settings', { cookie, origin: 'http://127.0.0.1:7900', body })
    assert.equal(plain.body.error.code, 'PASSKEY_RESET_REQUIRED', plain.text)
    const byToken = await h.call('PATCH', '/v1/settings?reset_passkeys=true', { token: h.admin.token, body })
    assert.equal(byToken.status, 403, byToken.text)
    const human = await h.call('PATCH', '/v1/settings?reset_passkeys=true', { cookie, origin: 'http://127.0.0.1:7900', body })
    assert.equal(human.status, 200, human.text)
    assert.equal(h.db.select().from(setting).where(eq(setting.key, 'auth.passkey_rp_id')).get()?.value ?? null, null)
    assert.equal(h.deps.auth.surface.dashboardOrigin, 'http://127.0.0.1:7900')
  })
})

describe('the setup login link', () => {
  let h: Dispatch
  let link: string

  before(async () => {
    h = await startDispatch({ setup: false })
    const out = await setupInstance({ db: h.deps.db, keyring: h.deps.keyring, auth: h.deps.auth }, { email: adminEmail, password: adminPassword, hostnames: { dashboard, api } }, actor)
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
    const forwarded = { 'x-forwarded-for': '198.51.100.7', 'x-forwarded-proto': 'https', 'x-forwarded-host': dashboard }
    const first = await h.fetch(new Request(link, { headers: forwarded, redirect: 'manual' }))
    assert.equal(first.status, 302, await first.clone().text())
    assert.equal(first.headers.get('location'), `https://${dashboard}/`)
    const cookies = first.headers.getSetCookie()
    const session = cookies.find(c => c.startsWith('__Secure-better-auth.session_token='))
    assert.ok(session, cookies.join(' | '))
    assert.match(session, /;\s*Secure/i)
    assert.doesNotMatch(session, /Domain=/i)
    const cookie = session.split(';')[0]!
    const me = await h.fetch(new Request(`https://${dashboard}/v1/me`, { headers: { ...forwarded, cookie } }))
    assert.equal(me.status, 200, await me.clone().text())
    const onApi = await h.fetch(new Request(`https://${api}/v1/me`, { headers: { ...forwarded, 'x-forwarded-host': api, cookie } }))
    assert.equal(onApi.status, 401, 'the dashboard session cookie is not accepted on the API host')
    const again = await h.fetch(new Request(link, { headers: forwarded, redirect: 'manual' }))
    assert.equal(again.headers.getSetCookie().some(c => c.startsWith('__Secure-better-auth.session_token=') && !/Max-Age=0/i.test(c)), false)
  })
})

describe('a domainless station answers on its public address', () => {
  let h: Dispatch

  before(async () => {
    h = await startDispatch()
    seedLockfile(h)
    const fake = await startFakeStation(h)
    h.db.update(station).set({ hosts_dispatch: true }).where(eq(station.id, fake.stationId)).run()
    const updated = await h.call('PATCH', `/v1/stations/${fake.stationId}`, { token: h.admin.token, body: { public_address: publicAddress } })
    assert.equal(updated.status, 200, updated.text)
  })

  after(async () => {
    await h.close()
  })

  test('the address serves both surfaces like the loopback publish and is a trusted origin for password sign-in', async () => {
    const origin = `https://${publicAddress}`
    assert.equal(h.deps.auth.surface.addressOrigin, origin)
    const signIn = await h.fetch(
      new Request(`${origin}/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin, 'x-forwarded-for': '198.51.100.7' },
        body: JSON.stringify({ email: adminEmail, password: adminPassword })
      })
    )
    assert.equal(signIn.status, 200, await signIn.clone().text())
    const health = await h.fetch(new Request(`${origin}/v1/healthz`, { headers: { 'x-forwarded-for': '198.51.100.7' } }))
    assert.equal(health.status, 200)
    const other = await h.fetch(new Request('https://203.0.113.9/v1/me', { headers: { 'x-forwarded-for': '198.51.100.7', authorization: `Bearer ${h.admin.token}` } }))
    assert.equal(other.status, 404)
  })
})
