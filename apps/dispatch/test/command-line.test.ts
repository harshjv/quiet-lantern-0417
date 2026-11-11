import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('../src/dispatch.ts', import.meta.url))
const dir = mkdtempSync(join(tmpdir(), 'sly-dispatch-cli-'))

const dispatch = (args: string[], input?: string) =>
  spawnSync(process.execPath, [entry, ...args], {
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      STATIONLY_MASTER_KEY: randomBytes(32).toString('base64url'),
    },
  })

after(() =>
  rmSync(dir, {
    recursive: true,
    force: true,
  }),
)

test('dispatch --help lists every command and exits 0', () => {
  const run = dispatch(['--help'])

  assert.equal(run.status, 0, run.stderr)

  for (const command of ['serve', 'migrate', 'bootstrap', 'handshake-vectors', 'openapi']) {
    assert.match(run.stdout, new RegExp(`^  ${command}\\b`, 'm'))
  }
})

test('dispatch migrate without --check is a usage error', () => {
  const run = dispatch(['migrate'])

  assert.equal(run.status, 2)
  assert.match(run.stderr, /required option '--check' not specified/)
})

test('dispatch bootstrap refuses a pool with host bits set and names the masked pool', () => {
  const run = dispatch(
    ['bootstrap', '--db', join(dir, 'dispatch.sqlite')],
    JSON.stringify({
      email: 'admin@example.com',
      password: 'correct-horse-battery',
      'ipam.pool': '10.200.5.0/16',
    }),
  )

  assert.equal(run.status, 1, run.stderr)
  assert.deepEqual(JSON.parse(run.stdout), {
    error: {
      code: 'VALIDATION_FAILED',
      explanation: 'ipam.pool 10.200.5.0/16 has host bits set; use 10.200.0.0/16.',
    },
  })
})
