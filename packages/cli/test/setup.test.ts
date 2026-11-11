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

type Detected = {
  address: string | null
  interface: string | null
  public: boolean
  reason?: string
}

let dir: string
let socketPath: string
let server: Server
let detected: Detected
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
  hostnames: null,
  public_address: params.public_address ?? null,
  litestream: params.litestream
    ? {
        bucket: (params.litestream as { bucket: string }).bucket,
        endpoint: null,
        active: true,
        note: 'replicating Dispatch to the bucket',
      }
    : null,
  reach: ['ssh -L 7900:127.0.0.1:7900 <station>'],
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
        request.op === 'public_address.detect'
          ? detected
          : request.op === 'host.probe'
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
  detected = {
    address: '203.0.113.7',
    interface: 'eth0',
    public: true,
  }
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

const flags = ['--socket', '', '--email', 'admin@example.com', '--password-stdin', '--no-domain']

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

    child.stdin!.end('correct-horse-battery')
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

const domainless: Step[] = [
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
    expect: '◆  Serve the dashboard and API on hostnames of your own domain\\?',
    send: 'n',
  },
  {
    expect: '◆  ACME email',
    send: '\r',
  },
]

describe('sly setup public address, flag form', () => {
  test('--public-address goes to stationd as public_address', async () => {
    const run = await sly([...flags, '--public-address', '203.0.113.9'])

    assert.equal(run.code, 0, run.stderr)
    assert.equal(setups[0]!.public_address, '203.0.113.9')
  })

  test('a malformed --public-address exits 2 before anything is sent', async () => {
    const run = await sly([...flags, '--public-address', '999.1.1.1'])

    assert.equal(run.code, 2)
    assert.match(run.stderr, /not an IPv4 address/)
    assert.equal(setups.length, 0)
  })

  test('--detect-public-address uses the default-route address when it is public', async () => {
    const run = await sly([...flags, '--detect-public-address'])

    assert.equal(run.code, 0, run.stderr)
    assert.equal(setups[0]!.public_address, '203.0.113.7')
  })

  test('--detect-public-address refuses a private default-route address', async () => {
    detected = {
      address: '10.0.0.5',
      interface: 'eth0',
      public: false,
    }
    const run = await sly([...flags, '--detect-public-address'])

    assert.equal(run.code, 2)
    assert.match(run.stderr, /eth0 has 10\.0\.0\.5, which is not a public address/)
    assert.equal(setups.length, 0)
  })

  test('--detect-public-address refuses a host without a default route', async () => {
    detected = {
      address: null,
      interface: null,
      public: false,
      reason: 'the host has no IPv4 default route',
    }
    const run = await sly([...flags, '--detect-public-address'])

    assert.equal(run.code, 2)
    assert.match(run.stderr, /no IPv4 default route/)
  })

  test('the two address flags exclude each other', async () => {
    const run = await sly([...flags, '--public-address', '203.0.113.9', '--detect-public-address'])

    assert.equal(run.code, 2)
    assert.match(run.stderr, /cannot be used with option '--public-address/)
  })

  test('without either flag and without a terminal no address is sent', async () => {
    const run = await sly(flags)

    assert.equal(run.code, 0, run.stderr)
    assert.equal('public_address' in setups[0]!, false)
    assert.match(run.stdout, /no public address set/)
  })
})

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

describe('sly setup sandbox runtime', () => {
  test('without KVM it says why in one line, asks nothing and sends no runtime', async () => {
    const run = await sly(flags)

    assert.equal(run.code, 0, run.stderr)
    assert.match(run.stderr, /^No KVM on this host, so sandboxes run on gVisor$/m)
    assert.equal('sandbox_runtime' in setups[0]!, false)
  })

  test('--sandbox-runtime gvisor goes to stationd as sandbox_runtime', async () => {
    const run = await sly([...flags, '--sandbox-runtime', 'gvisor'])

    assert.equal(run.code, 0, run.stderr)
    assert.equal(setups[0]!.sandbox_runtime, 'gvisor')
  })

  test('a runtime the host does not offer exits 2 before anything is sent', async () => {
    const run = await sly([...flags, '--sandbox-runtime', 'microvm'])

    assert.equal(run.code, 2)
    assert.match(run.stderr, /does not offer the sandbox runtime microvm/)
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
  test('shows the detected public address and accepts it with Enter', async () => {
    const run = await terminal(
      [],
      [
        ...domainless,
        {
          expect: 'default-route interface eth0 has the public address 203\\.0\\.113\\.7',
          send: '',
        },
        {
          expect:
            '◆  station public IPv4 address \\(Enter to accept, or type another\\)\n│  203\\.0\\.113\\.7',
          send: '\r',
        },
        {
          expect: '◆  Litestream bucket',
          send: '\r',
        },
        {
          expect: 'public address 203\\.0\\.113\\.7',
          send: '',
        },
        {
          expect: '◆  Create the admin and apply these settings\\?',
          send: 'y',
        },
        {
          expect: '◆  type "stored"',
          send: 'stored\r',
        },
      ],
    )

    assert.equal(run.failure, null, run.output)
    assert.equal(run.code, 0, run.output)
    assert.equal(setups[0]!.public_address, '203.0.113.7')
    assert.equal('litestream' in setups[0]!, false)
  })

  test('lets the admin edit the address, re-asking until it is IPv4', async () => {
    const run = await terminal(
      [],
      [
        ...domainless,
        {
          expect: '◆  station public IPv4 address',
          send: 'not-an-ip\r',
        },
        {
          expect: 'that is not an IPv4 address in dotted-quad form',
          send: '\u0015198.51.100.20\r',
        },
        {
          expect: '◆  Litestream bucket',
          send: '\r',
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
    assert.equal(run.code, 0, run.output)
    assert.equal(setups[0]!.public_address, '198.51.100.20')
  })

  test('warns about a private default-route address and lets Enter skip it', async () => {
    detected = {
      address: '172.17.0.4',
      interface: 'eth0',
      public: false,
    }
    const run = await terminal(
      [],
      [
        ...domainless,
        {
          expect: 'eth0 has 172\\.17\\.0\\.4, which is not a public address',
          send: '',
        },
        {
          expect: '◆  station public IPv4 address \\(Enter to skip\\)',
          send: '\r',
        },
        {
          expect: '◆  Litestream bucket',
          send: '\r',
        },
        {
          expect: 'none \\(set it later with sly stations update\\)',
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
    assert.equal('public_address' in setups[0]!, false)
  })

  test('asks for a bucket, refuses a public http endpoint and takes the keys with the secret hidden', async () => {
    const run = await terminal(
      [],
      [
        ...domainless,
        {
          expect: '◆  station public IPv4 address',
          send: '\r',
        },
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
