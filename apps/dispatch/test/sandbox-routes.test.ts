import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { errorCatalog, warningCatalog } from '@stationly/protocol'

import {
  localOrigin,
  mintToken,
  startDispatch,
  startFakeStation,
  type Dispatch,
} from './helpers/dispatch.ts'
import type { FakeStation } from './helpers/fake-station.ts'
import { compileResponse } from './helpers/json-schema.ts'
import { createProject, createSandbox, pinPlatform, waitForSandbox } from './helpers/seed.ts'

let h: Dispatch
let station: FakeStation
let doc: any

const api = (method: string, path: string, body?: unknown, token = h.admin.token) =>
  h.call(method, path, {
    token,
    body,
  })

before(async () => {
  h = await startDispatch()
  pinPlatform(h, {
    sandboxes: true,
  })
  station = await startFakeStation(h, 'station-1', {
    sandboxes: {},
  })
  doc = (await api('GET', '/openapi/json')).body
})

after(async () => h.close())

const routes: [string, string, number[]][] = [
  ['get', '/v1/environments/{environment}/sandboxes', [200]],
  ['post', '/v1/environments/{environment}/sandboxes', [201]],
  ['get', '/v1/sandboxes/{sandbox}', [200]],
  ['patch', '/v1/sandboxes/{sandbox}', [200]],
  ['delete', '/v1/sandboxes/{sandbox}', [200]],
  ['post', '/v1/sandboxes/{sandbox}/start', [200]],
  ['post', '/v1/sandboxes/{sandbox}/stop', [200]],
  ['post', '/v1/sandboxes/{sandbox}/exec', [201]],
  ['post', '/v1/sandboxes/{sandbox}/shells', [201]],
  ['get', '/v1/sandboxes/{sandbox}/runs', [200]],
  ['get', '/v1/sandboxes/{sandbox}/metrics', [200]],
  ['get', '/v1/sandboxes/{sandbox}/variables', [200]],
  ['get', '/v1/sandboxes/{sandbox}/variables/resolved', [200]],
  ['patch', '/v1/sandboxes/{sandbox}/variables', [200]],
  ['get', '/v1/sandboxes/{sandbox}/connections', [200]],
  ['get', '/v1/sandboxes/{sandbox}/dns-log', [200]],
  ['post', '/v1/sandboxes/{sandbox}/snapshots', [201]],
  ['get', '/v1/sandboxes/{sandbox}/snapshots', [200]],
  ['get', '/v1/environments/{environment}/sandbox-snapshots', [200]],
  ['get', '/v1/sandbox-snapshots/{id}', [200]],
  ['delete', '/v1/sandbox-snapshots/{id}', [200]],
  ['post', '/v1/stations/{station}/sandbox-storage/grow', [200, 202]],
]

describe('the OpenAPI document', () => {
  test('lists every sandbox route with its success schema registered as a shared component', () => {
    for (const [method, path, statuses] of routes) {
      const operation = doc.paths[path]?.[method]
      assert.ok(operation, `${method.toUpperCase()} ${path} is missing`)
      for (const status of statuses) {
        const schema = operation.responses?.[String(status)]?.content?.['application/json']?.schema
        assert.ok(schema, `${method.toUpperCase()} ${path} has no ${status} schema`)
      }
    }
    for (const name of [
      'Sandbox',
      'SandboxCreated',
      'SandboxDeleted',
      'SandboxSnapshot',
      'SandboxSnapshotCreated',
      'SandboxExec',
      'SandboxShell',
      'SandboxConnections',
      'SandboxVariablesOutcome',
      'SandboxSnapshotDeleted',
      'StorageGrown',
      'SandboxSize',
      'SandboxImage',
      'SandboxMetricSample',
      'SandboxRunOutput',
    ]) {
      assert.ok(doc.components.schemas[name], `component ${name} is not registered`)
    }
  })

  test('every error code and warning of the sandbox area is in the catalog with the documented status', () => {
    const expected: Record<string, number> = {
      SANDBOX_NOT_RUNNING: 409,
      SANDBOX_STATE_CONFLICT: 409,
      SANDBOX_QUOTA_EXCEEDED: 422,
      SANDBOX_DISK_FULL: 422,
      SANDBOX_START_FAILED: 422,
      SANDBOX_STORAGE_GROW_FAILED: 422,
      SANDBOX_IMAGE_UNPACK_FAILED: 422,
    }
    for (const [code, http] of Object.entries(expected))
      assert.equal(errorCatalog.find((e) => e.code === code)?.http, http, code)
    assert.ok(warningCatalog.includes('SANDBOX_RESTART_REQUIRED'))
    assert.ok(warningCatalog.includes('SANDBOX_SNAPSHOT_CRASH_CONSISTENT'))
    assert.ok(doc.components.schemas.ErrorCode.enum.includes('SANDBOX_QUOTA_EXCEEDED'))
  })

  test('live replies match their declared schemas, with and without fields', async () => {
    const project = await createProject(h, 'alpha')
    const box = await createSandbox(h, project.default_environment_id, {
      name: 'checked',
    })
    await waitForSandbox(h, box.id, 'running')
    const exec = await api('POST', `/v1/sandboxes/${box.id}/exec`, {
      command: ['echo', 'x'],
    })
    const snapshot = await api('POST', `/v1/sandboxes/${box.id}/snapshots`, {
      name: 'checked',
    })
    const reads: [string, string][] = [
      ['/v1/sandboxes/{sandbox}', `/v1/sandboxes/${box.id}`],
      ['/v1/sandboxes/{sandbox}', `/v1/sandboxes/${box.id}?fields=*`],
      [
        '/v1/environments/{environment}/sandboxes',
        `/v1/environments/${project.default_environment_id}/sandboxes?fields=*`,
      ],
      ['/v1/sandboxes/{sandbox}/runs', `/v1/sandboxes/${box.id}/runs?fields=*`],
      ['/v1/sandboxes/{sandbox}/metrics', `/v1/sandboxes/${box.id}/metrics`],
      ['/v1/sandboxes/{sandbox}/connections', `/v1/sandboxes/${box.id}/connections`],
      ['/v1/sandboxes/{sandbox}/dns-log', `/v1/sandboxes/${box.id}/dns-log`],
      ['/v1/sandboxes/{sandbox}/snapshots', `/v1/sandboxes/${box.id}/snapshots?fields=*`],
      [
        '/v1/environments/{environment}/sandbox-snapshots',
        `/v1/environments/${project.default_environment_id}/sandbox-snapshots?fields=*`,
      ],
      ['/v1/sandbox-snapshots/{id}', `/v1/sandbox-snapshots/${snapshot.body.id}?fields=*`],
      ['/v1/sandboxes/{sandbox}/variables', `/v1/sandboxes/${box.id}/variables`],
      ['/v1/sandboxes/{sandbox}/variables/resolved', `/v1/sandboxes/${box.id}/variables/resolved`],
    ]
    for (const [path, url] of reads) {
      const schema = doc.paths[path].get.responses['200'].content['application/json'].schema
      const reply = await api('GET', url)
      assert.equal(reply.status, 200, `${url}: ${reply.text}`)
      const compiled = compileResponse(schema, doc.components.schemas)
      assert.ok(
        compiled.check(reply.body),
        `${url} does not match its schema: ${compiled.errors(reply.body).join('; ')}`,
      )
    }
    const writes: [string, string, any][] = [
      ['post', '/v1/sandboxes/{sandbox}/exec', exec],
      ['post', '/v1/sandboxes/{sandbox}/snapshots', snapshot],
    ]
    for (const [method, path, reply] of writes) {
      const schema = doc.paths[path][method].responses['201'].content['application/json'].schema
      const compiled = compileResponse(schema, doc.components.schemas)
      assert.ok(
        compiled.check(reply.body),
        `${path} does not match its schema: ${compiled.errors(reply.body).join('; ')}`,
      )
    }
    const patched = await api('PATCH', `/v1/sandboxes/${box.id}`, {
      docker: true,
    })
    const patchSchema = compileResponse(
      doc.paths['/v1/sandboxes/{sandbox}'].patch.responses['200'].content['application/json']
        .schema,
      doc.components.schemas,
    )
    assert.ok(patchSchema.check(patched.body), patchSchema.errors(patched.body).join('; '))
  })

  test('a request body outside the schema is VALIDATION_FAILED with issue paths', async () => {
    const project = await createProject(h, 'beta')
    const envId = project.default_environment_id
    const cases: [string, unknown][] = [
      [
        `/v1/environments/${envId}/sandboxes`,
        {
          network: 'wan',
        },
      ],
      [
        `/v1/environments/${envId}/sandboxes`,
        {
          size: {
            cpu_millis: 1,
          },
        },
      ],
      [
        `/v1/environments/${envId}/sandboxes`,
        {
          unknown: true,
        },
      ],
      [
        `/v1/environments/${envId}/sandboxes`,
        {
          from: {
            sandbox: 'a',
            snapshot: 'b',
          },
        },
      ],
    ]
    for (const [path, body] of cases) {
      const reply = await api('POST', path, body)
      assert.equal(reply.status, 400, JSON.stringify(body))
      assert.equal(reply.body.error.code, 'VALIDATION_FAILED')
      assert.ok(reply.body.error.details.issues.length > 0)
    }
  })
})

describe('growing the sandbox filesystem', () => {
  const grow = (size_bytes: number, token = h.admin.token) =>
    api(
      'POST',
      '/v1/stations/station-1/sandbox-storage/grow',
      {
        size_bytes,
      },
      token,
    )

  test('a larger size is grown through stationd and the station capabilities follow', async () => {
    const reply = await grow(150 * 1024 ** 3)
    assert.equal(reply.status, 200, reply.text)
    assert.deepEqual(reply.body, {
      filesystem_bytes: 161061273600,
      filesystem_free_bytes: 139586437120,
    })
    const sent = station.received.filter((m) => m.type === 'sandbox.storage.grow').at(-1)!
      .body as any
    assert.equal(sent.size_bytes, 161061273600)
    const stored = (await api('GET', '/v1/stations/station-1?fields=capabilities')).body
      .capabilities.sandboxes
    assert.equal(stored.filesystem_bytes, 161061273600)
    const inventory = (await api('GET', '/v1/inventory')).body.sandbox_storage
    assert.deepEqual(
      inventory.map((s: any) => [s.backing, s.size_bytes, s.max_size_bytes]),
      [['loop_file', 161061273600, 214748364800]],
    )
  })

  test('a size that is not larger, or above the largest it accepts, is VALIDATION_FAILED at /size_bytes', async () => {
    for (const size of [107374182400, 1, 214748364801]) {
      const reply = await grow(size)
      assert.equal(reply.status, 400, `${size}`)
      assert.equal(reply.body.error.details.issues[0].path, '/size_bytes')
    }
  })

  test('only an instance admin grows it', async () => {
    const deploy = await mintToken(
      h,
      [
        {
          project_id: '*',
          environment_id: '*',
          level: 'deploy',
        },
      ],
      'deployer',
    )
    const reply = await grow(190 * 1024 ** 3, deploy)
    assert.equal(reply.status, 403)
    assert.equal(reply.body.error.code, 'INSTANCE_SCOPE_REQUIRED')
  })

  test('a failing step comes back as SANDBOX_STORAGE_GROW_FAILED naming the step', async () => {
    const failing = await startFakeStation(h, 'station-failing', {
      sandboxes: {
        growFailure: {
          step: 'resize',
          error: 'btrfs: no space',
        },
      },
    })
    const reply = await api('POST', '/v1/stations/station-failing/sandbox-storage/grow', {
      size_bytes: 150 * 1024 ** 3,
    })
    assert.equal(reply.status, 422)
    assert.equal(reply.body.error.code, 'SANDBOX_STORAGE_GROW_FAILED')
    assert.deepEqual(
      [reply.body.error.details.step, reply.body.error.details.error],
      ['resize', 'btrfs: no space'],
    )
    await failing.close()
  })

  test('a station without the capability answers STATION_CAPABILITY_MISSING', async () => {
    await startFakeStation(h, 'station-plain')
    const reply = await api('POST', '/v1/stations/station-plain/sandbox-storage/grow', {
      size_bytes: 1 << 40,
    })
    assert.equal(reply.status, 422)
    assert.equal(reply.body.error.code, 'STATION_CAPABILITY_MISSING')
  })

  test('under platform.protected a non-human grow is staged and a human accepts it', async () => {
    const set = await h.call('PATCH', '/v1/settings', {
      cookie: h.admin.cookie,
      origin: localOrigin,
      body: {
        'platform.protected': true,
      },
    })
    assert.equal(set.status, 200, set.text)
    const staged = await grow(180 * 1024 ** 3)
    assert.equal(staged.status, 202, staged.text)
    assert.equal(staged.body.changes[0].entity, 'sandbox_storage')
    assert.equal(
      station.received.filter(
        (m) => m.type === 'sandbox.storage.grow' && (m.body as any).size_bytes === 180 * 1024 ** 3,
      ).length,
      0,
    )
    const accepted = await h.call('POST', `/v1/staged-changes/${staged.body.id}/accept`, {
      cookie: h.admin.cookie,
      origin: localOrigin,
      body: {},
    })
    assert.equal(accepted.status, 200, accepted.text)
    assert.equal(accepted.body.grows[0].filesystem_bytes, 193273528320)
    const human = await h.call('POST', '/v1/stations/station-1/sandbox-storage/grow', {
      cookie: h.admin.cookie,
      origin: localOrigin,
      body: {
        size_bytes: 200 * 1024 ** 3,
      },
    })
    assert.equal(human.status, 200, human.text)
    await h.call('PATCH', '/v1/settings', {
      cookie: h.admin.cookie,
      origin: localOrigin,
      body: {
        'platform.protected': false,
      },
    })
  })
})
