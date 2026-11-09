import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { startDispatch, startFakeStation, serveOverHttp, type Dispatch } from '../../../apps/dispatch/test/helpers/dispatch.ts'
import { createEnvironment, createProject, pinPlatform, waitForSandbox } from '../../../apps/dispatch/test/helpers/seed.ts'
import { allowOf, bytesOf } from '../src/commands/sandbox.ts'

const entry = new URL('../src/index.ts', import.meta.url).pathname

let h: Dispatch
let server: Awaited<ReturnType<typeof serveOverHttp>>
let home: string
let fake: Awaited<ReturnType<typeof startFakeStation>>
let environmentId: string

type Result = { code: number; stdout: string; stderr: string }

const env = (extra: Record<string, string | undefined> = {}) =>
  ({ PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), STATIONLY_API_URL: server.url, STATIONLY_TOKEN: h.admin.token, ...extra }) as NodeJS.ProcessEnv

const sly = (args: string[], input = '', extra: Record<string, string | undefined> = {}) =>
  new Promise<Result>(resolve => {
    const child = execFile(process.execPath, [entry, '--project', 'alpha', ...args], { cwd: home, env: env(extra) }, (error, stdout, stderr) =>
      resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout, stderr })
    )
    child.stdin?.end(input)
  })

const json = (result: Result) => JSON.parse(result.stdout)

const sent = (method: string, suffix: string) => server.requests.filter(r => r.method === method && r.path.endsWith(suffix)).at(-1)!

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'sly-sbx-'))
  h = await startDispatch()
  pinPlatform(h, { sandboxes: true })
  fake = await startFakeStation(h, 'station-1', { sandboxes: { runOutput: (command, vars) => [`ran ${command.join(' ')}`, ...Object.entries(vars).map(([k, v]) => `${k}=${v}`)] } })
  server = await serveOverHttp(h, { attach: true })
  const project = await createProject(h, 'alpha')
  environmentId = project.default_environment_id
  await createEnvironment(h, 'alpha', 'staging')
})

after(async () => {
  await server.close()
  await h.close()
  rmSync(home, { recursive: true, force: true })
})

describe('flag parsing', () => {
  test('sizes accept bytes, MiB and GiB and a bare small number means GiB', () => {
    assert.equal(bytesOf('8GiB', '--memory'), 8 * 1024 ** 3)
    assert.equal(bytesOf('512MiB', '--memory'), 512 * 1024 ** 2)
    assert.equal(bytesOf('2147483648', '--memory'), 2147483648)
    assert.equal(bytesOf('4', '--disk'), 4 * 1024 ** 3)
    assert.throws(() => bytesOf('lots', '--disk'))
  })

  test('allow entries carry wildcard and ports', () => {
    assert.deepEqual(allowOf('github.com:443,22'), { domain: 'github.com', wildcard: false, ports: [443, 22] })
    assert.deepEqual(allowOf('*.githubusercontent.com'), { domain: 'githubusercontent.com', wildcard: true })
  })
})

const withoutLiveMetrics = (body: unknown): unknown => {
  if (Array.isArray(body)) return body.map(withoutLiveMetrics)
  if (body && typeof body === 'object') return Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'metrics').map(([key, value]) => [key, withoutLiveMetrics(value)]))
  return body
}

describe('lifecycle commands', () => {
  let id = ''

  test('create maps every flag to the request body', async () => {
    server.requests.length = 0
    const result = await sly(['--json', 'sandbox', 'create', 'dev', '--cpu', '4000', '--memory', '8GiB', '--disk', '40GiB', '--network', 'environment', '--docker', '--allow', 'github.com:443,22', '--allow', '*.githubusercontent.com', '--ttl', '2h'])
    assert.equal(result.code, 0, result.stderr)
    const request = server.requests.find(r => r.method === 'POST' && r.path.endsWith('/sandboxes'))!
    assert.match(request.path, new RegExp(`^/v1/environments/${environmentId}/sandboxes$`))
    assert.deepEqual(JSON.parse(request.body), {
      name: 'dev',
      size: { cpu_millis: 4000, memory_bytes: 8 * 1024 ** 3, disk_bytes: 40 * 1024 ** 3 },
      network: 'environment',
      docker: true,
      egress: { mode: 'allowlist', domains: [{ domain: 'github.com', wildcard: false, ports: [443, 22] }, { domain: 'githubusercontent.com', wildcard: true }] },
      ttl_s: 7200
    })
    const created = json(result)
    assert.equal(created.name, 'dev')
    assert.equal(created.status, 'creating')
    id = created.id
    await waitForSandbox(h, id, 'running')
  })

  test('list, describe by name and by id match the REST bodies', async () => {
    const listed = await sly(['--json', 'sandbox', 'list', '--status', 'running'])
    assert.equal(listed.code, 0, listed.stderr)
    assert.deepEqual(withoutLiveMetrics(json(listed)), withoutLiveMetrics((await h.call('GET', `/v1/environments/${environmentId}/sandboxes?status=running`, { token: h.admin.token })).body))
    const byName = await sly(['--json', 'sandbox', 'describe', 'dev'])
    assert.equal(byName.code, 0, byName.stderr)
    assert.match(server.requests.find(r => r.method === 'GET' && /\/projects\/alpha\/environments\/env_[A-Z0-9]+\/sandboxes\/dev$/.test(r.path))!.path, /sandboxes\/dev$/)
    assert.deepEqual(withoutLiveMetrics(json(byName)), withoutLiveMetrics((await h.call('GET', `/v1/sandboxes/${id}?fields=*`, { token: h.admin.token })).body))
    assert.equal(json(await sly(['--json', 'sandbox', 'describe', id])).id, id)
    const human = await sly(['sandbox', 'list'])
    assert.match(human.stdout, /dev\s+running\s+toolchain/)
  })

  test('update sends only the given fields and --open-egress replaces the allowlist', async () => {
    const ttl = await sly(['--json', 'sandbox', 'update', 'dev', '--ttl', '30m', '--no-docker'])
    assert.equal(ttl.code, 0, ttl.stderr)
    assert.deepEqual(JSON.parse(sent('PATCH', `/sandboxes/${id}`).body), { ttl_s: 1800, docker: false })
    const open = await sly(['--json', 'sandbox', 'update', 'dev', '--open-egress', '--memory', '16GiB'])
    assert.equal(open.code, 0, open.stderr)
    assert.deepEqual(JSON.parse(sent('PATCH', `/sandboxes/${id}`).body), { size: { memory_bytes: 16 * 1024 ** 3 }, egress: { mode: 'open' } })
    assert.equal(json(open).warnings[0].code, 'SANDBOX_RESTART_REQUIRED')
    const clash = await sly(['sandbox', 'update', 'dev', '--open-egress', '--allow', 'a.com'])
    assert.equal(clash.code, 2)
  })

  test('stop, start with a ttl and the --dry-run request', async () => {
    const stopped = await sly(['--json', 'sandbox', 'stop', 'dev'])
    assert.equal(stopped.code, 0, stopped.stderr)
    await waitForSandbox(h, id, 'stopped')
    const dry = await sly(['--dry-run', 'sandbox', 'start', 'dev', '--ttl', '10m'])
    assert.equal(dry.code, 0, dry.stderr)
    assert.equal(JSON.parse(dry.stdout).method, 'POST')
    assert.equal((await h.call('GET', `/v1/sandboxes/${id}`, { token: h.admin.token })).body.status, 'stopped')
    const started = await sly(['--json', 'sandbox', 'start', 'dev', '--ttl', '10m'])
    assert.equal(started.code, 0, started.stderr)
    assert.deepEqual(JSON.parse(sent('POST', `/sandboxes/${id}/start`).body), { ttl_s: 600 })
    assert.equal(json(started).ttl_s, 600)
    await waitForSandbox(h, id, 'running')
  })

  test('exec streams output and exits 0, and a failing command exits 1 with the code on stderr', async () => {
    const ok = await sly(['sandbox', 'exec', 'dev', '--', 'echo', 'hi'])
    assert.equal(ok.code, 0, ok.stderr)
    assert.match(ok.stdout, /ran echo hi/)
    const body = JSON.parse(sent('POST', `/sandboxes/${id}/exec`).body)
    assert.deepEqual(body, { command: ['echo', 'hi'], attach: true })
    const bad = await sly(['sandbox', 'exec', 'dev', '--', 'false'])
    assert.equal(bad.code, 1)
    assert.match(bad.stderr, /exit code 1/)
    assert.match(bad.stderr, /EXIT_NONZERO/)
  })

  test('exec passes user, cwd, env and timeout, and --json prints the final run', async () => {
    const result = await sly(['--json', 'sandbox', 'exec', 'dev', '--user', 'agent', '--cwd', '/home/agent', '--env', 'CI=1', '--timeout', '15m', '--', 'printenv', 'CI'])
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(JSON.parse(sent('POST', `/sandboxes/${id}/exec`).body), { command: ['printenv', 'CI'], user: 'agent', cwd: '/home/agent', env: { CI: '1' }, timeout_s: 900, attach: true })
    assert.equal(json(result).status, 'succeeded')
    assert.ok(fake.secrets.some(s => s.purpose === 'run' && s.values.CI === '1'))
  })

  test('exec --detach prints the run and does not stream', async () => {
    const result = await sly(['--json', 'sandbox', 'exec', 'dev', '--detach', '--', 'sleep', '1'])
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(JSON.parse(sent('POST', `/sandboxes/${id}/exec`).body), { command: ['sleep', '1'], attach: false, wait_s: 0 })
    assert.equal(json(result).kind, 'exec')
  })

  test('exec stdin reaches the sandbox', async () => {
    const result = await sly(['sandbox', 'exec', 'dev', '--', 'cat'], 'piped')
    assert.equal(result.code, 0, result.stderr)
  })

  test('logs read the init log and --runtime selects the runtime role', async () => {
    const init = await sly(['sandbox', 'logs', 'dev', '--tail', '5'])
    assert.equal(init.code, 0, init.stderr)
    assert.match(init.stdout, /sandbox init started/)
    assert.match(sent('GET', `sandbox=${id}&role=init&tail=5`).path, /role=init/)
    await sly(['sandbox', 'logs', 'dev', '--runtime'])
    assert.match(server.requests.filter(r => r.path.startsWith('/v1/logs')).at(-1)!.path, /role=runtime/)
  })

  test('network shows connections, --refused only the refused and --dns the resolver log', async () => {
    const all = await sly(['--json', 'sandbox', 'network', 'dev'])
    assert.equal(all.code, 0, all.stderr)
    assert.equal(json(all).sandbox.name, 'dev')
    const refused = await sly(['--json', 'sandbox', 'network', 'dev', '--refused'])
    assert.equal(json(refused)[0].path, 'domain_not_allowed')
    const dns = await sly(['--json', 'sandbox', 'network', 'dev', '--dns'])
    assert.equal(json(dns).untrusted.source, 'resolver log')
  })

  test('explain judges the path from the sandbox and probe sends one DNS query as it', async () => {
    const explained = await sly(['--json', 'sandbox', 'explain', 'dev', '--to', 'registry.npmjs.org:443'])
    assert.equal(explained.code, 0, explained.stderr)
    assert.equal(json(explained).entity.from, 'dev')
    assert.ok(json(explained).hops.some((hop: { hop: string }) => hop.hop === 'firewall'))
    const text = await sly(['sandbox', 'explain', 'dev', '--to', 'registry.npmjs.org', '--port', '443'])
    assert.match(text.stdout, /^dev -> registry\.npmjs\.org:443\/tcp/)
    const probed = await sly(['--json', 'sandbox', 'probe', 'dev', '--to', 'registry.npmjs.org', '--dns'])
    assert.equal(probed.code, 0, probed.stderr)
    assert.equal(json(probed).sandbox, 'dev')
    assert.equal(json(probed).dns.rcode, 'NOERROR')
    assert.equal(sent('POST', '/network/probe').path.includes('/sandboxes/sbx_'), true)
    const bad = await sly(['sandbox', 'probe', 'dev', '--to', 'registry.npmjs.org', '--timeout', '30'])
    assert.notEqual(bad.code, 0)
  })

  test('variables set takes a literal, a reference and sealed values, list and unset follow', async () => {
    await h.call('PATCH', '/v1/projects/alpha/variables', { token: h.admin.token, body: { environment: 'default', set: [{ key: 'GH_TOKEN', kind: 'sealed', value: 'ghp_supersecretvalue1' }] } })
    const set = await sly(['--json', 'sandbox', 'variables', 'set', 'dev', 'MODE=fast', 'GH_TOKEN=${{project.GH_TOKEN}}'])
    assert.equal(set.code, 0, set.stderr)
    assert.deepEqual(JSON.parse(sent('PATCH', `/sandboxes/${id}/variables`).body), {
      set: [
        { key: 'MODE', kind: 'literal', value: 'fast' },
        { key: 'GH_TOKEN', kind: 'reference', reference: '${{project.GH_TOKEN}}' }
      ]
    })
    assert.deepEqual(json(set).variables.map((v: { key: string }) => v.key).sort(), ['GH_TOKEN', 'MODE'])
    const sealed = await sly(['--json', 'sandbox', 'variables', 'set', 'dev', '--sealed', 'API_KEY=abcdefgh12345'])
    assert.equal(sealed.code, 0, sealed.stderr)
    assert.deepEqual(JSON.parse(sent('PATCH', `/sandboxes/${id}/variables`).body), { set: [{ key: 'API_KEY', kind: 'sealed', value: 'abcdefgh12345' }] })
    assert.ok(!sealed.stdout.includes('abcdefgh12345'))
    const listed = await sly(['--json', 'sandbox', 'variables', 'list', 'dev'])
    assert.deepEqual(json(listed).items.map((v: { key: string }) => v.key), ['API_KEY', 'GH_TOKEN', 'MODE'])
    const resolved = await sly(['--json', 'sandbox', 'variables', 'list', 'dev', '--resolved'])
    assert.equal(resolved.code, 0, resolved.stderr)
    assert.equal(json(resolved).sandbox_id, id)
    const unset = await sly(['--json', 'sandbox', 'variables', 'unset', 'dev', 'MODE', 'API_KEY'])
    assert.equal(unset.code, 0, unset.stderr)
    assert.deepEqual(JSON.parse(sent('PATCH', `/sandboxes/${id}/variables`).body), { unset: ['MODE', 'API_KEY'] })
  })

  test('snapshot, snapshots, fork from the snapshot by name and snapshot-delete', async () => {
    const snap = await sly(['--json', 'sandbox', 'snapshot', 'dev', '--name', 'base'])
    assert.equal(snap.code, 0, snap.stderr)
    assert.deepEqual(JSON.parse(sent('POST', `/sandboxes/${id}/snapshots`).body), { name: 'base' })
    assert.equal(json(snap).status, 'ready')
    const snapshotId = json(snap).id
    const bySandbox = await sly(['--json', 'sandbox', 'snapshots', 'dev'])
    assert.equal(json(bySandbox).items.length, 1)
    const all = await sly(['--json', 'sandbox', 'snapshots'])
    assert.equal(json(all).items[0].id, snapshotId)
    const fork = await sly(['--json', 'sandbox', 'fork', 'base', 'dev-b', '--ttl', '1h'])
    assert.equal(fork.code, 0, fork.stderr)
    assert.deepEqual(JSON.parse(sent('POST', '/sandboxes').body), { name: 'dev-b', from: { snapshot: snapshotId }, ttl_s: 3600 })
    assert.equal(json(fork).forked_from.snapshot_id, snapshotId)
    const liveFork = await sly(['--json', 'sandbox', 'fork', 'dev', 'dev-c'])
    assert.equal(liveFork.code, 0, liveFork.stderr)
    assert.deepEqual(JSON.parse(sent('POST', '/sandboxes').body), { name: 'dev-c', from: { sandbox: id } })
    const removed = await sly(['--json', 'sandbox', 'snapshot-delete', 'base'])
    assert.equal(removed.code, 0, removed.stderr)
    assert.deepEqual(json(removed), { deleted: true })
  })

  test('shell refuses without a terminal', async () => {
    const result = await sly(['sandbox', 'shell', 'dev'])
    assert.equal(result.code, 2)
    assert.match(result.stderr, /needs a terminal/)
  })

  test('forward round trips bytes through the fake station and prints the local address', async () => {
    const child = spawn(process.execPath, [entry, '--project', 'alpha', 'sandbox', 'forward', 'dev', '8080', '--local-port', '0'], { cwd: home, env: env() })
    const address = await new Promise<string>((resolve, reject) => {
      let text = ''
      child.stdout.on('data', chunk => {
        text += chunk
        const line = text.split('\n')[0]
        if (line && text.includes('\n')) resolve(line)
      })
      child.once('exit', code => reject(new Error(`forward exited ${code}`)))
    })
    const [host, port] = address.split(':')
    const echoed = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(port), host!, () => socket.write('ping'))
      socket.on('data', data => {
        resolve(data.toString())
        socket.destroy()
      })
      socket.on('error', reject)
    })
    assert.equal(echoed, 'PING')
    assert.ok(fake.forwarded.some(f => f.port === 8080 && f.data.includes('ping')))
    child.kill('SIGINT')
    await new Promise(resolve => child.once('exit', resolve))
  })

  test('exec on a stopped sandbox is SANDBOX_NOT_RUNNING', async () => {
    await sly(['sandbox', 'stop', 'dev'])
    await waitForSandbox(h, id, 'stopped')
    const result = await sly(['--json', 'sandbox', 'exec', 'dev', '--', 'ls'])
    assert.equal(result.code, 1)
    assert.equal(json(result).error.code, 'SANDBOX_NOT_RUNNING')
  })

  test('create --no-start leaves the sandbox stopped, and delete removes it', async () => {
    const created = await sly(['--json', 'sandbox', 'create', 'idle', '--no-start', '--image', 'x'])
    assert.equal(created.code, 1)
    const idle = await sly(['--json', 'sandbox', 'create', 'idle', '--no-start'])
    assert.equal(idle.code, 0, idle.stderr)
    assert.equal(JSON.parse(sent('POST', '/sandboxes').body).start, false)
    assert.equal(json(idle).status, 'stopped')
    const deleted = await sly(['--json', 'sandbox', 'delete', 'idle'])
    assert.equal(deleted.code, 0, deleted.stderr)
    assert.deepEqual(json(deleted), { deleted: true, snapshots_kept: 0 })
  })
})

describe('platform storage grow', () => {
  test('uses the only sandbox station and parses GiB', async () => {
    server.requests.length = 0
    const result = await sly(['--json', 'platform', 'storage', 'grow', '--size', '150GiB'])
    assert.equal(result.code, 0, result.stderr)
    const request = server.requests.find(r => r.method === 'POST' && r.path.endsWith('/sandbox-storage/grow'))!
    assert.match(request.path, /^\/v1\/stations\/stn_[A-Z0-9]+\/sandbox-storage\/grow$/)
    assert.deepEqual(JSON.parse(request.body), { size_bytes: 150 * 1024 ** 3 })
    assert.equal(json(result).filesystem_bytes, 150 * 1024 ** 3)
  })

  test('a size below the current one is VALIDATION_FAILED at /size_bytes', async () => {
    const result = await sly(['--json', 'platform', 'storage', 'grow', '--size', '10GiB', '--station', 'station-1'])
    assert.equal(result.code, 1)
    assert.equal(json(result).error.code, 'VALIDATION_FAILED')
    assert.match(sent('POST', '/sandbox-storage/grow').path, /\/v1\/stations\/station-1\//)
  })
})
