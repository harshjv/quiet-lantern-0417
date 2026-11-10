import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { eq } from 'drizzle-orm'
import { run, sandbox } from '../src/db/schema.ts'
import { newId } from '../src/db/ids.ts'
import { mintToken, startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import type { FakeStation } from './helpers/fake-station.ts'
import { createProject, createSandbox, createService, pinPlatform, rows, waitForSandbox } from './helpers/seed.ts'
import { FakeRegistry } from './helpers/registry.ts'

let h: Dispatch
let registry: FakeRegistry
let station: FakeStation
let project: any
let envId: string
let deployToken: string
let readToken: string
let boxId: string

const api = (method: string, path: string, body?: unknown, token = h.admin.token) => h.call(method, path, { token, body })

const secret = 'ghp_projectsecret0123456789'
const sealed = 'sealed-value-0123456789abcdef'
const plain = 'plain-literal-value-98765'

before(async () => {
  registry = FakeRegistry.install()
  registry.publish('nginx:1.27')
  registry.publish('alpine:3.20')
  h = await startDispatch()
  pinPlatform(h, { sandboxes: true })
  station = await startFakeStation(h, 'station-1', { sandboxes: { runOutput: (command, env) => [`$ ${command.join(' ')}`, `env ${JSON.stringify(env)}`] } })
  project = await createProject(h, 'alpha')
  envId = project.default_environment_id
  deployToken = await mintToken(h, [{ project_id: project.id, environment_id: '*', level: 'deploy' }], 'deployer')
  readToken = await mintToken(h, [{ project_id: project.id, environment_id: '*', level: 'read' }], 'reader')
  const box = await createSandbox(h, envId, { name: 'worker' })
  boxId = box.id
  await waitForSandbox(h, boxId, 'running')
})

after(async () => {
  await h.close()
  registry.restore()
})

const exec = (body: Record<string, unknown>, token = h.admin.token, id = boxId) => api('POST', `/v1/sandboxes/${id}/exec`, body, token)

const dump = () => JSON.stringify([rows(h, 'select * from run'), rows(h, 'select * from audit_event'), rows(h, 'select * from event'), rows(h, 'select * from staged_change')])

describe('exec', () => {
  test('a command runs through stationd and returns its run with untrusted output', async () => {
    const reply = await exec({ command: ['echo', 'hello'], cwd: '/root', user: 'agent', timeout_s: 900 })
    assert.equal(reply.status, 201, reply.text)
    const body = reply.body
    assert.equal(body.kind, 'exec')
    assert.equal(body.sandbox_id, boxId)
    assert.equal(body.service_id, null)
    assert.equal(body.deployment_id, null)
    assert.equal(body.status, 'succeeded')
    assert.equal(body.exit_code, 0)
    assert.deepEqual(body.output.untrusted.source, 'sandbox exec output')
    assert.match(body.output.untrusted.text, /^stdout: \$ echo hello\n/)
    assert.equal(body.output.truncated, false)
    const sent = station.received.filter(m => m.type === 'run.start' && (m.body as any).run_id === body.id)[0]!.body as any
    assert.deepEqual([sent.service_id, sent.deployment_id, sent.sandbox_id, sent.kind, sent.user, sent.cwd, sent.timeout_s, sent.attach, sent.tty], [null, null, boxId, 'exec', 'agent', '/root', 900, false, false])
    const again = await api('GET', `/v1/runs/${body.id}?wait_s=1`)
    assert.equal(again.body.status, 'succeeded')
    assert.match(again.body.output.untrusted.text, /echo hello/)
  })

  test('a non-zero exit fails the run with EXIT_NONZERO and a diagnosis', async () => {
    const reply = await exec({ command: ['false'] })
    assert.equal(reply.body.status, 'failed')
    assert.equal(reply.body.exit_code, 1)
    assert.equal(reply.body.failure.code, 'EXIT_NONZERO')
    const diagnosis = await api('GET', `/v1/runs/${reply.body.id}/diagnosis`)
    assert.equal(diagnosis.status, 200, diagnosis.text)
    assert.equal(diagnosis.body.entity.id, reply.body.id)
  })

  test('a sandbox that is not running refuses exec and shells with SANDBOX_NOT_RUNNING naming start_sandbox', async () => {
    const cold = await createSandbox(h, envId, { name: 'cold', start: false })
    for (const [path, body] of [[`/v1/sandboxes/${cold.id}/exec`, { command: ['true'] }], [`/v1/sandboxes/${cold.id}/shells`, {}]] as const) {
      const reply = await api('POST', path, body)
      assert.equal(reply.status, 409)
      assert.equal(reply.body.error.code, 'SANDBOX_NOT_RUNNING')
      assert.equal(reply.body.error.details.status, 'stopped')
      assert.match(reply.body.error.fix, /start_sandbox/)
    }
  })

  test('env values reach stationd in a run delivery and are never stored, logged or audited', async () => {
    const value = 'exec-env-secret-5566778899'
    const reply = await exec({ command: ['printenv'], env: { EXEC_SECRET: value, CI: '1' }, wait_s: 10 })
    assert.equal(reply.status, 201, reply.text)
    const delivery = station.secrets.find(s => s.target.run_id === reply.body.id)!
    assert.equal(delivery.purpose, 'run')
    assert.deepEqual(delivery.values, { EXEC_SECRET: value, CI: '1' })
    assert.ok(!dump().includes(value))
    const audit = rows<{ after: string }>(h, "select after from audit_event where action = 'sandbox.exec'").at(-1)!
    assert.deepEqual(JSON.parse(audit.after).env_keys, ['CI', 'EXEC_SECRET'])
  })

  test('env over 64 KiB and stdin over 256 KiB are refused', async () => {
    const bigEnv = await exec({ command: ['true'], env: { BIG: 'x'.repeat(65 * 1024) } })
    assert.equal(bigEnv.status, 400)
    assert.equal(bigEnv.body.error.details.issues[0].path, '/env')
    const bigStdin = await exec({ command: ['true'], stdin: Buffer.alloc(257 * 1024).toString('base64url') })
    assert.equal(bigStdin.status, 400)
    assert.equal(bigStdin.body.error.details.issues[0].path, '/stdin')
    const ok = await exec({ command: ['cat'], stdin: Buffer.from('from stdin').toString('base64url') })
    assert.match(ok.body.output.untrusted.text, /stdin: from stdin/)
  })

  test('wait_s 0 returns the run without output and a later read with wait_s returns it', async () => {
    const reply = await exec({ command: ['sleepless'], wait_s: 0 })
    assert.equal(reply.status, 201)
    assert.equal(reply.body.output, undefined)
    assert.ok(['queued', 'running', 'succeeded'].includes(reply.body.status))
    const later = await api('GET', `/v1/runs/${reply.body.id}?wait_s=5`)
    assert.equal(later.body.status, 'succeeded')
    assert.ok(later.body.output.untrusted.text.length > 0)
  })

  test('attach = true returns a queued run with attach_url and the shell reuses the run row', async () => {
    const attached = await exec({ command: ['bash'], attach: true })
    assert.equal(attached.body.status, 'queued')
    assert.equal(attached.body.attach_url, `/v1/runs/${attached.body.id}/attach`)
    assert.equal(attached.body.output, undefined)
    const shell = await api('POST', `/v1/sandboxes/${boxId}/shells`, { user: 'agent', cwd: '/home/agent' })
    assert.equal(shell.status, 201, shell.text)
    assert.deepEqual([shell.body.kind, shell.body.tty, shell.body.sandbox_id, shell.body.status], ['shell', true, boxId, 'queued'])
    assert.deepEqual(shell.body.command, ['/bin/bash', '-l'])
    assert.equal(shell.body.attach_url, `/v1/runs/${shell.body.id}/attach`)
    const plainBox = await createSandbox(h, envId, { name: 'alpine-shell', image: { ref: 'alpine:3.20' } })
    await waitForSandbox(h, plainBox.id, 'running')
    const alpineShell = await api('POST', `/v1/sandboxes/${plainBox.id}/shells`, {})
    assert.deepEqual(alpineShell.body.command, ['/bin/sh'])
    const queued = rows<{ n: number }>(h, "select count(*) as n from run where id = ? and status = 'queued'", shell.body.id)[0]!.n
    assert.equal(queued, 1)
  })

  test('at most 16 runs are active in a sandbox at once', async () => {
    const box = await createSandbox(h, envId, { name: 'busy' })
    await waitForSandbox(h, box.id, 'running')
    const planted = Array.from({ length: 16 }, () => newId('run'))
    for (const id of planted) h.db.insert(run).values({ id, service_id: null, sandbox_id: box.id, deployment_id: null, kind: 'exec', command: ['sleep'], status: 'running', log_ref: `logs/${id}`, tty: false }).run()
    const reply = await exec({ command: ['true'] }, h.admin.token, box.id)
    assert.equal(reply.status, 429)
    assert.equal(reply.body.error.code, 'RATE_LIMITED')
    h.db.update(run).set({ status: 'cancelled' }).where(eq(run.sandbox_id, box.id)).run()
    assert.equal((await exec({ command: ['true'] }, h.admin.token, box.id)).status, 201)
  })

  test('the run list filters by kind and status, and a run is cancellable through the common route', async () => {
    const listed = await api('GET', `/v1/sandboxes/${boxId}/runs?kind=exec&status=succeeded`)
    assert.equal(listed.status, 200)
    assert.ok(listed.body.items.length >= 3)
    assert.ok(listed.body.items.every((r: any) => r.kind === 'exec' && r.status === 'succeeded' && r.sandbox_id === boxId))
    const queued = (await exec({ command: ['bash'], attach: true })).body
    const cancelled = await api('POST', `/v1/runs/${queued.id}/cancel`)
    assert.equal(cancelled.status, 200, cancelled.text)
    assert.equal(cancelled.body.status, 'cancelled')
  })

  test('read access cannot run commands, deploy access can', async () => {
    const refused = await exec({ command: ['true'] }, readToken)
    assert.equal(refused.status, 403)
    assert.equal(refused.body.error.code, 'FORBIDDEN_SCOPE')
    assert.equal((await exec({ command: ['true'] }, deployToken)).status, 201)
    assert.equal((await api('GET', `/v1/sandboxes/${boxId}/runs`, undefined, readToken)).status, 200)
  })

  test('stopping a sandbox cancels its queued and running runs', async () => {
    const box = await createSandbox(h, envId, { name: 'stopping-runs' })
    await waitForSandbox(h, box.id, 'running')
    const queued = (await exec({ command: ['bash'], attach: true }, h.admin.token, box.id)).body
    await api('POST', `/v1/sandboxes/${box.id}/stop`)
    await waitForSandbox(h, box.id, 'stopped')
    assert.equal((await api('GET', `/v1/runs/${queued.id}`)).body.status, 'cancelled')
  })
})

describe('variables', () => {
  const set = (body: unknown, token = h.admin.token, id = boxId) => api('PATCH', `/v1/sandboxes/${id}/variables`, body, token)

  before(async () => {
    const projectVars = await api('PATCH', `/v1/projects/alpha/variables`, { environment: 'default', set: [{ key: 'GH_TOKEN', kind: 'sealed', value: secret }] })
    assert.equal(projectVars.status, 200, projectVars.text)
  })

  test('literal, sealed and reference variables are set, delivered to stationd as purpose sandbox and never listed with values', async () => {
    const reply = await set({
      set: [
        { key: 'PLAIN', kind: 'literal', value: plain },
        { key: 'OWN_SEALED', kind: 'sealed', value: sealed },
        { key: 'GH_TOKEN', kind: 'reference', reference: '${{project.GH_TOKEN}}' },
        { key: 'GENERATED', kind: 'literal', reference: '${{secret(32)}}' }
      ]
    })
    assert.equal(reply.status, 200, reply.text)
    assert.deepEqual(reply.body.variables.map((v: any) => v.key).sort(), ['GENERATED', 'GH_TOKEN', 'OWN_SEALED', 'PLAIN'])
    assert.ok(reply.body.variables.every((v: any) => v.scope === 'sandbox' && v.injection === 'env' && v.build === false))
    const full = (await api('GET', `/v1/sandboxes/${boxId}/variables?fields=sandbox_id`)).body.items
    assert.ok(full.every((v: any) => v.sandbox_id === boxId))
    const delivery = await station.waitFor(() => station.secrets.filter(s => s.target.sandbox_id === boxId && s.values.GH_TOKEN).at(-1), 8000, 'the sandbox delivery')
    assert.equal(delivery.purpose, 'sandbox')
    assert.equal(delivery.values.PLAIN, plain)
    assert.equal(delivery.values.OWN_SEALED, sealed)
    assert.equal(delivery.values.GH_TOKEN, secret)
    assert.ok(delivery.values.GENERATED!.length >= 32)
    const listed = await api('GET', `/v1/sandboxes/${boxId}/variables?fields=*`)
    assert.equal(listed.status, 200)
    assert.equal(listed.body.items.length, 4)
    assert.ok(listed.body.items.every((v: any) => v.value === null))
    assert.ok(!listed.text.includes(secret) && !listed.text.includes(sealed) && !listed.text.includes(plain))
  })

  test('the resolved view shows sources for a project reference and a value only to admin, never for sealed ones', async () => {
    const resolved = (await api('GET', `/v1/sandboxes/${boxId}/variables/resolved`)).body
    assert.equal(resolved.sandbox_id, boxId)
    const byKey = Object.fromEntries(resolved.variables.map((v: any) => [v.key, v]))
    assert.equal(byKey.PLAIN.value, plain)
    assert.equal(byKey.OWN_SEALED.sealed, true)
    assert.equal(byKey.OWN_SEALED.value, undefined)
    assert.equal(byKey.GH_TOKEN.value, undefined)
    assert.equal(byKey.GH_TOKEN.sealed, true)
    assert.equal(byKey.GH_TOKEN.parts[0].chain[0].scope, 'project')
    assert.equal(byKey.GH_TOKEN.parts[0].chain[0].key, 'GH_TOKEN')
    const asDeployer = (await api('GET', `/v1/sandboxes/${boxId}/variables/resolved`, undefined, deployToken)).body
    assert.ok(asDeployer.variables.every((v: any) => v.value === undefined))
    assert.ok(!JSON.stringify(asDeployer).includes(plain))
    const expanded = (await api('GET', `/v1/sandboxes/${boxId}?fields=variables`)).body.variables
    assert.ok(expanded.some((v: any) => v.key === 'GH_TOKEN' && v.sealed === true))
    assert.ok(!JSON.stringify(expanded).includes(secret))
  })

  test('a changed referenced project value is delivered again and the generation env_digest follows it', async () => {
    const before = (await station.waitForGeneration(d => d.sandboxes?.[boxId]?.env_digest !== undefined)).sandboxes![boxId]!.env_digest
    const deliveries = station.secrets.filter(s => s.target.sandbox_id === boxId).length
    const next = 'ghp_rotatedsecret9876543210'
    assert.equal((await api('PATCH', `/v1/projects/alpha/variables`, { environment: 'default', set: [{ key: 'GH_TOKEN', kind: 'sealed', value: next }] })).status, 200)
    h.deps.stations.reconcile()
    const delivery = await station.waitFor(() => station.secrets.filter(s => s.target.sandbox_id === boxId).slice(deliveries).find(s => s.values.GH_TOKEN === next), 8000, 'the rotated delivery')
    assert.notEqual(delivery.digest, before)
    const changed = ((await api('GET', '/v1/events?types=secret.changed&limit=50')).body.items as any[]).filter(e => e.payload.sandboxes?.includes(boxId))
    assert.ok(changed.length > 0, 'secret.changed names the sandbox that reads the value')
    assert.equal(rows<{ stale: number }>(h, 'select count(*) as stale from service where stale = 1')[0]!.stale, 0)
    const after = await station.waitForGeneration(d => d.sandboxes?.[boxId]?.env_digest === delivery.digest)
    assert.equal(after.sandboxes![boxId]!.env_digest, delivery.digest)
  })

  test('exec output and logs are redacted with the sandbox variable values', async () => {
    const reply = await exec({ command: ['env'] })
    assert.equal(reply.status, 201)
    const text = reply.body.output.untrusted.text
    assert.ok(!text.includes(plain) || text.includes('[redacted:'))
    for (const value of [sealed, 'ghp_rotatedsecret9876543210']) assert.ok(!text.includes(value), `${value} leaked: ${text}`)
    assert.match(text, /\[redacted:OWN_SEALED\]/)
    const logs = await api('GET', `/v1/logs?run=${reply.body.id}&tail=50`)
    assert.equal(logs.status, 200, logs.text)
    assert.ok(!logs.text.includes(sealed))
    assert.match(logs.text, /\[redacted:/)
  })

  test('a reference to a service, an unresolved reference and an ungranted global are refused with their codes', async () => {
    await createService(h, envId, { name: 'web', ref: 'nginx:1.27', ports: [{ port: 80 }] })
    const service = await set({ set: [{ key: 'WEB_PORT', kind: 'reference', reference: '${{web.PORT}}' }] })
    assert.equal(service.status, 400)
    assert.equal(service.body.error.code, 'VALIDATION_FAILED')
    assert.equal(service.body.error.details.issues[0].path, '/set/0/reference')
    const unresolved = await set({ set: [{ key: 'NOPE', kind: 'reference', reference: '${{project.NOPE}}' }] })
    assert.equal(unresolved.status, 422)
    assert.equal(unresolved.body.error.code, 'VARIABLE_UNRESOLVED')
    assert.equal((await api('PATCH', '/v1/global-variables', { set: [{ key: 'ORG_KEY', kind: 'sealed', value: 'org-key-0123456789' }] })).status, 200)
    const ungranted = await set({ set: [{ key: 'ORG_KEY', kind: 'reference', reference: '${{global.ORG_KEY}}' }] })
    assert.equal(ungranted.status, 403)
    assert.equal(ungranted.body.error.code, 'VARIABLE_NOT_GRANTED')
    const variable = (await api('GET', '/v1/global-variables')).body.items.find((v: any) => v.key === 'ORG_KEY')
    assert.equal((await api('POST', `/v1/variables/${variable.id}/grants`, { project_id: project.id })).status, 201)
    const granted = await set({ set: [{ key: 'ORG_KEY', kind: 'reference', reference: '${{global.ORG_KEY}}' }] })
    assert.equal(granted.status, 200, granted.text)
    const deferred = await set({ set: [{ key: 'LATER', kind: 'reference', reference: '${{project.LATER}}' }], allow_unresolved: true })
    assert.equal(deferred.status, 200, deferred.text)
    assert.equal((await set({ unset: ['LATER', 'ORG_KEY'] })).status, 200)
  })

  test('a sealed variable needs admin and a deploy token sets literals and references only', async () => {
    const sealedByDeployer = await set({ set: [{ key: 'DEPLOYER_SEALED', kind: 'sealed', value: 'whatever-0123456789' }] }, deployToken)
    assert.equal(sealedByDeployer.status, 403)
    assert.equal(sealedByDeployer.body.error.code, 'FORBIDDEN_SCOPE')
    assert.equal((await set({ set: [{ key: 'DEPLOYER_LITERAL', kind: 'literal', value: 'ok' }] }, deployToken)).status, 200)
    const asReader = await set({ set: [{ key: 'READER', kind: 'literal', value: 'no' }] }, readToken)
    assert.equal(asReader.status, 403)
  })

  test('deleting the sandbox deletes its variable rows and a fork starts with none', async () => {
    const fork = await createSandbox(h, envId, { name: 'variable-fork', from: { sandbox: boxId }, start: false })
    assert.equal(rows(h, 'select id from variable where sandbox_id = ?', fork.id).length, 0)
    const withVariables = await createSandbox(h, envId, { name: 'created-with-variables', start: false, variables: [{ key: 'TOKEN', kind: 'reference', reference: '${{project.GH_TOKEN}}' }] })
    assert.equal(rows(h, 'select id from variable where sandbox_id = ?', withVariables.id).length, 1)
    const unresolved = await api('POST', `/v1/environments/${envId}/sandboxes`, { name: 'bad-variables', variables: [{ key: 'X', kind: 'reference', reference: '${{project.MISSING}}' }] })
    assert.equal(unresolved.status, 422)
    assert.equal(rows(h, "select id from sandbox where name = 'bad-variables'").length, 0)
    assert.equal((await api('DELETE', `/v1/sandboxes/${withVariables.id}`)).status, 200)
    assert.equal(rows(h, 'select id from variable where sandbox_id = ?', withVariables.id).length, 0)
    assert.equal(h.db.select().from(sandbox).where(eq(sandbox.id, withVariables.id)).get()?.status ?? 'deleting', 'deleting')
  })
})

describe('logs, metrics and network', () => {
  test('GET /v1/logs reads the init and runtime log of a sandbox', async () => {
    const init = await api('GET', `/v1/logs?sandbox=${boxId}`)
    assert.equal(init.status, 200, init.text)
    assert.equal(init.body.untrusted.lines[0].role, 'init')
    const runtime = await api('GET', `/v1/logs?sandbox=${boxId}&role=runtime`)
    assert.equal(runtime.body.untrusted.lines[0].role, 'runtime')
    const sent = station.received.filter(m => m.type === 'logs.query' && (m.body as any).source === 'sandbox').map(m => m.body as any)
    assert.deepEqual(sent.map(b => [b.sandbox_id, b.role]), [[boxId, 'init'], [boxId, 'runtime']])
    const bad = await api('GET', `/v1/logs?sandbox=${boxId}&role=service`)
    assert.equal(bad.status, 400)
    const two = await api('GET', `/v1/logs?sandbox=${boxId}&run=run_01ARZ3NDEKTSV4RRFFQ69G5FAV`)
    assert.equal(two.status, 400)
  })

  test('metrics, connections and the DNS log come from the station with the sandbox form of each request', async () => {
    const metrics = await api('GET', `/v1/sandboxes/${boxId}/metrics`)
    assert.equal(metrics.status, 200, metrics.text)
    assert.equal(metrics.body.sandbox_id, boxId)
    assert.equal(metrics.body.disk_limit_bytes, 21474836480)
    const connections = await api('GET', `/v1/sandboxes/${boxId}/connections?direction=out`)
    assert.equal(connections.status, 200, connections.text)
    assert.deepEqual(connections.body.sandbox, { id: boxId, name: 'worker' })
    assert.equal(connections.body.refused[0].path, 'domain_not_allowed')
    assert.equal(connections.body.untrusted.source, 'resolver answers')
    const dns = await api('GET', `/v1/sandboxes/${boxId}/dns-log?tail=10`)
    assert.equal(dns.status, 200, dns.text)
    assert.equal(dns.body.untrusted.source, 'resolver log')
    assert.equal(dns.body.untrusted.entries.find((e: any) => e.refused === 'domain_not_allowed').name, 'evil.example')
    const asked = station.received.filter(m => ['metrics.sample', 'network.sample', 'dns.log'].includes(m.type)).map(m => m.body as any)
    assert.ok(asked.some(b => b.sandbox_ids?.[0] === boxId))
    assert.ok(asked.some(b => b.sandbox_id === boxId))
  })

  test('metrics of a stopped sandbox are a documented error and an offline station is STATION_OFFLINE', async () => {
    const cold = await createSandbox(h, envId, { name: 'cold-metrics', start: false })
    assert.equal((await api('GET', `/v1/sandboxes/${cold.id}/metrics`)).status, 404)
    const idle = await startFakeStation(h, 'station-away', { sandboxes: {} })
    const away = await createSandbox(h, envId, { name: 'away-box', station_id: 'station-away', start: false })
    await idle.close()
    await idle.waitFor(() => !h.deps.stations.isConnected(idle.stationId), 5000, 'disconnect')
    const reply = await api('GET', `/v1/sandboxes/${away.id}/metrics`)
    assert.equal(reply.status, 503)
    assert.equal(reply.body.error.code, 'STATION_OFFLINE')
  })
})
