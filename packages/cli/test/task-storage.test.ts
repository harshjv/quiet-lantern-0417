import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
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
  createPreview,
  createProject,
  pinPlatform,
} from '../../../apps/dispatch/test/helpers/seed.ts'
import { bytes } from '../src/command.ts'

const entry = new URL('../src/index.ts', import.meta.url).pathname

let h: Dispatch
let server: Awaited<ReturnType<typeof serveOverHttp>>
let home: string

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

const sly = (args: string[]) =>
  new Promise<Result>((resolve) => {
    execFile(
      process.execPath,
      [entry, '--project', 'alpha', '--preview', 'staging', ...args],
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
  })

const json = (result: Result) => JSON.parse(result.stdout)

const sent = (method: string, suffix: string) =>
  server.requests.filter((r) => r.method === method && r.path.endsWith(suffix)).at(-1)!

const assertOk = (result: Result) => assert.equal(result.code, 0, result.stderr)

before(async () => {
  home = mkdtempSync(join(tmpdir(), 'sly-storage-'))
  h = await startDispatch()
  pinPlatform(h, {
    machines: true,
  })
  await startFakeStation(h, 'station-1', {
    machines: {},
  })
  server = await serveOverHttp(h, {
    attach: true,
  })
  await createProject(h, 'alpha')
  await createPreview(h, 'alpha', 'staging')
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

describe('servers grow-task-storage', () => {
  const grow = (size: string) =>
    sly(['--json', 'servers', 'grow-task-storage', 'station-1', '--size-bytes', size])

  test('takes the station by name and parses GiB', async () => {
    server.requests.length = 0
    const result = await grow('150GiB')

    assertOk(result)
    const request = sent('POST', '/task-storage/grow')

    assert.equal(request.path, '/v1/servers/station-1/task-storage/grow')
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
