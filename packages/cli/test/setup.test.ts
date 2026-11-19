import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { after, before, beforeEach, describe, test } from 'node:test'

const entry = new URL('../src/index.ts', import.meta.url).pathname
const driver = new URL('./pty.py', import.meta.url).pathname

let dir: string
let socketPath: string
let server: Server
let probe: { host: Record<string, unknown>; runtimes: string[] }
let setups: Record<string, unknown>[]
let recoveryOps: Record<string, unknown>[]

const setupResult = (params: Record<string, unknown>) => ({
  admin_user_id: 'usr_1',
  email: params.email,
  instance_id: 'ins_1',
  login_link: 'http://127.0.0.1:7900/auth/magic-link/verify?token=t',
  login_link_expires_at: '2026-11-07T18:00:00.000Z',
  recovery_key: 'sly-rk-TEST',
  lockfile: null,
  hostnames: {
    ...(params.hostnames as { api: string; dashboard: string }),
    status: 'pending',
  },
  litestream: params.litestream
    ? {
        bucket: (params.litestream as { bucket: string }).bucket,
        endpoint: null,
        active: true,
        note: 'replicating Dispatch to the bucket',
      }
    : null,
  reach: ['ssh -L 7900:127.0.0.1:7900 <server>'],
})

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sly-setup-'))
  socketPath = join(dir, 'stationd.sock')
  server = createServer((socket) => {
    createInterface({
      input: socket,
    }).on('line', (text) => {
      const request = JSON.parse(text) as {
        id: string
        op: string
        params: Record<string, unknown>
      }
      const result =
        request.op === 'host.probe'
          ? probe
          : request.op === 'admin.recovery_key'
            ? (recoveryOps.push(request.params),
              {
                recovery_key: 'sly-rk-TEST',
              })
            : (setups.push(request.params), setupResult(request.params))

      socket.write(
        `${JSON.stringify({
          v: 1,
          id: request.id,
          ok: true,
          result,
        })}\n`,
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
})

beforeEach(() => {
  setups = []
  recoveryOps = []
  probe = {
    host: {
      kvm_present: false,
      kvm_usable: false,
      cpu_virtualization: null,
      hypervisor: null,
      cpu_cores: 4,
      memory_bytes: 8 * 1024 ** 3,
      sandbox_free_bytes: 40 * 1024 ** 3,
    },
    runtimes: ['gvisor'],
  }
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  rmSync(dir, {
    recursive: true,
    force: true,
  })
})

type Run = { code: number; stdout: string; stderr: string }

const tunnelToken = 'tunnel-token-for-tests'

const flags = [
  '--socket',
  '',
  '--email',
  'admin@example.com',
  '--password-stdin',
  '--tunnel-token-stdin',
  '--api-host',
  'api.example.com',
  '--dashboard-host',
  'dash.example.com',
]

const sly = (args: string[], env: Record<string, string> = {}) =>
  new Promise<Run>((resolve) => {
    const child = execFile(
      process.execPath,
      [entry, 'setup', ...args.map((a) => (a === '' ? socketPath : a))],
      {
        env: {
          PATH: process.env.PATH,
          HOME: dir,
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

    child.stdin!.end(`correct-horse-battery\n${tunnelToken}\n`)
  })

type Step = { expect: string; send: string }

const terminal = (args: string[], steps: Step[]) =>
  new Promise<{ code: number; output: string; failure: string | null }>((resolve, reject) => {
    const child = execFile(
      'python3',
      ['-I', driver],
      {
        env: {
          PATH: process.env.PATH,
        },
      },
      (error: Error | null, stdout: string) =>
        error ? reject(error) : resolve(JSON.parse(stdout)),
    )

    child.stdin!.end(
      JSON.stringify({
        argv: [process.execPath, entry, 'setup', '--socket', socketPath, ...args],
        env: {
          PATH: process.env.PATH,
          HOME: dir,
          TERM: 'xterm',
        },
        cwd: dir,
        steps,
        timeout: 30,
      }),
    )
  })

const prompts: Step[] = [
  {
    expect: '◆  admin email',
    send: 'admin@example.com\r',
  },
  {
    expect: '◆  admin password \\([^)]*\\)',
    send: 'correct-horse-battery\r',
  },
  {
    expect: '◆  repeat the password',
    send: 'correct-horse-battery\r',
  },
  {
    expect: '◆  Cloudflare Tunnel token',
    send: `${tunnelToken}\r`,
  },
  {
    expect: '◆  API hostname',
    send: 'api.example.com\r',
  },
  {
    expect: '◆  dashboard hostname',
    send: '\r',
  },
]

describe('sly setup Litestream bucket, flag form', () => {
  const bucket = ['--litestream-bucket', 'sly-dispatch']
  const keys = {
    LITESTREAM_ACCESS_KEY_ID: 'AKID',
    LITESTREAM_SECRET_ACCESS_KEY: 'SECRET',
  }

  test('an http endpoint on a private address is accepted', async () => {
    const run = await sly(
      [...flags, ...bucket, '--litestream-endpoint', 'http://10.0.0.5:9000'],
      keys,
    )

    assert.equal(run.code, 0, run.stderr)
    assert.deepEqual(setups[0]!.litestream, {
      bucket: 'sly-dispatch',
      endpoint: 'http://10.0.0.5:9000',
      access_key: 'AKID',
      secret_key: 'SECRET',
    })
    assert.match(run.stdout, /Litestream bucket sly-dispatch: replicating Dispatch to the bucket/)
  })

  test('an http endpoint on a public address is refused', async () => {
    const run = await sly(
      [...flags, ...bucket, '--litestream-endpoint', 'http://8.8.8.8:9000'],
      keys,
    )

    assert.equal(run.code, 2)
    assert.match(run.stderr, /private or loopback/)
    assert.equal(setups.length, 0)
  })

  test('an https endpoint such as R2 is accepted', async () => {
    const run = await sly(
      [...flags, ...bucket, '--litestream-endpoint', 'https://abc.r2.cloudflarestorage.com'],
      keys,
    )

    assert.equal(run.code, 0, run.stderr)
  })
})

describe('sly setup machine runtime', () => {
  test('without KVM it says why in one line, asks nothing and sends no runtime', async () => {
    const run = await sly(flags)

    assert.equal(run.code, 0, run.stderr)
    assert.match(run.stderr, /^No KVM on this host, so machines run on gVisor$/m)
    assert.equal('sandbox_runtime' in setups[0]!, false)
  })

  test('--machine-runtime gvisor goes to stationd as sandbox_runtime', async () => {
    const run = await sly([...flags, '--machine-runtime', 'gvisor'])

    assert.equal(run.code, 0, run.stderr)
    assert.equal(setups[0]!.sandbox_runtime, 'gvisor')
  })

  test('a runtime the host does not offer exits 2 before anything is sent', async () => {
    const run = await sly([...flags, '--machine-runtime', 'microvm'])

    assert.equal(run.code, 2)
    assert.match(run.stderr, /does not offer the machine runtime microvm/)
    assert.equal(setups.length, 0)
  })

  test('on bare metal with KVM it shows the trade-offs and marks micro-VMs as not installed', async () => {
    probe.host = {
      ...probe.host,
      kvm_present: true,
      kvm_usable: true,
      cpu_virtualization: 'vmx',
      memory_bytes: 64 * 1024 ** 3,
    }
    const run = await sly(flags)

    assert.equal(run.code, 0, run.stderr)
    assert.match(run.stderr, /bare metal with KVM and 64 GiB of memory, which suits micro-VMs/)
    assert.match(run.stderr, /Micro-VM, recommended for this host, not installed in this release/)
    assert.match(run.stderr, /\+ Full Linux compatibility, with native Docker and databases/)
    assert.equal('sandbox_runtime' in setups[0]!, false)
  })
})

describe('sly setup on a terminal', () => {
  test('asks for a bucket, refuses a public http endpoint and takes the keys with the secret hidden', async () => {
    const run = await terminal(
      [],
      [
        ...prompts,
        {
          expect: '◆  Litestream bucket',
          send: 'sly-dispatch\r',
        },
        {
          expect: '◆  S3 endpoint URL \\(Enter for AWS S3; R2 is [^)]*\\)',
          send: 'http://8.8.8.8:9000\r',
        },
        {
          expect: 'private or loopback address',
          send: '\u0015http://10.0.0.5:9000\r',
        },
        {
          expect: '◆  bucket access key id',
          send: 'AKID\r',
        },
        {
          expect: '◆  bucket secret access key',
          send: 'SECRETVALUE\r',
        },
        {
          expect: 'Litestream     sly-dispatch at http://10\\.0\\.0\\.5:9000',
          send: '',
        },
        {
          expect: '◆  Create the admin',
          send: 'y',
        },
        {
          expect: '◆  type "stored"',
          send: 'stored\r',
        },
      ],
    )

    assert.equal(run.failure, null, run.output)
    assert.deepEqual(setups[0]!.litestream, {
      bucket: 'sly-dispatch',
      endpoint: 'http://10.0.0.5:9000',
      access_key: 'AKID',
      secret_key: 'SECRETVALUE',
    })
    assert.equal(run.output.includes('SECRETVALUE'), false, 'the secret was echoed')
  })
})

const recoveryKey = (args: string[]) =>
  new Promise<Run>((resolve) => {
    execFile(
      process.execPath,
      [entry, ...args.map((a) => (a === '' ? socketPath : a))],
      {
        env: {
          PATH: process.env.PATH,
          HOME: dir,
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

describe('sly admin recovery-key', () => {
  test('asks stationd for the key and prints it alone on stdout', async () => {
    const run = await recoveryKey(['admin', 'recovery-key', '--socket', ''])

    assert.equal(run.code, 0, run.stderr)
    assert.equal(run.stdout, 'sly-rk-TEST\n')
    assert.match(run.stderr, /audit/)
    assert.deepEqual(recoveryOps, [{}])
  })

  test('prints a JSON document with --json', async () => {
    const run = await recoveryKey(['--json', 'admin', 'recovery-key', '--socket', ''])

    assert.equal(run.code, 0, run.stderr)
    assert.deepEqual(JSON.parse(run.stdout), {
      recovery_key: 'sly-rk-TEST',
    })
    assert.equal(run.stderr, '')
  })

  test('exits 5 with CONNECTION_FAILED when stationd is not listening', async () => {
    const run = await recoveryKey(['admin', 'recovery-key', '--socket', join(dir, 'missing.sock')])

    assert.equal(run.code, 5)
    assert.match(run.stderr, /CONNECTION_FAILED/)
  })
})
