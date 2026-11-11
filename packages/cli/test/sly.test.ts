import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import {
  serveOverHttp,
  startDispatch,
  startFakeStation,
  type Dispatch,
} from '../../../apps/dispatch/test/helpers/dispatch.ts'
import { FakeRegistry } from '../../../apps/dispatch/test/helpers/registry.ts'
import {
  createEnvironment,
  createProject,
  createService,
} from '../../../apps/dispatch/test/helpers/seed.ts'

const entry = new URL('../src/index.ts', import.meta.url).pathname

let h: Dispatch
let registry: FakeRegistry
let server: Awaited<ReturnType<typeof serveOverHttp>>
let home: string

type Result = { code: number; stdout: string; stderr: string }

const sly = (args: string[], env: Record<string, string | undefined> = {}) =>
  new Promise<Result>((resolve) => {
    execFile(
      process.execPath,
      [entry, ...args],
      {
        cwd: home,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          XDG_CONFIG_HOME: join(home, 'config'),
          STATIONLY_API_URL: server.url,
          STATIONLY_TOKEN: h.admin.token,
          ...env,
        },
      },
      (error, stdout, stderr) =>
        resolve({
          code: error ? ((error as { code?: number }).code ?? 1) : 0,
          stdout,
          stderr,
        }),
    )
  })

const lastLine = (text: string) => text.trimEnd().split('\n').at(-1)

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'sly-'))
  registry = FakeRegistry.install()
  registry.publish('nginx:1.27')
  h = await startDispatch()
  await startFakeStation(h)
  server = await serveOverHttp(h)
  await createProject(h, 'alpha')
  await createEnvironment(
    h,
    'alpha',
    'prod',
    {
      protected: true,
    },
    true,
  )
})

after(async () => {
  registry.restore()
  await server.close()
  await h.close()
  rmSync(home, {
    recursive: true,
    force: true,
  })
})

describe('closed stdout', () => {
  test('exits on EPIPE without a stack trace', async () => {
    const child = spawn(process.execPath, [entry, 'version'], {
      cwd: home,
      env: {
        PATH: process.env.PATH,
        HOME: home,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    child.stdout.destroy()
    let stderr = ''

    child.stderr.on('data', (chunk) => (stderr += chunk))
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve))

    assert.equal(stderr, '')
    assert.equal(code, 141)
  })
})

describe('request mapping', () => {
  test('projects list sends GET /v1/projects with the bearer token and a sly user agent', async () => {
    server.requests.length = 0
    const result = await sly(['--json', 'projects', 'list'])

    assert.equal(result.code, 0)
    const sent = server.requests.find((r) => r.path.startsWith('/v1/projects'))!

    assert.equal(sent.method, 'GET')
    assert.equal(sent.headers.get('authorization'), `Bearer ${h.admin.token}`)
    assert.match(sent.headers.get('user-agent') ?? '', /^sly\//)
    const rest = await h.call('GET', '/v1/projects', {
      token: h.admin.token,
    })

    assert.deepEqual(JSON.parse(result.stdout), rest.body)
  })

  test('projects create sends POST with the name and exits 0', async () => {
    server.requests.length = 0
    const result = await sly([
      '--json',
      'projects',
      'create',
      'beta',
      '--default-environment-name',
      'live',
    ])

    assert.equal(result.code, 0, result.stderr)
    const sent = server.requests.find((r) => r.method === 'POST')!

    assert.equal(sent.path, '/v1/projects')
    assert.deepEqual(JSON.parse(sent.body), {
      name: 'beta',
      default_environment_name: 'live',
    })
    assert.equal(JSON.parse(result.stdout).name, 'beta')
  })

  test('services create maps flags, key=value objects and repeated objects to the request body', async () => {
    server.requests.length = 0
    const result = await sly([
      '--project',
      'alpha',
      'services',
      'create',
      'web',
      '--kind',
      'web',
      '--source',
      'type=image,ref=nginx:1.27',
      '--ports',
      'port=80',
      '--no-deploy-on-create',
      '--json',
      '--environment',
      'production',
    ])

    assert.equal(result.code, 0, result.stderr)
    const sent = server.requests.find((r) => r.method === 'POST' && r.path.endsWith('/services'))!

    assert.equal(sent.path, '/v1/projects/alpha/environments/production/services')
    assert.deepEqual(JSON.parse(sent.body), {
      name: 'web',
      kind: 'web',
      deploy_on_create: false,
      source: {
        type: 'image',
        ref: 'nginx:1.27',
      },
      ports: [
        {
          port: 80,
        },
      ],
    })
    const created = JSON.parse(result.stdout)

    assert.equal(created.source.digest.startsWith('sha256:'), true)
  })

  test('an object flag also takes JSON, and a pair without = is a usage error that sends nothing', async () => {
    server.requests.length = 0
    const local = await sly([
      '--project',
      'alpha',
      '--environment',
      'production',
      'services',
      'create',
      'docked',
      '--kind',
      'web',
      '--source',
      '{"type":"local","dockerfile":"Dockerfile"}',
      '--ports',
      'port=3000,protocol=http',
      '--limits',
      'memory_bytes=512MiB',
      '--no-deploy-on-create',
      '--json',
    ])

    assert.equal(local.code, 0, local.stderr)
    const body = JSON.parse(
      server.requests.find((r) => r.method === 'POST' && r.path.endsWith('/services'))!.body,
    )

    assert.deepEqual(body.source, {
      type: 'local',
      dockerfile: 'Dockerfile',
    })
    assert.deepEqual(body.ports, [
      {
        port: 3000,
        protocol: 'http',
      },
    ])
    assert.deepEqual(body.limits, {
      memory_bytes: 512 * 1024 ** 2,
    })
    server.requests.length = 0
    const bad = await sly([
      '--project',
      'alpha',
      '--environment',
      'production',
      'services',
      'create',
      'x',
      '--kind',
      'web',
      '--source',
      'nginx',
      '--json',
    ])

    assert.equal(bad.code, 2, bad.stderr)
    assert.match(bad.stderr, /nginx is not key=value/)
    assert.equal(
      server.requests.some((r) => r.method === 'POST'),
      false,
    )
  })

  test('stations update maps every flag to the request body and sends only what was given', async () => {
    server.requests.length = 0
    const all = await sly([
      'stations',
      'update',
      'station-1',
      '--public-address',
      '203.0.113.9',
      '--concurrency-cap',
      '3',
      '--draining',
      '--intermittent',
      '--json',
    ])

    assert.equal(all.code, 0, all.stderr)
    const sent = server.requests.find(
      (r) => r.method === 'PATCH' && r.path === '/v1/stations/station-1',
    )!

    assert.deepEqual(JSON.parse(sent.body), {
      public_address: '203.0.113.9',
      concurrency_cap: 3,
      draining: true,
      intermittent: true,
    })
    server.requests.length = 0
    const some = await sly([
      'stations',
      'update',
      'station-1',
      '--no-draining',
      '--no-intermittent',
      '--json',
    ])

    assert.equal(some.code, 0, some.stderr)
    assert.deepEqual(JSON.parse(server.requests.find((r) => r.method === 'PATCH')!.body), {
      draining: false,
      intermittent: false,
    })
    assert.equal(JSON.parse(some.stdout).status, 'online')
  })

  test('stations update with no flag is refused by the API', async () => {
    const result = await sly(['stations', 'update', 'station-1', '--json'])

    assert.equal(result.code, 1)
    assert.equal(JSON.parse(result.stdout).error.code, 'VALIDATION_FAILED')
  })

  test('services list resolves names and prints a table in human mode', async () => {
    const result = await sly([
      '--project',
      'alpha',
      '--environment',
      'production',
      'services',
      'list',
    ])

    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /NAME/)
    assert.match(result.stdout, /web/)
  })

  test('a service given by name is one call to its nested path', async () => {
    server.requests.length = 0
    const result = await sly([
      '--project',
      'alpha',
      '--environment',
      'production',
      '--service',
      'web',
      '--json',
      'services',
      'stop',
    ])

    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(
      server.requests.map((r) => `${r.method} ${r.path}`),
      ['POST /v1/projects/alpha/environments/production/services/web/stop'],
    )
    assert.equal(JSON.parse(result.stdout).desired_state, 'stopped')
  })

  test('--dry-run prints the request, redacts the token and sends nothing', async () => {
    server.requests.length = 0
    const result = await sly(['--dry-run', 'projects', 'create', 'ghost'])

    assert.equal(result.code, 0)
    const shown = JSON.parse(result.stdout)

    assert.equal(shown.method, 'POST')
    assert.equal(shown.headers.authorization, 'Bearer [redacted]')
    assert.deepEqual(shown.body, {
      name: 'ghost',
    })
    assert.equal(server.requests.filter((r) => r.method === 'POST').length, 0)
    const projects = await h.call('GET', '/v1/projects?name=ghost', {
      token: h.admin.token,
    })

    assert.deepEqual(projects.body.items, [])
  })

  test('version prints JSON and never contacts Dispatch', async () => {
    server.requests.length = 0
    const result = await sly(['--json', 'version'])

    assert.equal(result.code, 0)
    assert.ok(JSON.parse(result.stdout).version)
    assert.equal(server.requests.length, 0)
  })
})

describe('exit codes', () => {
  test('an API error prints the envelope code on the last stderr line and exits 1', async () => {
    const result = await sly(['projects', 'create', 'alpha'])

    assert.equal(result.code, 1)
    assert.equal(lastLine(result.stderr), 'NAME_TAKEN')
    assert.match(result.stderr, /^error: /m)
    assert.match(result.stderr, /^fix: /m)
    assert.match(result.stderr, /^request: req_/m)
  })

  test('--json prints the envelope on stdout and still exits 1', async () => {
    const result = await sly(['--json', 'projects', 'create', 'alpha'])

    assert.equal(result.code, 1)
    assert.equal(JSON.parse(result.stdout).error.code, 'NAME_TAKEN')
  })

  test('an unknown command is a usage error, exit 2', async () => {
    const result = await sly(['frobnicate'])

    assert.equal(result.code, 2)
    assert.equal(lastLine(result.stderr), 'USAGE')
  })

  test('--json prints a usage error as an envelope on stdout and still exits 2', async () => {
    const result = await sly(['--json', 'variables', 'set', 'A=b', '--scope', 'nope'])

    assert.equal(result.code, 2)
    assert.equal(JSON.parse(result.stdout).error.code, 'VALIDATION_FAILED')
    assert.equal(lastLine(result.stderr), 'USAGE')
  })

  test('a missing required value without a TTY is a usage error, exit 2', async () => {
    const result = await sly(['services', 'list'])

    assert.equal(result.code, 2)
    assert.equal(lastLine(result.stderr), 'INPUT_REQUIRED')
  })

  test('a staged change in a protected environment exits 3 and says nothing was applied', async () => {
    const result = await sly([
      '--project',
      'alpha',
      '--environment',
      'prod',
      'services',
      'create',
      'api',
      '--kind',
      'web',
      '--source',
      'type=image,ref=nginx:1.27',
      '--ports',
      'port=80',
      '--json',
    ])

    assert.equal(result.code, 3, result.stderr)
    assert.equal(JSON.parse(result.stdout).status, 'staged')
    assert.match(result.stderr, /staged: nothing was applied/)
  })

  test('a rejected token is UNAUTHENTICATED, exit 5', async () => {
    const result = await sly(['projects', 'list'], {
      STATIONLY_TOKEN: 'sly_wrongwrongwrong',
    })

    assert.equal(result.code, 5)
    assert.equal(lastLine(result.stderr), 'UNAUTHENTICATED')
  })

  test('no instance and no credential is UNAUTHENTICATED, exit 5', async () => {
    const result = await sly(['projects', 'list'], {
      STATIONLY_API_URL: undefined,
      STATIONLY_TOKEN: undefined,
    })

    assert.equal(result.code, 5)
    assert.equal(lastLine(result.stderr), 'UNAUTHENTICATED')
  })

  test('an unreachable Dispatch is CONNECTION_FAILED, exit 5', async () => {
    const closed = createServer()

    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const port = (closed.address() as AddressInfo).port

    await new Promise<void>((resolve) => closed.close(() => resolve()))
    const result = await sly(['projects', 'list'], {
      STATIONLY_API_URL: `http://127.0.0.1:${port}`,
    })

    assert.equal(result.code, 5)
    assert.equal(lastLine(result.stderr), 'CONNECTION_FAILED')
    assert.match(result.stderr, /could not be reached/)
  })

  test('a proxy 502 without an envelope is CONNECTION_FAILED, exit 5', async () => {
    const proxy = createServer((_, res) => res.writeHead(502).end('bad gateway'))

    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const result = await sly(['projects', 'list'], {
      STATIONLY_API_URL: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    })

    proxy.closeAllConnections()
    await new Promise<void>((resolve) => proxy.close(() => resolve()))
    assert.equal(result.code, 5)
    assert.equal(lastLine(result.stderr), 'CONNECTION_FAILED')
  })

  test('a 500 without an envelope is INTERNAL_ERROR, exit 1', async () => {
    const broken = createServer((_, res) =>
      res
        .writeHead(500, {
          'content-type': 'application/json',
        })
        .end('{}'),
    )

    await new Promise<void>((resolve) => broken.listen(0, '127.0.0.1', resolve))
    const result = await sly(['projects', 'list'], {
      STATIONLY_API_URL: `http://127.0.0.1:${(broken.address() as AddressInfo).port}`,
    })

    broken.closeAllConnections()
    await new Promise<void>((resolve) => broken.close(() => resolve()))
    assert.equal(result.code, 1)
    assert.equal(lastLine(result.stderr), 'INTERNAL_ERROR')
  })
})

describe('generated commands', () => {
  let service: { id: string }

  before(async () => {
    const project = await h.call('GET', '/v1/projects/alpha', {
      token: h.admin.token,
    })

    service = await createService(h, project.body.default_environment_id, {
      name: 'store',
      kind: 'worker',
      ref: 'nginx:1.27',
      extra: {
        strategy: 'replace',
      },
    })
  })

  test('volumes add --service <id> --mount-path /data --json sends POST /v1/services/{id}/volumes', async () => {
    server.requests.length = 0
    const result = await sly([
      'volumes',
      'add',
      '--service',
      service.id,
      '--mount-path',
      '/data',
      '--json',
    ])

    assert.equal(result.code, 0, result.stderr)
    const sent = server.requests.filter((r) => r.method === 'POST')

    assert.equal(sent.length, 1)
    assert.equal(sent[0]!.path, `/v1/services/${service.id}/volumes`)
    assert.deepEqual(JSON.parse(sent[0]!.body), {
      mount_path: '/data',
    })
    assert.match(sent[0]!.headers.get('idempotency-key') ?? '', /.+/)
    const volume = JSON.parse(result.stdout)

    assert.equal(volume.mount_path, '/data')
    const rest = await h.call('GET', `/v1/services/${service.id}/volumes`, {
      token: h.admin.token,
    })

    assert.ok(rest.body.items.some((v: { id: string }) => v.id === volume.id))
  })

  test('a service given by name resolves through the nested project path', async () => {
    server.requests.length = 0
    const result = await sly([
      '--project',
      'alpha',
      '--service',
      'store',
      'volumes',
      'list-service',
    ])

    assert.equal(result.code, 0, result.stderr)
    assert.ok(
      server.requests.some((r) =>
        /^\/v1\/projects\/alpha\/environments\/env_[A-Z0-9]+\/services\/store\/volumes$/.test(
          r.path,
        ),
      ),
    )
    const [header, row] = result.stdout.split('\n')

    assert.match(
      header!,
      /^ID\s+OWNER\s+SERVICE ID\s+STATION ID\s+MOUNT PATH\s+SIZE BYTES\s+STATUS$/,
    )
    assert.match(row!, /^vol_\S+\s+service\s+svc_\S+\s+\S+\s+\/data\s/)
    assert.doesNotMatch(result.stdout, /RETAIN UNTIL|[{}"]/)
  })

  test('an entity prints as aligned keys and values, and --json prints the response unmodified', async () => {
    const listed = await sly(['--service', service.id, '--json', 'volumes', 'list-service'])
    const volume = JSON.parse(listed.stdout).items[0]
    const human = await sly(['volumes', 'get', volume.id])

    assert.equal(human.code, 0, human.stderr)
    assert.match(human.stdout, /^id\s+vol_/m)
    assert.match(human.stdout, /^mount_path\s+\/data$/m)
    const starts = human.stdout
      .trimEnd()
      .split('\n')
      .map((line) => /^\S+\s+/.exec(line)![0].length)

    assert.equal(new Set(starts).size, 1, human.stdout)
    const json = await sly(['--json', 'volumes', 'get', volume.id])

    assert.deepEqual(
      JSON.parse(json.stdout),
      (
        await h.call('GET', `/v1/volumes/${volume.id}`, {
          token: h.admin.token,
        })
      ).body,
    )
  })

  test('--dry-run prints the request with positional arguments and sends nothing', async () => {
    server.requests.length = 0
    const result = await sly(['--dry-run', 'volumes', 'remove', 'vol_01JC7ZABCDEFGHJKMNPQRSTVWX'])

    assert.equal(result.code, 0, result.stderr)
    const shown = JSON.parse(result.stdout)

    assert.equal(shown.method, 'DELETE')
    assert.match(shown.url, /\/v1\/volumes\/vol_01JC7ZABCDEFGHJKMNPQRSTVWX$/)
    assert.equal(shown.headers.authorization, 'Bearer [redacted]')
    assert.equal(server.requests.length, 0)
  })

  test('an API error goes through the shared handler and exits 1', async () => {
    const result = await sly(['volumes', 'get', 'vol_01JC7ZABCDEFGHJKMNPQRSTVWX'])

    assert.equal(result.code, 1)
    assert.equal(lastLine(result.stderr), 'NOT_FOUND')
  })

  test('a flag typed integer refuses text as a usage error, exit 2', async () => {
    const result = await sly(['ports', 'add', '--service', service.id, '--port', 'eighty'])

    assert.equal(result.code, 2)
    assert.match(result.stderr, /eighty is not a number/)
  })
})

describe('idempotency', () => {
  const requestOf = async (req: IncomingMessage) => {
    const chunks: Buffer[] = []

    for await (const chunk of req) {
      chunks.push(chunk as Buffer)
    }

    return new Request(`${server.url}${req.url}`, {
      method: req.method,
      headers: req.headers as Record<string, string>,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    })
  }

  const lossyProxy = async (dropFirstResponses: number) => {
    const seen: { method: string; key: string | null }[] = []
    let dropped = 0
    const relay = async (req: IncomingMessage, res: ServerResponse) => {
      const request = await requestOf(req)

      seen.push({
        method: request.method,
        key: request.headers.get('idempotency-key'),
      })
      const response = await h.fetch(request)

      if (request.method === 'POST' && dropped < dropFirstResponses) {
        dropped++
        req.socket.destroy()

        return
      }

      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(Buffer.from(await response.arrayBuffer()))
    }
    const proxy = createServer((req, res) => void relay(req, res))

    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))

    return {
      seen,
      url: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
      close: async () => {
        proxy.closeAllConnections()
        await new Promise<void>((resolve) => proxy.close(() => resolve()))
      },
    }
  }

  const named = async (name: string) =>
    (
      await h.call('GET', `/v1/projects?name=${name}`, {
        token: h.admin.token,
      })
    ).body.items as unknown[]

  test('every mutating request carries an Idempotency-Key and reads carry none', async () => {
    server.requests.length = 0
    assert.equal((await sly(['--json', 'projects', 'create', 'keyed'])).code, 0)
    assert.equal((await sly(['--json', 'projects', 'list'])).code, 0)
    const post = server.requests.find((r) => r.method === 'POST' && r.path === '/v1/projects')!

    assert.ok(post.headers.get('idempotency-key'))
    assert.equal(
      server.requests
        .find((r) => r.method === 'GET' && r.path.startsWith('/v1/projects'))!
        .headers.get('idempotency-key'),
      null,
    )
  })

  test('each invocation uses a fresh key', async () => {
    server.requests.length = 0
    await sly(['--json', 'projects', 'create', 'fresh-one'])
    await sly(['--json', 'projects', 'create', 'fresh-two'])
    const keys = server.requests
      .filter((r) => r.method === 'POST')
      .map((r) => r.headers.get('idempotency-key'))

    assert.equal(keys.length, 2)
    assert.notEqual(keys[0], keys[1])
  })

  test('a mutation retried after a lost response reuses its key and is applied once', async () => {
    const proxy = await lossyProxy(1)

    try {
      const result = await sly(['--json', 'projects', 'create', 'retried'], {
        STATIONLY_API_URL: proxy.url,
      })

      assert.equal(result.code, 0, result.stderr)
      assert.equal(JSON.parse(result.stdout).name, 'retried')
      const posts = proxy.seen.filter((r) => r.method === 'POST')

      assert.equal(posts.length, 2)
      assert.ok(posts[0]!.key)
      assert.equal(posts[0]!.key, posts[1]!.key)
      assert.equal((await named('retried')).length, 1)
    } finally {
      await proxy.close()
    }
  })

  test('repeated losses keep one key and still apply once', async () => {
    const proxy = await lossyProxy(3)

    try {
      const result = await sly(['--json', 'projects', 'create', 'retried-thrice'], {
        STATIONLY_API_URL: proxy.url,
      })

      assert.equal(result.code, 0, result.stderr)
      const posts = proxy.seen.filter((r) => r.method === 'POST')

      assert.equal(posts.length, 4)
      assert.equal(new Set(posts.map((r) => r.key)).size, 1)
      assert.equal((await named('retried-thrice')).length, 1)
    } finally {
      await proxy.close()
    }
  })
})

describe('time flags', () => {
  test('logs --since 10m, as the phase 1a row writes it, reaches the API and succeeds', async () => {
    server.requests.length = 0
    const result = await sly([
      '--project',
      'alpha',
      '--environment',
      'production',
      '--service',
      'web',
      '--json',
      'logs',
      '--since',
      '10m',
      '--tail',
      '50',
    ])

    assert.equal(result.code, 0, result.stdout + result.stderr)
    const sent = server.requests.find((r) => r.path.startsWith('/v1/logs'))!

    assert.equal(new URL(sent.path, 'http://x').searchParams.get('since'), '10m')
    assert.equal(JSON.parse(result.stdout).untrusted.lines.at(-1).text, 'listening on :3000')
  })

  test('logs --since -1h and an RFC 3339 instant still succeed', async () => {
    for (const since of ['-1h', new Date(Date.now() - 3_600_000).toISOString()]) {
      const result = await sly([
        '--project',
        'alpha',
        '--environment',
        'production',
        '--service',
        'web',
        '--json',
        'logs',
        '--since',
        since,
      ])

      assert.equal(result.code, 0, result.stdout + result.stderr)
    }
  })
})

describe('--json stdout', () => {
  const runStub = async () => {
    const stub = createServer((req, res) => {
      const path = req.url ?? ''

      if (req.method === 'POST' && path.startsWith('/v1/services/svc_STUB/runs')) {
        res.writeHead(201, {
          'content-type': 'application/json',
        })
        res.end(
          JSON.stringify({
            id: 'run_STUB',
            status: 'running',
            exit_code: null,
          }),
        )
      } else if (path.startsWith('/v1/logs')) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
        })
        res.write(
          `id: c1\nevent: log\ndata: ${JSON.stringify({
            at: '2026-11-07T00:00:00Z',
            role: 'service',
            stream: 'stdout',
            text: 'hi',
          })}\n\n`,
        )
        res.end('event: end\ndata: {"reason":"run_finished"}\n\n')
      } else if (path.startsWith('/v1/runs/run_STUB')) {
        res.writeHead(200, {
          'content-type': 'application/json',
        })
        res.end(
          JSON.stringify({
            id: 'run_STUB',
            status: 'succeeded',
            exit_code: 0,
          }),
        )
      } else {
        res.writeHead(404, {
          'content-type': 'application/json',
        })
        res.end(
          JSON.stringify({
            error: {
              code: 'NOT_FOUND',
              explanation: path,
              fix: 'none',
            },
          }),
        )
      }
    })

    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))

    return {
      url: `http://127.0.0.1:${(stub.address() as AddressInfo).port}`,
      close: async () => {
        stub.closeAllConnections()
        await new Promise<void>((resolve) => stub.close(() => resolve()))
      },
    }
  }

  test('sly --json run writes one JSON document to stdout and the log lines to stderr', async () => {
    const stub = await runStub()

    try {
      const result = await sly(['--json', '--service', 'svc_STUB', 'run', '--', 'echo', 'hi'], {
        STATIONLY_API_URL: stub.url,
      })

      assert.equal(result.code, 0, result.stderr)
      assert.deepEqual(JSON.parse(result.stdout), {
        id: 'run_STUB',
        status: 'succeeded',
        exit_code: 0,
      })
      assert.ok(result.stderr.includes('hi'))
    } finally {
      await stub.close()
    }
  })

  test('sly run without --json still prints the log lines to stdout', async () => {
    const stub = await runStub()

    try {
      const result = await sly(['--service', 'svc_STUB', 'run', '--', 'echo', 'hi'], {
        STATIONLY_API_URL: stub.url,
      })

      assert.equal(result.code, 0, result.stderr)
      assert.ok(result.stdout.includes('hi'))
    } finally {
      await stub.close()
    }
  })
  test('sly run prints the output of a run that finished before the stream opened, every time', async () => {
    const stub = await runStub()

    try {
      for (let attempt = 1; attempt <= 5; attempt++) {
        const result = await sly(['--service', 'svc_STUB', 'run', '--', 'echo', 'hi'], {
          STATIONLY_API_URL: stub.url,
        })

        assert.equal(result.code, 0, `attempt ${attempt}: ${result.stderr}`)
        assert.ok(result.stdout.includes(' hi\n'), `attempt ${attempt}: ${result.stdout}`)
        assert.ok(result.stderr.includes('log stream ended: run_finished'), `attempt ${attempt}`)
      }
    } finally {
      await stub.close()
    }
  })
})

describe('waiting and streaming', () => {
  const sample = (at: string) => ({
    service: {
      id: 'svc_LIVE',
      name: 'web',
    },
    deployment_id: null,
    at,
    conntrack: {
      entries: 3,
      stale: false,
      lossy: false,
      truncated: false,
      accounting: true,
      timestamps: true,
    },
    connections: [],
    refused: [],
    refused_truncated: false,
    untrusted: {
      source: 'conntrack',
      names: {},
    },
  })

  const tick = (at: string) =>
    `id: ${at}\nevent: network\ndata: ${JSON.stringify({
      at,
      samples: [sample(at)],
    })}\n\n`

  const stub = async () => {
    const seen: { path: string; accept: string }[] = []
    let polls = 0
    const server = createServer((req, res) => {
      const path = req.url ?? ''

      seen.push({
        path,
        accept: req.headers.accept ?? '',
      })

      if (path.startsWith('/v1/runs/run_WAIT')) {
        polls++
        res.writeHead(200, {
          'content-type': 'application/json',
        })
        res.end(
          JSON.stringify({
            id: 'run_WAIT',
            status: polls < 3 ? 'running' : 'succeeded',
            exit_code: polls < 3 ? null : 0,
            done: polls >= 3,
          }),
        )
      } else if (path === '/v1/doctor') {
        res.writeHead(200, {
          'content-type': 'application/json',
        })
        res.end(
          JSON.stringify({
            status: 'fail',
            checked_at: '2026-11-10T00:00:00Z',
            checks: [],
          }),
        )
      } else if (req.method === 'POST' && path === '/v1/services/svc_LIVE/deployments') {
        res.writeHead(201, {
          'content-type': 'application/json',
        })
        res.end(
          JSON.stringify({
            id: 'dep_LIVE',
            status: 'queued',
          }),
        )
      } else if (path.startsWith('/v1/deployments/dep_LIVE/wait')) {
        res.writeHead(200, {
          'content-type': 'application/json',
        })
        res.end(
          JSON.stringify({
            id: 'dep_LIVE',
            status: 'failed',
            done: true,
          }),
        )
      } else if (path.startsWith('/v1/logs')) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
        })
        res.write(
          `id: c1\nevent: log\ndata: ${JSON.stringify({
            at: '2026-11-10T00:00:00Z',
            role: 'service',
            stream: 'stdout',
            text: 'ready',
          })}\n\n`,
        )
        res.write('event: truncated\ndata: {"cursor":"c0"}\n\n')
        res.end('event: end\ndata: {"reason":"service_deleted"}\n\n')
      } else if (path.startsWith('/v1/environments/env_LIVE/network/live')) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
        })
        res.write(': connected\n\n')
        res.write(tick('2026-11-10T00:00:00Z'))

        if (!req.headers.accept?.includes('text/event-stream')) {
          return
        }

        res.write(tick('2026-11-10T00:00:05Z'))
        res.end('event: end\ndata: {"reason":"replaced by a newer live stream"}\n\n')
      } else {
        res.writeHead(404).end()
      }
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))

    return {
      env: {
        STATIONLY_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      },
      seen,
      close: async () => {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
      },
    }
  }

  const live = [
    '--environment',
    'env_LIVE',
    '--service',
    'svc_LIVE',
    'network',
    'stream-connections',
  ]

  test('--wait repeats a polled operation through the MCP poll loop until done', async () => {
    const dispatch = await stub()

    try {
      const result = await sly(
        ['runs', 'get', 'run_WAIT', '--wait', '--timeout', '1m'],
        dispatch.env,
      )

      assert.equal(result.code, 0, result.stderr)
      const polls = dispatch.seen.filter((r) => r.path.startsWith('/v1/runs/run_WAIT'))

      assert.equal(polls.length, 3)
      assert.ok(
        polls.every((r) => /[?&]wait_s=\d+/.test(r.path)),
        JSON.stringify(polls),
      )
      assert.match(result.stdout, /^status\s+succeeded$/m)
      assert.match(result.stderr, /run_WAIT: waiting up to 60 s/)
      assert.match(result.stderr, /run_WAIT: is running/)
      assert.match(result.stderr, /run_WAIT: done/)
    } finally {
      await dispatch.close()
    }
  })

  test('without --wait a polled operation is one call, and its wait parameter is no flag', async () => {
    const dispatch = await stub()

    try {
      const result = await sly(['--json', 'runs', 'get', 'run_WAIT'], dispatch.env)

      assert.equal(result.code, 0, result.stderr)
      assert.equal(JSON.parse(result.stdout).done, false)
      assert.deepEqual(
        dispatch.seen.map((r) => r.path),
        ['/v1/runs/run_WAIT'],
      )
      const refused = await sly(['runs', 'get', 'run_WAIT', '--wait-s', '5'], dispatch.env)

      assert.equal(refused.code, 2)
    } finally {
      await dispatch.close()
    }
  })

  test('a stream prints its first event with its registered renderer and exits without --follow', async () => {
    const dispatch = await stub()

    try {
      const result = await sly(live, dispatch.env)

      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stdout, /^2026-11-10T00:00:00Z web deployment - conntrack entries 3$/m)
      assert.doesNotMatch(result.stdout, /00:00:05/)
      assert.match(dispatch.seen[0]!.path, /\?service=svc_LIVE$/)
    } finally {
      await dispatch.close()
    }
  })

  test('-f follows a stream through the shared reader until it ends; --json prints each event', async () => {
    const dispatch = await stub()

    try {
      const human = await sly([...live, '-f'], dispatch.env)

      assert.equal(human.code, 0, human.stderr)
      assert.match(human.stdout, /00:00:00Z web deployment/)
      assert.match(human.stdout, /00:00:05Z web deployment/)
      assert.match(human.stderr, /stream ended: replaced by a newer live stream/)
      assert.match(dispatch.seen[0]!.accept, /text\/event-stream/)
      const json = await sly(['--json', ...live, '--follow'], dispatch.env)

      assert.equal(json.code, 0, json.stderr)
      assert.deepEqual(
        json.stdout
          .trimEnd()
          .split('\n')
          .map((line) => JSON.parse(line).at),
        ['2026-11-10T00:00:00Z', '2026-11-10T00:00:05Z'],
      )
    } finally {
      await dispatch.close()
    }
  })

  test('a stream renders its events with the renderer event form and skips the ones it does not show', async () => {
    const dispatch = await stub()

    try {
      const human = await sly(['--service', 'svc_LIVE', 'logs', '-f'], dispatch.env)

      assert.equal(human.code, 0, human.stderr)
      assert.equal(human.stdout, '2026-11-10T00:00:00Z   ready\n')
      assert.match(dispatch.seen.at(-1)!.path, /^\/v1\/logs\?service=svc_LIVE&follow=true$/)
      const json = await sly(['--json', '--service', 'svc_LIVE', 'logs', '-f'], dispatch.env)

      assert.equal(JSON.parse(json.stdout).text, 'ready')
    } finally {
      await dispatch.close()
    }
  })

  test('a renderer sets the exit code: doctor fail exits 1, a failed deployment after --wait exits 4', async () => {
    const dispatch = await stub()

    try {
      const doctor = await sly(['platform', 'doctor'], dispatch.env)

      assert.equal(doctor.code, 1, doctor.stderr)
      assert.match(doctor.stdout, /^doctor fail at /)
      const json = await sly(['--json', 'platform', 'doctor'], dispatch.env)

      assert.equal(json.code, 1)
      const deployed = await sly(['--service', 'svc_LIVE', 'deploy', '--wait'], dispatch.env)

      assert.equal(deployed.code, 4, deployed.stderr)
      assert.match(deployed.stdout, /diagnosis: sly deployments diagnosis dep_LIVE/)
      assert.match(deployed.stderr, /dep_LIVE: done/)
    } finally {
      await dispatch.close()
    }
  })
})
