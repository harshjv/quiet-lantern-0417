import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'

const entry = new URL('../src/index.ts', import.meta.url).pathname

const requests: string[] = []
const server = createServer((req, res) => {
  requests.push(req.url ?? '')
  res
    .writeHead(200, {
      'content-type': 'application/json',
    })
    .end('{"items":[],"next_cursor":null}')
})
let home: string

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'sly-context-'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
})

after(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(home, {
    recursive: true,
    force: true,
  })
})

const sly = (args: string[], env: Record<string, string>) =>
  new Promise<void>((resolve) => {
    execFile(
      process.execPath,
      [entry, ...args],
      {
        cwd: home,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          XDG_CONFIG_HOME: join(home, 'config'),
          STATIONLY_API_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          STATIONLY_TOKEN: 'tok_test',
          ...env,
        },
      },
      () => resolve(),
    )
  })

test('STATIONLY_PROJECT and STATIONLY_ENVIRONMENT select the target, and a flag overrides them', async () => {
  requests.length = 0
  await sly(['--json', 'sandboxes', 'list'], {
    STATIONLY_PROJECT: 'prj_fromenv',
    STATIONLY_ENVIRONMENT: 'env_fromenv',
  })
  await sly(['--json', 'environments', 'list'], {
    STATIONLY_PROJECT: 'prj_fromenv',
  })
  await sly(['--json', '--environment', 'env_flag', 'sandboxes', 'list'], {
    STATIONLY_PROJECT: 'prj_fromenv',
    STATIONLY_ENVIRONMENT: 'env_fromenv',
  })

  assert.deepEqual(requests, [
    '/v1/environments/env_fromenv/sandboxes',
    '/v1/projects/prj_fromenv/environments',
    '/v1/environments/env_flag/sandboxes',
  ])
})

test('a --project flag drops the environment default of the environment variables', async () => {
  requests.length = 0
  await sly(['--json', '--project', 'prj_flag', 'sandboxes', 'list'], {
    STATIONLY_PROJECT: 'prj_fromenv',
    STATIONLY_ENVIRONMENT: 'env_fromenv',
  })

  assert.ok(requests.length > 0)
  assert.ok(requests.every((url) => !url.includes('env_fromenv')))
  assert.ok(requests.every((url) => !url.includes('prj_fromenv')))
})
