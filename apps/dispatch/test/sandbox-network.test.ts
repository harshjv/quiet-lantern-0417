import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import { FakeRegistry } from './helpers/registry.ts'
import {
  createProject,
  createSandbox,
  createService,
  pinPlatform,
  waitForActive,
  waitForSandbox,
} from './helpers/seed.ts'

let h: Dispatch
let registry: FakeRegistry
let envId: string
let isolated: any
let joined: any
let open: any

const api = (method: string, path: string, body?: unknown) =>
  h.call(method, path, {
    token: h.admin.token,
    body,
  })
const explain = (query: Record<string, string>) =>
  api('GET', `/v1/environments/${envId}/network/explain?${new URLSearchParams(query).toString()}`)
const hopOf = (doc: any, name: string) => doc.hops.find((hop: any) => hop.hop === name)

before(async () => {
  registry = FakeRegistry.install()
  registry.publish('traefik/whoami:v1')
  h = await startDispatch()
  pinPlatform(h, {
    sandboxes: true,
  })
  await startFakeStation(h, 'station-1', {
    sandboxes: {},
    verdict: {
      verdict: 'accept',
      path: 'public_internet',
      rule: 'ip daddr != @private_ranges accept',
    },
  })
  const project = await createProject(h, 'boxes')
  envId = project.default_environment_id
  const web = await createService(h, envId, {
    name: 'web',
    ref: 'traefik/whoami:v1',
    ports: [
      {
        port: 3000,
      },
    ],
    deploy: true,
  })
  await waitForActive(h, web.id)
  isolated = await createSandbox(h, envId, {
    name: 'locked',
    egress: {
      mode: 'allowlist',
      domains: [
        {
          domain: 'registry.npmjs.org',
        },
        {
          domain: 'github.com',
          wildcard: true,
          ports: [443, 22],
        },
      ],
    },
  })
  joined = await createSandbox(h, envId, {
    name: 'joined',
    network: 'environment',
  })
  open = await createSandbox(h, envId, {
    name: 'open',
  })
  for (const box of [isolated, joined, open]) await waitForSandbox(h, box.id, 'running')
})

after(async () => {
  await h?.close()
  registry?.restore()
})

describe('explain from a sandbox', () => {
  test('a name the allowlist does not list is blocked at allowlist with DOMAIN_NOT_ALLOWED and a fix that extends the list', async () => {
    const reply = await explain({
      from: 'locked',
      to: 'example.com:443',
    })
    assert.equal(reply.status, 200, reply.text)
    const doc = reply.body
    assert.equal(doc.verdict, 'blocked')
    assert.equal(doc.phase, 'allowlist')
    assert.equal(doc.code, 'DOMAIN_NOT_ALLOWED')
    assert.equal(doc.entity.from, 'locked')
    assert.equal(hopOf(doc, 'dns').status, 'skipped')
    assert.equal(hopOf(doc, 'firewall').status, 'skipped')
    const fix = doc.fixes.find((f: any) => f.code === 'ALLOW_DOMAIN')
    assert.equal(fix.action.tool, 'update_sandbox')
    assert.equal(fix.action.input.sandbox, isolated.id)
    assert.deepEqual(
      fix.action.input.egress.domains.map((d: any) => d.domain),
      ['registry.npmjs.org', 'github.com', 'example.com'],
    )
    assert.equal(doc.details.path, 'domain_not_allowed')
  })

  test('a listed name on an unlisted port fails at allowlist and a wildcard match within three labels passes it', async () => {
    const port = (
      await explain({
        from: 'locked',
        to: 'registry.npmjs.org:80',
      })
    ).body
    assert.equal(port.code, 'DOMAIN_NOT_ALLOWED')
    assert.match(port.fixes[0].text, /add the port/)
    const deep = (
      await explain({
        from: 'locked',
        to: 'a.b.c.d.github.com:22',
      })
    ).body
    assert.equal(deep.code, 'DOMAIN_NOT_ALLOWED')
    const wildcard = (
      await explain({
        from: 'locked',
        to: 'api.github.com:22',
      })
    ).body
    assert.equal(hopOf(wildcard, 'allowlist').status, 'pass')
    assert.equal(hopOf(wildcard, 'allowlist').detail.matched, 'github.com')
  })

  test('a listed name that the resolver answered is judged by the sandbox verdict and ends at probe_required', async () => {
    const doc = (
      await explain({
        from: 'locked',
        to: 'registry.npmjs.org:443',
      })
    ).body
    assert.equal(hopOf(doc, 'source').status, 'pass')
    assert.equal(hopOf(doc, 'applied').status, 'pass')
    assert.equal(hopOf(doc, 'dns').status, 'pass')
    assert.equal(hopOf(doc, 'allowlist').status, 'pass')
    assert.equal(hopOf(doc, 'firewall').status, 'pass')
    assert.equal(hopOf(doc, 'probe_required').status, 'unknown')
    const probe = doc.fixes.find((f: any) => f.code === 'RUN_PROBE')
    assert.equal(probe.action.input.sandbox, isolated.id)
    assert.equal(probe.action.input.service, undefined)
  })

  test('an open sandbox has no allowlist hop and an isolated one gets NXDOMAIN for a .internal name with a join fix', async () => {
    const publicName = (
      await explain({
        from: 'open',
        to: 'registry.npmjs.org:443',
      })
    ).body
    assert.equal(hopOf(publicName, 'allowlist'), undefined)
    const internal = (
      await explain({
        from: 'open',
        to: 'web.internal',
      })
    ).body
    assert.equal(internal.verdict, 'broken')
    assert.equal(internal.phase, 'dns')
    assert.equal(internal.code, 'NAME_NOT_IN_ENVIRONMENT')
    const fix = internal.fixes.find((f: any) => f.code === 'JOIN_ENVIRONMENT')
    assert.deepEqual(fix.action, {
      tool: 'update_sandbox',
      input: {
        sandbox: open.id,
        network: 'environment',
      },
    })
  })

  test('a joined sandbox reaches a service through the Switch and reads the target service as a service source does', async () => {
    const doc = (
      await explain({
        from: 'joined',
        to: 'web.internal',
      })
    ).body
    assert.equal(doc.verdict, 'reachable', JSON.stringify(doc.hops))
    for (const name of ['source', 'applied', 'dns', 'firewall', 'switch', 'target', 'listening'])
      assert.equal(hopOf(doc, name).status, 'pass', name)
    assert.ok(Buffer.byteLength(JSON.stringify(doc)) < 8192)
  })

  test('a sandbox that is not running is a failed source hop and an unknown name is NETWORK_TARGET_INVALID', async () => {
    const stopped = await createSandbox(h, envId, {
      name: 'asleep',
      start: false,
    })
    const doc = (
      await explain({
        from: stopped.id,
        to: 'registry.npmjs.org:443',
      })
    ).body
    assert.equal(doc.phase, 'source')
    assert.equal(doc.code, 'TARGET_NOT_RUNNING')
    assert.deepEqual(doc.fixes[0].action, {
      tool: 'start_sandbox',
      input: {
        sandbox: stopped.id,
      },
    })
    const missing = await explain({
      from: 'nobody',
      to: 'web',
    })
    assert.equal(missing.status, 422)
    assert.ok(missing.body.error.details.candidates.includes('locked'))
  })
})

describe('probe from a sandbox', () => {
  test('a dns probe and a tcp probe come back with the sandbox name, are audited and are rate limited', async () => {
    const dns = await api('POST', `/v1/sandboxes/${isolated.id}/network/probe`, {
      to: 'registry.npmjs.org',
      kind: 'dns',
    })
    assert.equal(dns.status, 200, dns.text)
    assert.equal(dns.body.sandbox, 'locked')
    assert.equal(dns.body.service, undefined)
    assert.equal(dns.body.dns.rcode, 'NOERROR')
    const tcp = await api('POST', `/v1/sandboxes/${isolated.id}/network/probe`, {
      to: 'registry.npmjs.org:443',
    })
    assert.equal(tcp.status, 200, tcp.text)
    assert.equal(tcp.body.port, 443)
    assert.equal(tcp.body.tcp.result, 'connected')
    const audit = (await api('GET', `/v1/audit?action=network.probe&limit=10`)).body.items.filter(
      (a: any) => a.target?.id === isolated.id || a.entity?.id === isolated.id,
    )
    assert.ok(audit.length >= 2, JSON.stringify(audit))
    let limited = 0
    for (let i = 0; i < 6; i++)
      if (
        (
          await api('POST', `/v1/sandboxes/${isolated.id}/network/probe`, {
            to: 'registry.npmjs.org',
            kind: 'dns',
          })
        ).status === 429
      )
        limited++
    assert.ok(limited > 0)
  })

  test('a stopped sandbox is a state conflict and a bad target is NETWORK_TARGET_INVALID', async () => {
    const stopped = await createSandbox(h, envId, {
      name: 'probe-asleep',
      start: false,
    })
    const reply = await api('POST', `/v1/sandboxes/${stopped.id}/network/probe`, {
      to: 'example.com:443',
    })
    assert.equal(reply.status, 409)
    assert.equal(reply.body.error.code, 'SANDBOX_STATE_CONFLICT')
    const invalid = await api('POST', `/v1/sandboxes/${open.id}/network/probe`, {
      to: '10.0.0.1',
    })
    assert.equal(invalid.status, 422)
    assert.equal(invalid.body.error.code, 'NETWORK_TARGET_INVALID')
  })
})
