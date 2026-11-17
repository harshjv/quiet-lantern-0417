import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { localOrigin, startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import type { FakeStation } from './helpers/fake-station.ts'
import { FakeRegistry } from './helpers/registry.ts'
import {
  approveWaiting,
  createApp,
  createPreview,
  createProject,
  pinPlatform,
  placed,
  productionId,
  waitForActive,
} from './helpers/seed.ts'

let h: Dispatch
let registry: FakeRegistry
let station: FakeStation
let project: any
let prod: string
let staging: string
let web: any
let db: any
let api: any
let stagingWeb: any

const get = (path: string) =>
  h.call('GET', path, {
    token: h.admin.token,
  })
const post = (path: string, body: unknown) =>
  h.call('POST', path, {
    token: h.admin.token,
    body,
  })
const probe = (path: string, body: unknown) =>
  h.call('POST', path, {
    cookie: h.admin.cookie,
    origin: localOrigin,
    body,
  })
const explain = (query: Record<string, string>) =>
  get(placed(h, prod, `network/explain?${new URLSearchParams(query).toString()}`))

before(async () => {
  registry = FakeRegistry.install()
  registry.publish('traefik/whoami:v1')
  registry.publish('postgres:16')
  h = await startDispatch()
  pinPlatform(h)
  station = await startFakeStation(h)
  project = await createProject(h, 'net')
  prod = productionId(h, project.id)
  staging = (await createPreview(h, 'net', 'staging')).id
  db = await createApp(h, prod, {
    name: 'db',
    ref: 'postgres:16',
    ports: [
      {
        port: 5432,
        protocol: 'tcp',
      },
    ],
    deploy: true,
  })
  web = await createApp(h, prod, {
    name: 'web',
    ref: 'traefik/whoami:v1',
    ports: [
      {
        port: 3000,
      },
    ],
    keys: [
      {
        name: 'DATABASE_URL',
        kind: 'reference',
        reference: 'postgres://app@${{db.HOST}}:5432/app',
      },
    ],
    deploy: true,
  })
  api = await createApp(h, staging, {
    name: 'api',
    ref: 'traefik/whoami:v1',
    ports: [
      {
        port: 8080,
      },
    ],
    deploy: true,
  })
  stagingWeb = await createApp(h, staging, {
    name: 'web',
    ref: 'traefik/whoami:v1',
    ports: [
      {
        port: 3000,
      },
    ],
    deploy: true,
  })

  for (const svc of [db, web, api, stagingWeb]) {
    await waitForActive(h, svc.id)
  }

  station.report()
})

after(async () => {
  await h?.close()
  registry?.restore()
})

describe('network map', () => {
  test('lists apps with <app>.internal names, unique virtual IPs, switch targets and the documented paths', async () => {
    const reply = await get(placed(h, prod, `network`))

    assert.equal(reply.status, 200)
    const map = reply.body

    assert.equal(map.project_id, project.id)
    assert.equal(map.preview, null)
    assert.equal(map.virtual_prefix, '100.64.0.0/16')
    assert.deepEqual(
      map.apps.map((s: any) => s.dns),
      ['db.internal', 'web.internal'],
    )
    const vips = map.apps.map((s: any) => s.virtual_ip)

    assert.equal(new Set(vips).size, 2)

    for (const s of map.apps) {
      assert.equal(s.switch.state, 'serving')
      assert.match(s.switch.deployment.address, /^10\.200\.\d+\.\d+$/)
    }

    assert.equal(map.subnets.length, 1)
    assert.match(map.subnets[0].subnet, /^10\.200\.\d+\.0\/24$/)
    assert.equal(map.subnets[0].resolver, `${map.subnets[0].gateway}:53`)
    assert.deepEqual(
      map.paths.map((p: any) => [p.path, p.verdict]),
      [
        ['same_environment', 'allowed'],
        ['resolver', 'allowed'],
        ['loopback', 'allowed'],
        ['host_address', 'blocked'],
        ['other_environment', 'blocked'],
        ['cloud_metadata', 'blocked'],
        ['private_range', 'blocked'],
        ['public_internet', 'allowed'],
        ['no_switch_target', 'rejected'],
        ['inbound_domain', 'allowed'],
        ['inbound_tcp', 'allowed'],
        ['inbound_other', 'blocked'],
      ],
    )
  })

  test('records the reference from web to db as an edge', async () => {
    const map = (await get(placed(h, prod, `network`))).body

    assert.deepEqual(map.edges, [
      {
        from: 'web',
        to: 'db',
        kind: 'reference',
        keys: ['DATABASE_URL'],
      },
    ])
  })

  test('the same app name in a preview has its own subnet and virtual IP', async () => {
    const other = (await get(placed(h, staging, `network`))).body
    const mine = (await get(placed(h, prod, `network`))).body

    assert.notEqual(other.subnets[0].subnet, mine.subnets[0].subnet)
    const stagedWeb = other.apps.find((s: any) => s.name === 'web')

    assert.equal(stagedWeb.dns, 'web.internal')
    assert.notEqual(stagedWeb.virtual_ip, mine.apps.find((s: any) => s.name === 'web').virtual_ip)
    assert.ok(!other.apps.some((s: any) => s.name === 'db'))
  })

  test('is reachable by project and preview name and can be narrowed to one app', async () => {
    const reply = await get('/v1/projects/net/network?app=web')

    assert.equal(reply.status, 200)
    assert.equal(reply.body.project_id, project.id)
    assert.equal(reply.body.preview, null)
    const named = await get('/v1/projects/net/network?preview=staging')

    assert.deepEqual(named.body.preview, {
      id: staging,
      name: 'staging',
    })
    assert.deepEqual(
      reply.body.apps.map((s: any) => s.name),
      ['db', 'web'],
    )
    const alone = await get(`/v1/projects/net/network?app=db`)

    assert.deepEqual(
      alone.body.apps.map((s: any) => s.name),
      ['db', 'web'],
    )
  })

  test('an unknown preview is NOT_FOUND', async () => {
    const reply = await get('/v1/projects/net/network?preview=env_00000000000000000000000000')

    assert.equal(reply.status, 404)
    assert.equal(reply.body.error.code, 'NOT_FOUND')
  })
})

describe('network explain', () => {
  test('an app reaching another by <app>.internal passes every hop', async () => {
    const reply = await explain({
      from: 'web',
      to: 'db.internal',
      port: '5432',
    })

    assert.equal(reply.status, 200)
    assert.equal(reply.body.verdict, 'reachable')
    assert.deepEqual(reply.body.entity, {
      type: 'path',
      from: 'web',
      to: 'db.internal:5432/tcp',
    })
    assert.deepEqual(
      reply.body.hops.map((hop: any) => [hop.hop, hop.status]),
      [
        ['source', 'pass'],
        ['applied', 'pass'],
        ['dns', 'pass'],
        ['firewall', 'pass'],
        ['switch', 'pass'],
        ['target', 'pass'],
        ['listening', 'pass'],
        ['port', 'pass'],
      ],
    )
    const dns = reply.body.hops.find((hop: any) => hop.hop === 'dns')

    assert.equal(dns.detail.name, 'db.internal')
    assert.match(dns.detail.answer, /^100\.64\./)
    assert.equal(
      reply.body.hops.find((hop: any) => hop.hop === 'firewall').detail.path,
      'same_environment',
    )
  })

  test('a bare app name resolves to the same path as its .internal name', async () => {
    const reply = await explain({
      from: 'web',
      to: 'db:5432',
    })

    assert.equal(reply.status, 200)
    assert.equal(reply.body.verdict, 'reachable')
    assert.equal(reply.body.entity.to, 'db:5432/tcp')
  })

  test('a name that belongs to a preview fails at dns with NAME_NOT_IN_NETWORK', async () => {
    const reply = await explain({
      from: 'web',
      to: 'api.internal',
      port: '8080',
    })

    assert.equal(reply.status, 200)
    assert.notEqual(reply.body.verdict, 'reachable')
    const dns = reply.body.hops.find((hop: any) => hop.hop === 'dns')

    assert.equal(dns.status, 'fail')
    assert.equal(dns.code, 'NAME_NOT_IN_NETWORK')
    assert.equal(dns.detail.rcode, 'NXDOMAIN')
    assert.ok(reply.body.fixes.some((f: any) => f.code === 'USE_INTERNAL_NAME'))
  })

  test('an app of a preview named without .internal is NETWORK_TARGET_INVALID with candidates', async () => {
    const reply = await explain({
      from: 'web',
      to: 'api',
      port: '8080',
    })

    assert.equal(reply.status, 422)
    assert.equal(reply.body.error.code, 'NETWORK_TARGET_INVALID')
    assert.deepEqual(reply.body.error.details.candidates.sort(), ['db', 'web'])
  })

  test('a source outside production is NETWORK_TARGET_INVALID', async () => {
    const reply = await explain({
      from: 'api',
      to: 'db',
      port: '5432',
    })

    assert.equal(reply.status, 422)
    assert.equal(reply.body.error.code, 'NETWORK_TARGET_INVALID')
    assert.equal(reply.body.error.details.field, 'from')
  })

  test('an app with several ports needs one named', async () => {
    const project2 = await createProject(h, 'net-multi')
    const multi = await createApp(h, productionId(h, project2.id), {
      name: 'multi',
      ref: 'traefik/whoami:v1',
      ports: [
        {
          port: 80,
        },
        {
          port: 81,
        },
      ],
      deploy: false,
    })
    const reply = await get(
      placed(h, productionId(h, project2.id), `network/explain?from=multi&to=multi`),
    )

    assert.equal(reply.status, 422)
    assert.deepEqual(reply.body.error.details.candidates, [80, 81])
    assert.equal(multi.name, 'multi')
  })

  test('a firewall drop reports the path that dropped it and fails the verdict', async () => {
    station.config.verdict = {
      verdict: 'drop',
      path: 'other_environment',
      rule: 'ip daddr @private_ranges drop',
    }

    try {
      const reply = await explain({
        from: 'web',
        to: 'db:5432',
      })

      assert.equal(reply.status, 200)
      const firewall = reply.body.hops.find((hop: any) => hop.hop === 'firewall')

      assert.equal(firewall.status, 'fail')
      assert.equal(firewall.code, 'PATH_BLOCKED')
      assert.equal(firewall.detail.path, 'other_environment')
      assert.notEqual(reply.body.verdict, 'reachable')
    } finally {
      delete station.config.verdict
    }
  })

  test('from = internet to a hostname that no domain routes is NETWORK_TARGET_INVALID', async () => {
    const reply = await explain({
      from: 'internet',
      to: 'nowhere.shop.example.com',
    })

    assert.equal(reply.status, 422)
    assert.equal(reply.body.error.code, 'NETWORK_TARGET_INVALID')
  })

  test('from = internet to a domain that is not serving yet is not reachable and says why', async () => {
    pinPlatform(h, {
      gateway: true,
    })
    const added = await approveWaiting(
      h,
      await post(`/v1/ports/${web.ports[0].id}/domains`, {
        hostname: 'web.net.example.com',
      }),
    )

    assert.equal(added.status, 200, added.text)
    const reply = await explain({
      from: 'internet',
      to: 'web.net.example.com',
    })

    assert.equal(reply.status, 200)
    assert.equal(reply.body.verdict, 'broken')
    assert.equal(reply.body.code, 'NO_PUBLIC_ADDRESS')
    assert.deepEqual(reply.body.hops.map((hop: any) => hop.code ?? null).filter(Boolean), [
      'DOMAIN_NOT_ACTIVE',
      'NO_PUBLIC_ADDRESS',
      'WEB_PORTS_CLOSED',
      'CERTIFICATE_NOT_VALID',
      'ROUTE_NOT_APPLIED',
    ])
  })

  test('protocol and port validation', async () => {
    assert.equal(
      (
        await explain({
          from: 'web',
          to: 'db:5432',
          port: '5433',
        })
      ).status,
      422,
    )
    assert.equal(
      (
        await explain({
          from: 'web',
          to: 'db',
          port: '70000',
        })
      ).status,
      400,
    )
    assert.equal(
      (
        await explain({
          from: 'web',
        })
      ).status,
      400,
    )
  })

  test('requires a credential', async () => {
    const reply = await h.call('GET', placed(h, prod, `network/explain?from=web&to=db:5432`))

    assert.equal(reply.status, 401)
    assert.equal(reply.body.error.code, 'UNAUTHENTICATED')
  })
})

describe('network probe', () => {
  test('a tcp probe from inside an app returns the station result and its firewall verdict', async () => {
    const reply = await probe(`/v1/apps/${web.id}/network/probe`, {
      to: 'db.internal',
      port: 5432,
    })

    assert.equal(reply.status, 200)
    assert.equal(reply.body.app, 'web')
    assert.equal(reply.body.kind, 'tcp')
    assert.equal(reply.body.to, 'db.internal')
    assert.equal(reply.body.port, 5432)
    assert.equal(reply.body.tcp.result, 'connected')
    assert.deepEqual(reply.body.verdict, {
      verdict: 'accept',
      path: 'same_environment',
    })
    const asToken = await post(`/v1/apps/${web.id}/network/probe`, {
      to: 'db.internal',
      port: 5432,
    })

    assert.equal(asToken.status, 202, asToken.text)
    assert.equal(asToken.body.status, 'waiting')
  })

  test('a dns probe returns the resolver answer', async () => {
    const reply = await probe(`/v1/apps/${web.id}/network/probe`, {
      to: 'db.internal',
      kind: 'dns',
    })

    assert.equal(reply.status, 200)
    assert.equal(reply.body.dns.rcode, 'NOERROR')
    assert.deepEqual(reply.body.dns.answers, ['100.64.0.2'])
  })

  test('is audited with the actor and target', async () => {
    const audit = await get(`/v1/audit?action=network.probe`)

    assert.equal(audit.status, 200)
    assert.ok(audit.body.items.length >= 1)
    assert.equal(audit.body.items[0].target.id, web.id)
  })

  test('rejects an out-of-range timeout', async () => {
    const reply = await probe(`/v1/apps/${web.id}/network/probe`, {
      to: 'db.internal',
      port: 5432,
      timeout_s: 9999,
    })

    assert.equal(reply.status, 400)
    assert.equal(reply.body.error.code, 'VALIDATION_FAILED')
  })

  test('a read token cannot probe', async () => {
    const { mintToken } = await import('./helpers/dispatch.ts')
    const key = await mintToken(h, [
      {
        project_id: project.id,
        target: 'production',
        level: 'read',
      },
    ])
    const reply = await h.call('POST', `/v1/apps/${web.id}/network/probe`, {
      token: key,
      body: {
        to: 'db.internal',
        port: 5432,
      },
    })

    assert.equal(reply.status, 403)
    assert.equal(reply.body.error.code, 'FORBIDDEN_SCOPE')
  })

  test('probes are rate limited per app', async () => {
    const limited = await createApp(h, prod, {
      name: 'limited',
      ref: 'traefik/whoami:v1',
      ports: [
        {
          port: 3000,
        },
      ],
      deploy: true,
    })

    await waitForActive(h, limited.id)
    const statuses: number[] = []

    for (let i = 0; i < 8; i++) {
      statuses.push(
        (
          await probe(`/v1/apps/${limited.id}/network/probe`, {
            to: 'db.internal',
            port: 5432,
          })
        ).status,
      )
    }

    assert.deepEqual(statuses.slice(0, 6), [200, 200, 200, 200, 200, 200])
    assert.equal(statuses[6], 429)
    const again = await probe(`/v1/apps/${limited.id}/network/probe`, {
      to: 'db.internal',
      port: 5432,
    })

    assert.equal(again.body.error.code, 'RATE_LIMITED')
    assert.ok(Number(again.headers.get('retry-after')) >= 1)
  })
})

describe('connections and dns log', () => {
  test('connections group live flows by peer with app peers named', async () => {
    const reply = await get(`/v1/apps/${web.id}/connections`)

    assert.equal(reply.status, 200)
    assert.deepEqual(reply.body.app, {
      id: web.id,
      name: 'web',
    })
    const text = JSON.stringify(reply.body)

    assert.ok(text.includes('example.com'))
    assert.ok(text.includes('host_address'))
  })

  test('the dns log carries the resolver ring as untrusted data', async () => {
    const reply = await get(`/v1/apps/${web.id}/dns-log?tail=5`)

    assert.equal(reply.status, 200)
    assert.equal(reply.body.untrusted.source, 'resolver log')
    assert.equal(reply.body.untrusted.entries[0].name, 'db.internal')
    assert.equal(reply.body.untrusted.entries[0].rcode, 'NOERROR')
  })

  test('tail is bounded', async () => {
    assert.equal((await get(`/v1/apps/${web.id}/dns-log?tail=0`)).status, 400)
    assert.equal((await get(`/v1/apps/${web.id}/dns-log?tail=201`)).status, 400)
  })
})

describe('station offline', () => {
  test('connections, dns log and probe answer SERVER_OFFLINE and the map and explain mark facts stale', async () => {
    await station.close()
    await station.waitFor(() => !h.deps.stations.isConnected(station.stationId), 3000, 'disconnect')

    for (const reply of [
      await get(`/v1/apps/${web.id}/connections`),
      await get(`/v1/apps/${web.id}/dns-log`),
      await probe(`/v1/apps/${web.id}/network/probe`, {
        to: 'db.internal',
        port: 5432,
      }),
    ]) {
      assert.equal(reply.status, 503)
      assert.equal(reply.body.error.code, 'SERVER_OFFLINE')
    }

    const map = await get(placed(h, prod, `network`))

    assert.equal(map.status, 200)
    assert.equal(map.body.subnets[0].stale, true)
    const reply = await explain({
      from: 'web',
      to: 'db:5432',
    })

    assert.equal(reply.status, 200)
    const source = reply.body.hops.find((hop: any) => hop.hop === 'source')

    assert.equal(source.status, 'unknown')
    assert.equal(source.code, 'SERVER_STALE')
    assert.notEqual(reply.body.verdict, 'reachable')
  })
})
