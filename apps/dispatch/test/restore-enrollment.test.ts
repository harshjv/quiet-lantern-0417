import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { setupInstance } from '../src/auth/bootstrap.ts'
import { openDb } from '../src/db/client.ts'
import { audit_event, station } from '../src/db/schema.ts'
import { adminEmail, adminPassword, startDispatch, type Dispatch } from './helpers/dispatch.ts'
import { enrollFakeStation, FakeStation } from './helpers/fake-station.ts'

const bootstrapToken = `sly-enroll-${randomBytes(12).toString('base64url')}`

describe('a restored Dispatch takes the new host as its station', () => {
  let h: Dispatch
  let url: string
  let first: { station_id: string; key: string }

  before(async () => {
    process.env.STATIONLY_BOOTSTRAP_ENROLL_SHA256 = createHash('sha256').update(bootstrapToken).digest('hex')
    h = await startDispatch()
    url = await h.stationUrl()
  })

  after(async () => {
    delete process.env.STATIONLY_BOOTSTRAP_ENROLL_SHA256
    await h.close()
  })

  const hosting = () => h.db.select().from(station).all().filter(s => s.hosts_dispatch && !s.revoked_at)

  test('the bootstrap token enrolls the first host', async () => {
    first = await enrollFakeStation(url, bootstrapToken)
    assert.deepEqual(
      hosting().map(s => s.id),
      [first.station_id]
    )
  })

  test('the bootstrap token is refused while the hosting station is connected', async () => {
    const live = await FakeStation.start(url, first)
    h.fakeStations.push(live)
    await assert.rejects(enrollFakeStation(url, bootstrapToken), /enrollment answered/)
    assert.deepEqual(
      hosting().map(s => s.id),
      [first.station_id]
    )
    await live.close()
    h.fakeStations.length = 0
    await new Promise(resolve => setTimeout(resolve, 100))
  })

  test('after a restore nothing is connected, so the bootstrap token replaces the dead hosting station', async () => {
    const fresh = await enrollFakeStation(url, bootstrapToken)
    const rows = h.db.select().from(station).all()
    const old = rows.find(s => s.id === first.station_id)!
    assert.equal(old.hosts_dispatch, false)
    assert.equal(old.status, 'offline')
    assert.notEqual(old.revoked_at, null)
    assert.deepEqual(
      hosting().map(s => s.id),
      [fresh.station_id]
    )
  })

  test('any other token is still refused', async () => {
    await assert.rejects(enrollFakeStation(url, 'sly-enroll-not-the-token'), /enrollment answered/)
  })
})

describe('setup stores the station public address', () => {
  let h: Dispatch
  let hostId: string

  before(async () => {
    process.env.STATIONLY_BOOTSTRAP_ENROLL_SHA256 = createHash('sha256').update(bootstrapToken).digest('hex')
    h = await startDispatch({ setup: false })
    hostId = (await enrollFakeStation(await h.stationUrl(), bootstrapToken)).station_id
  })

  after(async () => {
    delete process.env.STATIONLY_BOOTSTRAP_ENROLL_SHA256
    await h.close()
  })

  const setup = (publicAddress: string, actorId: string) =>
    setupInstance({ db: h.deps.db, keyring: h.deps.keyring, auth: h.deps.auth }, { email: adminEmail, password: adminPassword, public_address: publicAddress }, { type: 'station', id: actorId, client: 'test' })

  const created = () => h.db.select().from(audit_event).where(eq(audit_event.action, 'setup.admin_created')).all().length

  test('an address that is not IPv4 creates nothing', async () => {
    await assert.rejects(setup('10.0.0.999', hostId), /not an IPv4 address/)
    assert.equal(created(), 0)
  })

  test('an actor that is not the hosting station creates nothing', async () => {
    await assert.rejects(setup('203.0.113.7', 'stn_missing'), /needs the station that hosts Dispatch/)
    assert.equal(created(), 0)
  })

  test('the hosting station gets the address in the same transaction as the admin', async () => {
    const out = await setup('203.0.113.7', hostId)
    assert.equal(out.public_address, '203.0.113.7')
    assert.equal(h.db.select().from(station).where(eq(station.id, hostId)).get()!.public_address, '203.0.113.7')
    assert.equal(created(), 1)
  })
})

describe('the database is opened for Litestream', () => {
  test('a replicated database never autocheckpoints and always waits for locks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sly-pragmas-'))
    try {
      const replicated = openDb(join(dir, 'a.sqlite'), { replicated: true }).$client
      assert.equal(replicated.pragma('wal_autocheckpoint', { simple: true }), 0)
      assert.equal(replicated.pragma('busy_timeout', { simple: true }), 5000)
      assert.equal(replicated.pragma('journal_mode', { simple: true }), 'wal')
      const plain = openDb(join(dir, 'b.sqlite')).$client
      assert.equal(plain.pragma('wal_autocheckpoint', { simple: true }), 1000)
      assert.equal(plain.pragma('busy_timeout', { simple: true }), 5000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
