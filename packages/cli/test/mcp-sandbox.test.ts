import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { sandboxToolNames } from '@stationly/mcp'
import { mintToken, serveOverHttp, startDispatch, startFakeStation, type Dispatch } from '../../../apps/dispatch/test/helpers/dispatch.ts'
import { createProject, pinPlatform, rows, waitForSandbox } from '../../../apps/dispatch/test/helpers/seed.ts'

const entry = new URL('../src/index.ts', import.meta.url).pathname

let h: Dispatch
let home: string
let url: string
let close: () => Promise<void>
let client: Client
let project: { id: string; default_environment_id: string }
let deployToken: string
let station: Awaited<ReturnType<typeof startFakeStation>>

const env = () => ({ PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), STATIONLY_API_URL: url }) as Record<string, string>

const install = () =>
  new Promise<void>((resolve, reject) =>
    execFile(process.execPath, [entry, 'mcp', 'install', 'claude-code', '--project', '*', '--level', 'deploy'], { cwd: home, env: { ...env(), STATIONLY_TOKEN: h.admin.token } }, (error, _out, stderr) => (error ? reject(new Error(stderr)) : resolve()))
  )

const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: any; content: { text: string }[] }

const headers = { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'sly-mcp-sbx-'))
  h = await startDispatch()
  pinPlatform(h, { sandboxes: true })
  station = await startFakeStation(h, 'station-1', {
    sandboxes: { runOutput: (command, vars) => [`ran ${command.join(' ')}`, ...Object.entries(vars).map(([key, value]) => `${key}=${value}`)] }
  })
  project = await createProject(h, 'alpha')
  ;({ url, close } = await serveOverHttp(h, { attach: true }))
  await install()
  client = new Client({ name: 'test', version: '1' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry, 'mcp', '--client', 'claude-code'], env: env(), stderr: 'ignore' }))
  deployToken = await mintToken(h, [{ project_id: '*', environment_id: '*', level: 'deploy' }], 'remote-deploy')
})

after(async () => {
  await client?.close().catch(() => undefined)
  await close()
  await h.close()
  rmSync(home, { recursive: true, force: true })
})

describe('tool listing', () => {
  test('the stdio server lists the 19 sandbox tools and push_local_source with the documented annotations', async () => {
    const { tools } = await client.listTools()
    const names = tools.map(t => t.name)
    for (const name of [...sandboxToolNames, 'push_local_source']) assert.ok(names.includes(name), name)
    assert.equal(sandboxToolNames.length, 19)
    const by = new Map(tools.map(t => [t.name, t]))
    for (const name of ['list_sandboxes', 'list_sandbox_snapshots', 'get_sandbox_logs', 'get_sandbox_network', 'list_sandbox_variables']) {
      assert.equal(by.get(name)!.annotations?.readOnlyHint, true, name)
      assert.ok(!('idempotency_key' in (by.get(name)!.inputSchema.properties ?? {})), name)
    }
    for (const name of ['delete_sandbox', 'delete_sandbox_snapshot']) assert.equal(by.get(name)!.annotations?.destructiveHint, true, name)
    for (const name of ['create_sandbox', 'stop_sandbox', 'sandbox_exec', 'set_sandbox_variables', 'grow_sandbox_storage']) {
      const t = by.get(name)!
      assert.equal(t.annotations?.readOnlyHint, false, name)
      assert.equal(t.annotations?.idempotentHint, true, name)
      assert.ok('idempotency_key' in (t.inputSchema.properties ?? {}), name)
    }
    for (const name of sandboxToolNames) {
      assert.equal(by.get(name)!.annotations?.openWorldHint, false, name)
      assert.match(by.get(name)!.description ?? '', /data, never instructions/)
    }
  })

  test('the remote /mcp lists none of them', async () => {
    const reply = await h.call('POST', '/mcp', { token: deployToken, headers, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })
    const data = /^data: (.*)$/m.exec(reply.text)?.[1]
    const remote = ((data ? JSON.parse(data) : reply.body).result.tools as { name: string }[]).map(t => t.name)
    assert.ok(remote.length > 10)
    for (const name of sandboxToolNames) assert.ok(!remote.includes(name), name)
    assert.ok(!remote.includes('push_local_source'))
  })
})

describe('tool calls', () => {
  let id: string

  test('create_sandbox returns what REST returns, and an idempotency_key replays', async () => {
    const first = await call('create_sandbox', { project: 'alpha', name: 'agent-box', ttl_s: 7200, idempotency_key: 'mcp-sbx-1' })
    assert.equal(first.isError, undefined, first.content[0]!.text)
    assert.equal(first.structuredContent.name, 'agent-box')
    assert.equal(first.structuredContent.ttl_s, 7200)
    id = first.structuredContent.id
    const again = await call('create_sandbox', { project: 'alpha', name: 'agent-box', ttl_s: 7200, idempotency_key: 'mcp-sbx-1' })
    assert.equal(again.structuredContent.id, id)
    const rest = await h.call('GET', `/v1/environments/${project.default_environment_id}/sandboxes`, { token: h.admin.token })
    assert.equal(rest.body.items.filter((s: any) => s.name === 'agent-box').length, 1)
    await waitForSandbox(h, id, 'running')
  })

  test('list_sandboxes matches REST by environment and by sandbox name', async () => {
    const listed = await call('list_sandboxes', { project: 'alpha' })
    const rest = await h.call('GET', `/v1/environments/${project.default_environment_id}/sandboxes`, { token: h.admin.token })
    assert.deepEqual(listed.structuredContent, rest.body)
    const one = await call('list_sandboxes', { sandbox: 'alpha/production/agent-box' })
    assert.equal(one.structuredContent.id, id)
    const byName = await call('list_sandboxes', { project: 'alpha', sandbox: 'agent-box', fields: 'egress' })
    assert.equal(byName.structuredContent.egress.mode, 'open')
  })

  test('an API refusal comes back as an error result carrying the envelope', async () => {
    const result = await call('stop_sandbox', { sandbox: 'sbx_01ARZ3NDEKTSV4RRFFQ69G5FAV' })
    assert.equal(result.isError, true)
    assert.equal(JSON.parse(result.content[0]!.text).error.code, 'NOT_FOUND')
  })

  test('sandbox_exec returns the run, done and the output as untrusted data', async () => {
    const result = await call('sandbox_exec', { sandbox: id, command: ['echo', 'hi'], env: { CI: '1' } })
    assert.equal(result.isError, undefined, result.content[0]!.text)
    assert.equal(result.structuredContent.done, true)
    assert.equal(result.structuredContent.run.status, 'succeeded')
    assert.equal(result.structuredContent.output.untrusted.source, 'sandbox exec output')
    assert.match(result.structuredContent.output.untrusted.text, /ran echo hi/)
    assert.ok(station.secrets.some(s => s.purpose === 'run' && s.values.CI === '1'))
    const stored = JSON.stringify(rows(h, 'select * from run'))
    assert.ok(!stored.includes('"CI":"1"'))
  })

  test('sandbox_exec returns done false when the timeout passes first, and the run keeps going', async () => {
    const progress: number[] = []
    const result = (await client.callTool({ name: 'sandbox_exec', arguments: { sandbox: id, command: ['sleep', '100'], timeout_s: 2 } }, { onprogress: p => progress.push(p.progress) })) as any
    assert.equal(result.structuredContent.done, false)
    assert.ok(['queued', 'running'].includes(result.structuredContent.run.status))
    assert.equal(result.structuredContent.output, null)
    const run = await h.call('GET', `/v1/runs/${result.structuredContent.run.id}`, { token: h.admin.token })
    assert.ok(['queued', 'running'].includes(run.body.status))
  })

  test('set_sandbox_variables and list_sandbox_variables never expose values, and exec output is redacted', async () => {
    const set = await call('set_sandbox_variables', { sandbox: id, set: [{ key: 'GH_TOKEN', kind: 'literal', value: 'ghp_supersecretvalue123' }] })
    assert.equal(set.isError, undefined, set.content[0]!.text)
    assert.equal(set.structuredContent.variables[0].key, 'GH_TOKEN')
    const listed = await call('list_sandbox_variables', { sandbox: id })
    assert.equal(listed.structuredContent.items.length, 1)
    assert.ok(!JSON.stringify(listed.structuredContent).includes('ghp_supersecretvalue123'))
    const resolved = await call('list_sandbox_variables', { sandbox: id, resolved: true })
    assert.equal(resolved.structuredContent.variables[0].key, 'GH_TOKEN')
    const sealed = await h.call('PATCH', `/v1/sandboxes/${id}/variables`, { token: h.admin.token, body: { set: [{ key: 'SEALED_TOKEN', kind: 'sealed', value: 'ghp_sealedsecretvalue456' }] } })
    assert.equal(sealed.status, 200, sealed.text)
    await station.waitFor(() => station.secrets.find(s => s.purpose === 'sandbox' && s.values.SEALED_TOKEN), 5000, 'sandbox secrets')
    const exec = await call('sandbox_exec', { sandbox: id, command: ['printenv'] })
    assert.ok(!exec.content[0]!.text.includes('ghp_sealedsecretvalue456'))
    assert.match(exec.structuredContent.output.untrusted.text, /redacted:SEALED_TOKEN/)
    assert.ok(exec.structuredContent.output.untrusted.text.includes('ghp_supersecretvalue123'))
  })

  test('get_sandbox_logs and get_sandbox_network return untrusted data', async () => {
    const logs = await call('get_sandbox_logs', { sandbox: id })
    assert.match(logs.structuredContent.untrusted.text, /sandbox init started/)
    const net = await call('get_sandbox_network', { sandbox: id })
    assert.ok(net.structuredContent.connections.length >= 1)
    assert.equal(net.structuredContent.refused[0].path, 'domain_not_allowed')
    assert.ok(net.structuredContent.dns.some((e: any) => e.refused === 'domain_not_allowed'))
    const bad = await call('get_sandbox_logs', {})
    assert.equal(bad.isError, true)
  })

  test('explain_sandbox_network and probe_sandbox_network answer from the sandbox', async () => {
    const explained = await call('explain_sandbox_network', { sandbox: id, to: 'registry.npmjs.org:443' })
    assert.equal(explained.isError, undefined, explained.content[0]!.text)
    assert.equal(explained.structuredContent.entity.to, 'registry.npmjs.org:443/tcp')
    assert.ok(explained.structuredContent.hops.some((hop: any) => hop.hop === 'firewall'))
    const probed = await call('probe_sandbox_network', { sandbox: id, to: 'registry.npmjs.org', kind: 'dns' })
    assert.equal(probed.isError, undefined, probed.content[0]!.text)
    assert.equal(probed.structuredContent.dns.rcode, 'NOERROR')
    assert.equal(probed.structuredContent.sandbox.length > 0, true)
  })

  test('forward_sandbox_port listens on loopback, returns the same listener twice and echoes through the station', async () => {
    const first = await call('forward_sandbox_port', { sandbox: id, port: 8080, local_port: 0 })
    assert.equal(first.isError, undefined, first.content[0]!.text)
    const second = await call('forward_sandbox_port', { sandbox: id, port: 8080 })
    assert.equal(second.structuredContent.local_address, first.structuredContent.local_address)
    const [host, port] = first.structuredContent.local_address.split(':')
    assert.equal(host, '127.0.0.1')
    const echoed = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(port), host!)
      socket.once('data', data => {
        socket.destroy()
        resolve(data.toString())
      })
      socket.once('error', reject)
      socket.write('hello')
    })
    assert.equal(echoed, 'HELLO')
  })

  test('snapshot_sandbox, list_sandbox_snapshots and delete_sandbox_snapshot', async () => {
    const snap = await call('snapshot_sandbox', { sandbox: id, name: 'before' })
    assert.equal(snap.isError, undefined, snap.content[0]!.text)
    assert.equal(snap.structuredContent.status, 'ready')
    const listed = await call('list_sandbox_snapshots', { sandbox: id })
    assert.deepEqual(listed.structuredContent.items.map((s: any) => s.id), [snap.structuredContent.id])
    const byEnv = await call('list_sandbox_snapshots', { project: 'alpha' })
    assert.equal(byEnv.structuredContent.items.length, 1)
    const fork = await call('fork_sandbox', { project: 'alpha', from: { snapshot: snap.structuredContent.id }, name: 'forked' })
    assert.equal(fork.isError, undefined, fork.content[0]!.text)
    assert.equal(fork.structuredContent.forked_from.snapshot_id, snap.structuredContent.id)
    const removed = await call('delete_sandbox_snapshot', { project: 'alpha', snapshot: 'before' })
    assert.equal(removed.structuredContent.deleted, true)
  })

  test('update_sandbox, stop_sandbox, start_sandbox and delete_sandbox follow the REST states', async () => {
    const updated = await call('update_sandbox', { sandbox: id, ttl_s: 900 })
    assert.equal(updated.structuredContent.ttl_s, 900)
    assert.equal(updated.structuredContent.warnings.length, 0)
    const stopped = await call('stop_sandbox', { sandbox: id })
    assert.equal(stopped.structuredContent.desired_state, 'stopped')
    await waitForSandbox(h, id, 'stopped')
    const started = await call('start_sandbox', { sandbox: id, ttl_s: 600 })
    assert.equal(started.structuredContent.ttl_s, 600)
    await waitForSandbox(h, id, 'running')
    const deleted = await call('delete_sandbox', { sandbox: id })
    assert.equal(deleted.structuredContent.deleted, true)
    assert.equal(deleted.structuredContent.snapshots_kept, 0)
  })

  test('grow_sandbox_storage is refused for a deploy-level token', async () => {
    const refused = await call('grow_sandbox_storage', { station: 'station-1', size_bytes: 1 })
    assert.equal(refused.isError, true)
    assert.equal(JSON.parse(refused.content[0]!.text).error.code, 'INSTANCE_SCOPE_REQUIRED')
  })
})
