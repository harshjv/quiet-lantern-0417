import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { localOrigin, startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import { enrollFakeStation, FakeStation } from './helpers/fake-station.ts'
import { FakeRegistry } from './helpers/registry.ts'
import {
  createProject,
  createService,
  rows,
  seedLockfile,
  waitForDeployment,
} from './helpers/seed.ts'

let h: Dispatch
let registry: FakeRegistry
let station: FakeStation
let environmentId: string

before(async () => {
  registry = FakeRegistry.install()
  registry.publish('nginx:1.27')
  h = await startDispatch()
  seedLockfile(h)
  station = await startFakeStation(h)
  environmentId = (await createProject(h)).default_environment_id
})

after(async () => {
  await h.close()
  registry.restore()
})

const setStatus = (status: string, id = station.stationId) =>
  (
    h.db as unknown as { $client: { prepare(sql: string): { run(...p: unknown[]): unknown } } }
  ).$client
    .prepare('update station set status = ? where id = ?')
    .run(status, id)
const token = () => h.admin.token
const patch = (
  body: unknown,
  reference = station.stationId,
  auth: { token: string } | { cookie: string; origin: string } = {
    token: token(),
  },
) =>
  h.call('PATCH', `/v1/stations/${reference}`, {
    ...auth,
    body,
  })
const human = () => ({
  cookie: h.admin.cookie,
  origin: localOrigin,
})
const describeStation = async () =>
  (
    await h.call('GET', `/v1/stations/${station.stationId}?fields=*`, {
      token: token(),
    })
  ).body
const uncancelled = (doc: { deployments: Record<string, { cancel: unknown }> }) =>
  Object.values(doc.deployments).filter((d) => d.cancel === null).length
const issuePaths = (reply: { body: any }) =>
  reply.body.error.details.issues.map((i: { path: string }) => i.path)

describe('validation', () => {
  test('an empty body is refused', async () => {
    const reply = await patch({})

    assert.equal(reply.status, 400)
    assert.equal(reply.body.error.code, 'VALIDATION_FAILED')
    assert.deepEqual(issuePaths(reply), ['/'])
  })

  test('a public_address that is not IPv4 is refused', async () => {
    const reply = await patch({
      public_address: 'not-an-ip',
    })

    assert.equal(reply.status, 400)
    assert.deepEqual(issuePaths(reply), ['/public_address'])
  })

  test('a concurrency_cap below 1 or not an integer is refused', async () => {
    for (const concurrency_cap of [0, -1, 1.5]) {
      const reply = await patch({
        concurrency_cap,
      })

      assert.equal(reply.status, 400, String(concurrency_cap))
      assert.equal(reply.body.error.code, 'VALIDATION_FAILED')
    }

    assert.equal((await describeStation()).concurrency_cap, 2)
  })

  test('draining and intermittent must be booleans', async () => {
    assert.equal(
      (
        await patch({
          draining: 'yes',
        })
      ).status,
      400,
    )
    assert.equal(
      (
        await patch({
          intermittent: 1,
        })
      ).status,
      400,
    )
  })

  test('sleep_schedule is phase 2 and refused', async () => {
    const reply = await patch({
      sleep_schedule: {
        cron: '0 18 * * 1-5',
        timezone: 'UTC',
        concurrency: 'skip',
      },
    })

    assert.equal(reply.status, 400)
    assert.deepEqual(issuePaths(reply), ['/sleep_schedule'])
  })

  test('an unknown field is refused', async () => {
    assert.equal(
      (
        await patch({
          relay: true,
        })
      ).status,
      400,
    )
  })

  test('only an enrolled station can be drained', async () => {
    const added = await h.call('POST', '/v1/stations', {
      token: token(),
      body: {
        name: 'pending',
      },
    })
    const reply = await patch(
      {
        draining: true,
      },
      'pending',
    )

    assert.equal(reply.status, 400)
    assert.deepEqual(issuePaths(reply), ['/draining'])
    assert.equal(
      rows<{ status: string }>(
        h,
        'select status from station where id = ?',
        added.body.station.id,
      )[0]!.status,
      'enrolling',
    )
  })

  test('a scoped token without instance admin is refused', async () => {
    const reply = await h.call('PATCH', `/v1/stations/${station.stationId}`, {
      token: await scopedReadToken(),
      body: {
        concurrency_cap: 3,
      },
    })

    assert.equal(reply.status, 403)
  })

  test('a patch that changes nothing returns the station and writes no audit event', async () => {
    const before = rows(h, "select id from audit_event where action = 'station.update'").length
    const reply = await patch({
      concurrency_cap: 2,
      draining: false,
      intermittent: false,
    })

    assert.equal(reply.status, 200)
    assert.equal(
      rows(h, "select id from audit_event where action = 'station.update'").length,
      before,
    )
  })
})

const scopedReadToken = async () => {
  const minted = await h.call('POST', '/v1/tokens', {
    token: token(),
    body: {
      name: 'read-only',
      kind: 'scoped',
      scopes: [
        {
          project_id: '*',
          environment_id: '*',
          level: 'read',
        },
      ],
    },
  })

  return minted.body.key as string
}

describe('intermittent', () => {
  test('is stored, shown and sent to stationd in the generation', async () => {
    const reply = await patch({
      intermittent: true,
    })

    assert.equal(reply.status, 200, reply.text)
    assert.equal(reply.body.intermittent, true)
    assert.equal((await describeStation()).intermittent, true)
    const doc = await station.waitForGeneration((d) => d.station.intermittent === true)

    assert.equal(doc.station.intermittent, true)
  })

  test('false is sent in the generation', async () => {
    assert.equal(
      (
        await patch({
          intermittent: false,
        })
      ).status,
      200,
    )
    assert.equal(
      (await station.waitForGeneration((d) => d.station.intermittent === false)).station
        .intermittent,
      false,
    )
  })

  test('false on an asleep station makes it offline', async () => {
    const added = await h.call('POST', '/v1/stations', {
      token: token(),
      body: {
        name: 'napper',
        intermittent: true,
      },
    })

    setStatus('asleep', added.body.station.id)
    const reply = await patch(
      {
        intermittent: false,
      },
      'napper',
    )

    assert.equal(reply.status, 200, reply.text)
    assert.equal(reply.body.status, 'offline')
  })
})

describe('concurrency_cap', () => {
  test('is stored and sent to stationd in the generation', async () => {
    const reply = await patch({
      concurrency_cap: 5,
    })

    assert.equal(reply.status, 200, reply.text)
    assert.equal(reply.body.concurrency_cap, 5)
    assert.equal(
      (await station.waitForGeneration((d) => d.station.concurrency_cap === 5)).station
        .concurrency_cap,
      5,
    )
  })

  test('a cap of 1 admits one deployment at a time, and the queued one runs afterwards', async () => {
    assert.equal(
      (
        await patch({
          concurrency_cap: 1,
        })
      ).status,
      200,
    )
    await station.waitForGeneration((d) => d.station.concurrency_cap === 1)
    const mark = station.generations.length
    const created = await Promise.all(
      ['cap-a', 'cap-b', 'cap-c'].map((name) =>
        createService(h, environmentId, {
          name,
          ref: 'nginx:1.27',
          ports: [
            {
              port: 80,
            },
          ],
          deploy: true,
        }),
      ),
    )

    for (const svc of created) {
      await waitForDeployment(h, svc.deployments[0].id, 'active')
    }

    const seen = station.generations.slice(mark)

    assert.ok(seen.length > 0)

    for (const doc of seen) {
      assert.ok(
        uncancelled(doc) <= 1,
        `a generation carried ${uncancelled(doc)} deployments without cancel`,
      )
    }

    assert.ok(seen.some((d) => uncancelled(d) === 1))
  })

  test('raising the cap lets deployments share the station again', async () => {
    assert.equal(
      (
        await patch({
          concurrency_cap: 3,
        })
      ).status,
      200,
    )
    assert.equal(
      (await station.waitForGeneration((d) => d.station.concurrency_cap === 3)).station
        .concurrency_cap,
      3,
    )
  })
})

describe('draining', () => {
  let svc: any

  before(async () => {
    svc = await createService(h, environmentId, {
      name: 'drainee',
      ref: 'nginx:1.27',
      ports: [
        {
          port: 80,
        },
      ],
      deploy: true,
    })
    await waitForDeployment(h, svc.deployments[0].id, 'active')
  })

  test('draining true sets the flag, leaves the status online and survives heartbeats', async () => {
    const reply = await patch({
      draining: true,
    })

    assert.equal(reply.status, 200, reply.text)
    assert.equal(reply.body.draining, true)
    assert.equal(reply.body.status, 'online')
    const heartbeatsLater = Date.now() + 2500

    await station.waitFor(() => Date.now() > heartbeatsLater)
    const row = await describeStation()

    assert.deepEqual([row.status, row.draining], ['online', true])
    assert.equal(
      rows<{ draining: number }>(
        h,
        'select draining from station where id = ?',
        station.stationId,
      )[0]!.draining,
      1,
    )
    const listed = (
      await h.call('GET', '/v1/stations', {
        token: token(),
      })
    ).body.items.find((s: { id: string }) => s.id === station.stationId)

    assert.equal(listed.draining, true)
  })

  test('no new deployment is placed: deploy, redeploy and creating a deployed service refuse', async () => {
    const deploy = await h.call('POST', `/v1/services/${svc.id}/deployments`, {
      token: token(),
      body: {},
    })

    assert.equal(deploy.status, 503, deploy.text)
    assert.equal(deploy.body.error.code, 'STATION_OFFLINE')
    assert.equal(deploy.body.error.details.draining, true)
    assert.match(deploy.body.error.explanation, /draining/)
    const redeploy = await h.call('POST', `/v1/services/${svc.id}/redeploy`, {
      token: token(),
    })

    assert.equal(redeploy.body.error.code, 'STATION_OFFLINE')
    const created = await h.call('POST', `/v1/environments/${environmentId}/services`, {
      token: token(),
      body: {
        name: 'refused',
        kind: 'web',
        source: {
          type: 'image',
          ref: 'nginx:1.27',
        },
        ports: [
          {
            port: 80,
          },
        ],
        station_id: station.stationId,
        deploy_on_create: true,
      },
    })

    assert.equal(created.status, 400, created.text)
    assert.deepEqual(issuePaths(created), ['/station_id'])
    assert.equal(rows(h, "select id from service where name = 'refused'").length, 0)
  })

  test('services that are already running keep their current deployment and stay in the generation', async () => {
    const doc = station.generations.at(-1)!

    assert.ok(svc.id in doc.services)
    const fresh = await h.call('GET', `/v1/services/${svc.id}`, {
      token: token(),
    })

    assert.equal(fresh.body.desired_state, 'running')
  })

  test('draining false ends the drain and deployments are placed again', async () => {
    const reply = await patch({
      draining: false,
    })

    assert.equal(reply.status, 200, reply.text)
    assert.deepEqual([reply.body.status, reply.body.draining], ['online', false])
    const deploy = await h.call('POST', `/v1/services/${svc.id}/deployments`, {
      token: token(),
      body: {},
    })

    assert.equal(deploy.status, 201, deploy.text)
  })
})

describe('under platform.protected', () => {
  before(async () => {
    const set = await h.call('PATCH', '/v1/settings', {
      ...human(),
      body: {
        'platform.protected': true,
      },
    })

    assert.equal(set.status, 200, set.text)
  })

  after(async () => {
    const set = await h.call('PATCH', '/v1/settings', {
      ...human(),
      body: {
        'platform.protected': false,
      },
    })

    assert.equal(set.status, 200, set.text)
  })

  test('a token stages one entry per changed field and nothing applies', async () => {
    const before = await describeStation()

    assert.deepEqual(
      [before.concurrency_cap, before.intermittent, before.draining],
      [3, false, false],
    )
    const reply = await patch({
      concurrency_cap: 4,
      draining: true,
      intermittent: true,
    })

    assert.equal(reply.status, 202, reply.text)
    assert.equal(reply.body.status, 'staged')
    assert.equal(reply.body.environment_id, null)
    const staged = (
      await h.call('GET', `/v1/staged-changes/${reply.body.id}?fields=changes`, {
        token: token(),
      })
    ).body

    assert.deepEqual(
      staged.changes.map((c: any) => [c.entity, c.path, c.before, c.after]),
      [
        ['station', '/concurrency_cap', 3, 4],
        ['station', '/draining', false, true],
        ['station', '/intermittent', false, true],
      ],
    )
    const after = await describeStation()

    assert.equal(after.concurrency_cap, before.concurrency_cap)
    assert.equal(after.draining, false)
  })

  test('a token cannot accept it; a human accepts and every field applies', async () => {
    const staged = (
      await h.call('GET', '/v1/staged-changes?status=staged&scope=instance', {
        token: token(),
      })
    ).body.items[0]
    const byToken = await h.call('POST', `/v1/staged-changes/${staged.id}/accept`, {
      token: token(),
    })

    assert.equal(byToken.body.error.code, 'PROTECTED_ENVIRONMENT')
    const accepted = await h.call('POST', `/v1/staged-changes/${staged.id}/accept`, human())

    assert.equal(accepted.status, 200, accepted.text)
    const row = await describeStation()

    assert.equal(row.concurrency_cap, 4)
    assert.equal(row.draining, true)
    assert.equal(row.intermittent, true)
    assert.equal(
      (
        await station.waitForGeneration(
          (d) => d.station.concurrency_cap === 4 && d.station.intermittent === true,
        )
      ).station.concurrency_cap,
      4,
    )
  })

  test('a rejected change applies nothing', async () => {
    const reply = await patch({
      draining: false,
      concurrency_cap: 2,
    })

    assert.equal(reply.status, 202)
    const rejected = await h.call('POST', `/v1/staged-changes/${reply.body.id}/reject`, {
      ...human(),
      body: {
        reason: 'no',
      },
    })

    assert.equal(rejected.status, 200)
    const row = await describeStation()

    assert.equal(row.draining, true)
    assert.equal(row.concurrency_cap, 4)
  })

  test('a human applies it directly', async () => {
    const reply = await patch(
      {
        draining: false,
        concurrency_cap: 2,
        intermittent: false,
      },
      station.stationId,
      human(),
    )

    assert.equal(reply.status, 200, reply.text)
    const row = await describeStation()

    assert.deepEqual([row.draining, row.concurrency_cap, row.intermittent], [false, 2, false])
  })
})

describe('a drain across a lost heartbeat', () => {
  const name = 'wanderer'
  let keys: Awaited<ReturnType<typeof enrollFakeStation>>
  let url: string
  let wanderer: FakeStation

  const stationRow = () =>
    rows<{ status: string; draining: number }>(
      h,
      'select status, draining from station where id = ?',
      keys.station_id,
    )[0]!
  const backdate = () =>
    (
      h.db as unknown as { $client: { prepare(sql: string): { run(...p: unknown[]): unknown } } }
    ).$client
      .prepare('update station set last_seen_at = ? where id = ?')
      .run(Date.now() - 10 * 60_000, keys.station_id)
  const placeOnWanderer = () =>
    h.call('POST', `/v1/environments/${environmentId}/services`, {
      token: token(),
      body: {
        name: `placed-${Date.now()}`,
        kind: 'web',
        source: {
          type: 'image',
          ref: 'nginx:1.27',
        },
        ports: [
          {
            port: 80,
          },
        ],
        station_id: keys.station_id,
        deploy_on_create: true,
      },
    })

  before(async () => {
    url = await h.stationUrl()
    const added = await h.call('POST', '/v1/stations', {
      token: token(),
      body: {
        name,
      },
    })

    keys = await enrollFakeStation(url, added.body.enroll_token as string)
    wanderer = await FakeStation.start(url, keys)
    h.fakeStations.push(wanderer)
    await wanderer.waitFor(() => stationRow().status === 'online', 5000, 'the station online')
  })

  test('a draining station that goes offline and comes back is still draining', async () => {
    const drained = await patch(
      {
        draining: true,
      },
      name,
    )

    assert.equal(drained.status, 200, drained.text)
    await wanderer.close()
    await wanderer.waitFor(
      () => {
        backdate()

        return stationRow().status === 'offline'
      },
      15_000,
      'the station offline',
    )
    assert.equal(stationRow().draining, 1)
    const whileOffline = (
      await h.call('GET', `/v1/stations/${name}`, {
        token: token(),
      })
    ).body

    assert.deepEqual([whileOffline.status, whileOffline.draining], ['offline', true])

    wanderer = await FakeStation.start(url, keys)
    h.fakeStations.push(wanderer)
    await wanderer.waitFor(() => stationRow().status === 'online', 5000, 'the station back online')
    const back = (
      await h.call('GET', `/v1/stations/${name}`, {
        token: token(),
      })
    ).body

    assert.deepEqual([back.status, back.draining], ['online', true])
  })

  test('placement still refuses the station after it returns', async () => {
    const refused = await placeOnWanderer()

    assert.equal(refused.status, 400, refused.text)
    assert.deepEqual(issuePaths(refused), ['/station_id'])
    assert.match(refused.body.error.details.issues[0].message, /draining/)
  })

  test('draining can be set and cleared while the station is offline', async () => {
    await wanderer.close()
    await wanderer.waitFor(
      () => {
        backdate()

        return stationRow().status === 'offline'
      },
      15_000,
      'the station offline',
    )
    assert.equal(
      (
        await patch(
          {
            draining: false,
          },
          name,
        )
      ).status,
      200,
    )
    assert.equal(stationRow().draining, 0)
    assert.equal(
      (
        await patch(
          {
            draining: true,
          },
          name,
        )
      ).status,
      200,
    )
    assert.deepEqual(stationRow(), {
      status: 'offline',
      draining: 1,
    })
  })
})
