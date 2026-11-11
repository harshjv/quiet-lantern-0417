import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import {
  serveOverHttp,
  startDispatch,
  startFakeStation,
  type Dispatch,
} from '../../../apps/dispatch/test/helpers/dispatch.ts'
import {
  createEnvironment,
  createProject,
  pinPlatform,
  waitForSandbox,
} from '../../../apps/dispatch/test/helpers/seed.ts'
import { bytes } from '../src/command.ts'

const entry = new URL('../src/index.ts', import.meta.url).pathname

let h: Dispatch
let server: Awaited<ReturnType<typeof serveOverHttp>>
let home: string
let fake: Awaited<ReturnType<typeof startFakeStation>>
let environmentId: string

type Result = { code: number; stdout: string; stderr: string }

const env = (extra: Record<string, string | undefined> = {}) =>
  ({
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    STATIONLY_API_URL: server.url,
    STATIONLY_TOKEN: h.admin.token,
    ...extra,
  }) as NodeJS.ProcessEnv

const sly = (args: string[], input = '') =>
  new Promise<Result>((resolve) => {
    const child = execFile(
      process.execPath,
      [entry, '--project', 'alpha', ...args],
      {
        cwd: home,
        env: env(),
      },
      (error, stdout, stderr) =>
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          stdout,
          stderr,
        }),
    )

    child.stdin?.end(input)
  })

const inSandbox =
  (sandbox: string) =>
  (args: string[], input = '') =>
    sly(['--sandbox', sandbox, ...args], input)

const dev = inSandbox('dev')

const json = (result: Result) => JSON.parse(result.stdout)

const sent = (method: string, suffix: string) =>
  server.requests.filter((r) => r.method === method && r.path.endsWith(suffix)).at(-1)!

const bodyOf = (method: string, suffix: string) => JSON.parse(sent(method, suffix).body)

const admin = async (path: string) =>
  (
    await h.call('GET', path, {
      token: h.admin.token,
    })
  ).body

const assertOk = (result: Result) => assert.equal(result.code, 0, result.stderr)

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'sly-sbx-'))
  h = await startDispatch()
  pinPlatform(h, {
    sandboxes: true,
  })
  fake = await startFakeStation(h, 'station-1', {
    sandboxes: {
      runOutput: (command, vars) => [
        `ran ${command.join(' ')}`,
        ...Object.entries(vars).map(([k, v]) => `${k}=${v}`),
      ],
    },
  })
  server = await serveOverHttp(h, {
    attach: true,
  })
  const project = await createProject(h, 'alpha')

  environmentId = project.default_environment_id
  await createEnvironment(h, 'alpha', 'staging')
})

after(async () => {
  await server.close()
  await h.close()
  rmSync(home, {
    recursive: true,
    force: true,
  })
})

describe('flag parsing', () => {
  test('sizes accept bytes, binary units and short forms', () => {
    assert.equal(bytes('8GiB'), 8 * 1024 ** 3)
    assert.equal(bytes('512MiB'), 512 * 1024 ** 2)
    assert.equal(bytes('64KiB'), 64 * 1024)
    assert.equal(bytes('2TiB'), 2 * 1024 ** 4)
    assert.equal(bytes('4k'), 4 * 1024)
    assert.equal(bytes('1.5g'), 1.5 * 1024 ** 3)
    assert.equal(bytes('2t'), 2 * 1024 ** 4)
    assert.equal(bytes('2147483648'), 2147483648)
    assert.equal(bytes('4'), 4)
    assert.throws(() => bytes('lots'))
    assert.throws(() => bytes('4 parsecs'))
  })
})

const withoutLiveMetrics = (body: unknown): unknown => {
  if (Array.isArray(body)) {
    return body.map(withoutLiveMetrics)
  }

  if (body && typeof body === 'object') {
    return Object.fromEntries(
      Object.entries(body)
        .filter(([key]) => key !== 'metrics')
        .map(([key, value]) => [key, withoutLiveMetrics(value)]),
    )
  }

  return body
}

const sameIgnoringMetrics = (actual: unknown, expected: unknown) =>
  assert.deepEqual(withoutLiveMetrics(actual), withoutLiveMetrics(expected))

describe('lifecycle commands', () => {
  let id = ''
  const nested = () => `/v1/projects/alpha/environments/${environmentId}/sandboxes/dev`

  test('create maps every flag to the request body', async () => {
    server.requests.length = 0
    const result = await sly([
      '--json',
      'sandboxes',
      'create',
      'dev',
      '--size',
      'cpu_millis=4000,memory_bytes=8GiB,disk_bytes=40GiB',
      '--network',
      'environment',
      '--docker',
      '--egress',
      JSON.stringify({
        mode: 'allowlist',
        domains: [
          {
            domain: 'github.com',
            wildcard: false,
            ports: [443, 22],
          },
          {
            domain: 'githubusercontent.com',
            wildcard: true,
          },
        ],
      }),
      '--ttl-s',
      '2h',
    ])

    assertOk(result)
    const request = sent('POST', '/sandboxes')

    assert.equal(request.path, `/v1/environments/${environmentId}/sandboxes`)
    assert.deepEqual(JSON.parse(request.body), {
      name: 'dev',
      size: {
        cpu_millis: 4000,
        memory_bytes: 8 * 1024 ** 3,
        disk_bytes: 40 * 1024 ** 3,
      },
      network: 'environment',
      docker: true,
      egress: {
        mode: 'allowlist',
        domains: [
          {
            domain: 'github.com',
            wildcard: false,
            ports: [443, 22],
          },
          {
            domain: 'githubusercontent.com',
            wildcard: true,
          },
        ],
      },
      ttl_s: 7200,
    })
    const created = json(result)

    assert.equal(created.name, 'dev')
    assert.equal(created.status, 'creating')
    id = created.id
    await waitForSandbox(h, id, 'running')
  })

  test('list and get by name and by id match the REST bodies', async () => {
    const listed = await sly(['--json', 'sandboxes', 'list', '--status', 'running'])

    assertOk(listed)
    sameIgnoringMetrics(
      json(listed),
      await admin(`/v1/environments/${environmentId}/sandboxes?status=running`),
    )
    const byName = await dev(['--json', 'sandboxes', 'get', '--fields', '*'])

    assertOk(byName)
    assert.ok(sent('GET', `${nested()}?fields=*`))
    sameIgnoringMetrics(json(byName), await admin(`/v1/sandboxes/${id}?fields=*`))
    const byId = await inSandbox(id)(['--json', 'sandboxes', 'get'])

    assert.equal(json(byId).id, id)
    assert.ok(sent('GET', `/v1/sandboxes/${id}`))
    const positional = await sly(['--json', 'sandboxes', 'get', 'dev', '--fields', '*'])

    assertOk(positional)
    assert.equal(json(positional).id, id)
    const positionalId = await sly(['--json', 'sandboxes', 'get', id])

    assert.equal(json(positionalId).id, id)
    const human = await sly(['sandboxes', 'list'])

    assertOk(human)
    assert.match(human.stdout, /^ID\s.*\sNAME\s+STATUS\s/)
    assert.match(human.stdout, new RegExp(`^${id}\\s.*\\sdev\\s+running\\s`, 'm'))
  })

  test('update sends only the given fields and an open egress replaces the allowlist', async () => {
    const ttl = await dev(['--json', 'sandboxes', 'update', '--ttl-s', '30m', '--no-docker'])

    assertOk(ttl)
    assert.deepEqual(bodyOf('PATCH', nested()), {
      ttl_s: 1800,
      docker: false,
    })
    const open = await dev([
      '--json',
      'sandboxes',
      'update',
      '--egress',
      'mode=open',
      '--size',
      'memory_bytes=16GiB',
    ])

    assertOk(open)
    assert.deepEqual(bodyOf('PATCH', nested()), {
      size: {
        memory_bytes: 16 * 1024 ** 3,
      },
      egress: {
        mode: 'open',
      },
    })
    assert.equal(json(open).warnings[0].code, 'SANDBOX_RESTART_REQUIRED')
  })

  test('stop, start with a ttl and the --dry-run request', async () => {
    const stopped = await dev(['--json', 'sandboxes', 'stop'])

    assertOk(stopped)
    await waitForSandbox(h, id, 'stopped')
    const dry = await dev(['--dry-run', 'sandboxes', 'start', '--ttl-s', '10m'])

    assertOk(dry)
    assert.equal(JSON.parse(dry.stdout).method, 'POST')
    assert.equal((await admin(`/v1/sandboxes/${id}`)).status, 'stopped')
    const started = await dev(['--json', 'sandboxes', 'start', '--ttl-s', '10m'])

    assertOk(started)
    assert.deepEqual(bodyOf('POST', `${nested()}/start`), {
      ttl_s: 600,
    })
    assert.equal(json(started).ttl_s, 600)
    await waitForSandbox(h, id, 'running')
  })

  test('exec streams output and exits 0, and a failing command exits 1 with the code on stderr', async () => {
    const ok = await dev(['sandboxes', 'exec', '--', 'echo', 'hi'])

    assertOk(ok)
    assert.match(ok.stdout, /ran echo hi/)
    assert.deepEqual(bodyOf('POST', `/sandboxes/${id}/exec`), {
      command: ['echo', 'hi'],
      attach: true,
    })
    const bad = await dev(['sandboxes', 'exec', '--', 'false'])

    assert.equal(bad.code, 1)
    assert.match(bad.stderr, /exit code 1/)
    assert.match(bad.stderr, /EXIT_NONZERO/)
  })

  test('exec passes user, cwd, env and timeout, and --json prints the final run', async () => {
    const result = await dev([
      '--json',
      'sandboxes',
      'exec',
      '--user',
      'agent',
      '--cwd',
      '/home/agent',
      '--env',
      'CI=1',
      '--timeout',
      '15m',
      '--',
      'printenv',
      'CI',
    ])

    assertOk(result)
    assert.deepEqual(bodyOf('POST', `/sandboxes/${id}/exec`), {
      command: ['printenv', 'CI'],
      user: 'agent',
      cwd: '/home/agent',
      env: {
        CI: '1',
      },
      timeout_s: 900,
      attach: true,
    })
    assert.equal(json(result).status, 'succeeded')
    assert.ok(fake.secrets.some((s) => s.purpose === 'run' && s.values.CI === '1'))
  })

  test('exec --detach prints the run and does not stream', async () => {
    const result = await dev(['--json', 'sandboxes', 'exec', '--detach', '--', 'sleep', '1'])

    assertOk(result)
    assert.deepEqual(bodyOf('POST', `/sandboxes/${id}/exec`), {
      command: ['sleep', '1'],
      attach: false,
      wait_s: 0,
    })
    assert.equal(json(result).kind, 'exec')
  })

  test('exec stdin reaches the sandbox', async () => {
    assertOk(await dev(['sandboxes', 'exec', '--', 'cat'], 'piped'))
  })

  test('logs read the init log by default and --role runtime selects the runtime role', async () => {
    const logPath = () => server.requests.filter((r) => r.path.startsWith('/v1/logs')).at(-1)!.path
    const init = await dev(['logs', '--tail', '5'])

    assertOk(init)
    assert.match(init.stdout, /sandbox init started/)
    assert.equal(logPath(), `/v1/logs?sandbox=${id}&tail=5`)
    assertOk(await dev(['logs', '--role', 'runtime']))
    assert.match(logPath(), /role=runtime/)
  })

  test('get-connections shows connections with the refused attempts and get-dns-log the resolver log', async () => {
    const connections = await dev(['--json', 'sandboxes', 'get-connections'])

    assertOk(connections)
    assert.equal(json(connections).sandbox.name, 'dev')
    assert.equal(json(connections).refused[0].path, 'domain_not_allowed')
    const dns = await dev(['--json', 'sandboxes', 'get-dns-log'])

    assertOk(dns)
    assert.equal(json(dns).untrusted.source, 'resolver log')
  })

  test('explain judges the path from the sandbox and probe-network sends one DNS query as it', async () => {
    const explained = await dev(['--json', 'network', 'explain', '--to', 'registry.npmjs.org:443'])

    assertOk(explained)
    assert.equal(json(explained).entity.from, 'dev')
    assert.ok(json(explained).hops.some((hop: { hop: string }) => hop.hop === 'firewall'))
    const text = await dev(['network', 'explain', '--to', 'registry.npmjs.org', '--port', '443'])

    assert.match(text.stdout, /^dev -> registry\.npmjs\.org:443\/tcp/)
    const probed = await dev([
      '--json',
      'sandboxes',
      'probe-network',
      '--to',
      'registry.npmjs.org',
      '--kind',
      'dns',
    ])

    assertOk(probed)
    assert.equal(json(probed).sandbox, 'dev')
    assert.equal(json(probed).dns.rcode, 'NOERROR')
    assert.deepEqual(bodyOf('POST', `${nested()}/network/probe`), {
      to: 'registry.npmjs.org',
      kind: 'dns',
    })
    const bad = await dev([
      'sandboxes',
      'probe-network',
      '--to',
      'registry.npmjs.org',
      '--timeout-s',
      '30',
    ])

    assert.notEqual(bad.code, 0)
  })

  test('variables set takes a literal, a reference and sealed values, list and unset follow', async () => {
    await h.call('PATCH', '/v1/projects/alpha/variables', {
      token: h.admin.token,
      body: {
        environment: 'default',
        set: [
          {
            key: 'GH_TOKEN',
            kind: 'sealed',
            value: 'ghp_supersecretvalue1',
          },
        ],
      },
    })
    const set = await dev([
      '--json',
      'variables',
      'set',
      'MODE=fast',
      'GH_TOKEN=${{project.GH_TOKEN}}',
    ])

    assertOk(set)
    assert.deepEqual(bodyOf('PATCH', `/sandboxes/${id}/variables`), {
      set: [
        {
          key: 'MODE',
          kind: 'literal',
          value: 'fast',
        },
        {
          key: 'GH_TOKEN',
          kind: 'reference',
          reference: '${{project.GH_TOKEN}}',
        },
      ],
    })
    assert.deepEqual(
      json(set)
        .variables.map((v: { key: string }) => v.key)
        .sort(),
      ['GH_TOKEN', 'MODE'],
    )
    const sealed = await dev(['--json', 'variables', 'set', '--sealed', 'API_KEY=abcdefgh12345'])

    assertOk(sealed)
    assert.deepEqual(bodyOf('PATCH', `/sandboxes/${id}/variables`), {
      set: [
        {
          key: 'API_KEY',
          kind: 'sealed',
          value: 'abcdefgh12345',
        },
      ],
    })
    assert.ok(!sealed.stdout.includes('abcdefgh12345'))
    const listed = await dev(['--json', 'sandboxes', 'list-variables'])

    assertOk(listed)
    assert.deepEqual(
      json(listed).items.map((v: { key: string }) => v.key),
      ['API_KEY', 'GH_TOKEN', 'MODE'],
    )
    const resolved = await dev(['--json', 'sandboxes', 'get-resolved-variables'])

    assertOk(resolved)
    assert.equal(json(resolved).sandbox_id, id)
    const unset = await dev([
      '--json',
      'sandboxes',
      'set-variables',
      '--unset',
      'MODE',
      '--unset',
      'API_KEY',
    ])

    assertOk(unset)
    assert.deepEqual(bodyOf('PATCH', `${nested()}/variables`), {
      unset: ['MODE', 'API_KEY'],
    })
  })

  test('snapshot, list-snapshots, fork from the snapshot and the live disk, delete-snapshot', async () => {
    const snap = await dev(['--json', 'sandboxes', 'snapshot', '--name', 'base'])

    assertOk(snap)
    assert.deepEqual(bodyOf('POST', `${nested()}/snapshots`), {
      name: 'base',
    })
    assert.equal(json(snap).status, 'ready')
    const snapshotId = json(snap).id
    const bySandbox = await dev(['--json', 'sandboxes', 'list-snapshots'])

    assert.equal(json(bySandbox).items.length, 1)
    const all = await sly(['--json', 'sandboxes', 'list-environment-snapshots'])

    assert.equal(json(all).items[0].id, snapshotId)
    const fork = await sly([
      '--json',
      'sandboxes',
      'create',
      'dev-b',
      '--from',
      `snapshot=${snapshotId}`,
      '--ttl-s',
      '1h',
    ])

    assertOk(fork)
    assert.deepEqual(bodyOf('POST', '/sandboxes'), {
      name: 'dev-b',
      from: {
        snapshot: snapshotId,
      },
      ttl_s: 3600,
    })
    assert.equal(json(fork).forked_from.snapshot_id, snapshotId)
    const liveFork = await sly([
      '--json',
      'sandboxes',
      'create',
      'dev-c',
      '--from',
      `sandbox=${id}`,
    ])

    assertOk(liveFork)
    assert.deepEqual(bodyOf('POST', '/sandboxes'), {
      name: 'dev-c',
      from: {
        sandbox: id,
      },
    })
    const removed = await sly(['--json', 'sandboxes', 'delete-snapshot', snapshotId])

    assertOk(removed)
    assert.deepEqual(json(removed), {
      deleted: true,
    })
  })

  test('shell refuses without a terminal', async () => {
    const result = await dev(['sandboxes', 'shell'])

    assert.equal(result.code, 2)
    assert.match(result.stderr, /needs a terminal/)
  })

  test('forward round trips bytes through the fake station and prints the local address', async () => {
    const child = spawn(
      process.execPath,
      [
        entry,
        '--project',
        'alpha',
        '--sandbox',
        'dev',
        'sandboxes',
        'forward',
        '8080',
        '--local-port',
        '0',
      ],
      {
        cwd: home,
        env: env(),
      },
    )
    const address = await new Promise<string>((resolve, reject) => {
      let text = ''

      child.stdout.on('data', (chunk) => {
        text += chunk
        const line = text.split('\n')[0]

        if (line && text.includes('\n')) {
          resolve(line)
        }
      })
      child.once('exit', (code) => reject(new Error(`forward exited ${code}`)))
    })
    const [host, port] = address.split(':')
    const echoed = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(port), host, () => socket.write('ping'))

      socket.on('data', (data) => {
        resolve(data.toString())
        socket.destroy()
      })
      socket.on('error', reject)
    })

    assert.equal(echoed, 'PING')
    assert.ok(fake.forwarded.some((f) => f.port === 8080 && f.data.includes('ping')))
    child.kill('SIGINT')
    await new Promise((resolve) => child.once('exit', resolve))
  })

  test('exec on a stopped sandbox is SANDBOX_NOT_RUNNING', async () => {
    await dev(['sandboxes', 'stop'])
    await waitForSandbox(h, id, 'stopped')
    const result = await dev(['--json', 'sandboxes', 'exec', '--', 'ls'])

    assert.equal(result.code, 1)
    assert.equal(json(result).error.code, 'SANDBOX_NOT_RUNNING')
  })

  test('create --no-start leaves the sandbox stopped, and delete removes it', async () => {
    const rejected = await sly([
      '--json',
      'sandboxes',
      'create',
      'idle',
      '--no-start',
      '--image',
      'ref=x',
    ])

    assert.equal(rejected.code, 1)
    const idle = await sly(['--json', 'sandboxes', 'create', 'idle', '--no-start'])

    assertOk(idle)
    assert.equal(bodyOf('POST', '/sandboxes').start, false)
    assert.equal(json(idle).status, 'stopped')
    const updated = await sly(['--json', 'sandboxes', 'update', 'idle', '--ttl-s', '30m'])

    assertOk(updated)
    assert.equal(json(updated).name, 'idle')
    const deleted = await sly(['--json', 'sandboxes', 'delete', 'idle'])

    assertOk(deleted)
    assert.deepEqual(json(deleted), {
      deleted: true,
      snapshots_kept: 0,
    })
  })
})

describe('sandboxes grow-storage', () => {
  const grow = (size: string) =>
    sly(['--json', 'sandboxes', 'grow-storage', 'station-1', '--size-bytes', size])

  test('takes the station by name and parses GiB', async () => {
    server.requests.length = 0
    const result = await grow('150GiB')

    assertOk(result)
    const request = sent('POST', '/sandbox-storage/grow')

    assert.equal(request.path, '/v1/stations/station-1/sandbox-storage/grow')
    assert.deepEqual(JSON.parse(request.body), {
      size_bytes: 150 * 1024 ** 3,
    })
    assert.equal(json(result).filesystem_bytes, 150 * 1024 ** 3)
  })

  test('a size below the current one is VALIDATION_FAILED at /size_bytes', async () => {
    const result = await grow('10GiB')

    assert.equal(result.code, 1)
    assert.equal(json(result).error.code, 'VALIDATION_FAILED')
  })
})
