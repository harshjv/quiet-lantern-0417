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
import {
  createMachine,
  createPreview,
  createProject,
  pinPlatform,
  placed,
  productionId,
  waitForMachine,
} from './helpers/seed.ts'

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
    machines: true,
  })
  station = await startFakeStation(h, 'station-1', {
    machines: {},
  })
  doc = (await api('GET', '/openapi/json')).body
})

after(async () => h.close())

const routes: [string, string, number[]][] = [
  ['get', '/v1/projects/{project}/machines', [200]],
  ['post', '/v1/projects/{project}/machines', [201]],
  ['get', '/v1/machines/{machine}', [200]],
  ['patch', '/v1/machines/{machine}', [200]],
  ['delete', '/v1/machines/{machine}', [200]],
  ['post', '/v1/machines/{machine}/start', [200]],
  ['post', '/v1/machines/{machine}/stop', [200]],
  ['post', '/v1/machines/{machine}/exec', [201]],
  ['post', '/v1/machines/{machine}/shells', [201]],
  ['get', '/v1/machines/{machine}/runs', [200]],
  ['get', '/v1/machines/{machine}/metrics', [200]],
  ['get', '/v1/machines/{machine}/keys', [200]],
  ['get', '/v1/machines/{machine}/keys/resolved', [200]],
  ['patch', '/v1/machines/{machine}/keys', [200]],
  ['get', '/v1/machines/{machine}/connections', [200]],
  ['get', '/v1/machines/{machine}/dns-log', [200]],
  ['post', '/v1/machines/{machine}/snapshots', [201]],
  ['get', '/v1/machines/{machine}/snapshots', [200]],
  ['get', '/v1/projects/{project}/machine-snapshots', [200]],
  ['get', '/v1/machine-snapshots/{id}', [200]],
  ['delete', '/v1/machine-snapshots/{id}', [200]],
  ['post', '/v1/servers/{server}/machine-storage/grow', [200, 202]],
]

describe('the OpenAPI document', () => {
  test('lists every machine route with its success schema registered as a shared component', () => {
    for (const [method, path, statuses] of routes) {
      const operation = doc.paths[path]?.[method]

      assert.ok(operation, `${method.toUpperCase()} ${path} is missing`)

      for (const status of statuses) {
        const schema = operation.responses?.[String(status)]?.content?.['application/json']?.schema

        assert.ok(schema, `${method.toUpperCase()} ${path} has no ${status} schema`)
      }
    }

    for (const name of [
      'Machine',
      'MachineCreated',
      'MachineDeleted',
      'MachineSnapshot',
      'MachineSnapshotCreated',
      'MachineExec',
      'MachineShell',
      'MachineConnections',
      'MachineKeysOutcome',
      'MachineSnapshotDeleted',
      'StorageGrown',
      'MachineSize',
      'MachineImage',
      'MachineMetricSample',
      'MachineRunOutput',
    ]) {
      assert.ok(doc.components.schemas[name], `component ${name} is not registered`)
    }
  })

  test('every error code and warning of the machine area is in the catalog with the documented status', () => {
    const expected: Record<string, number> = {
      MACHINE_NOT_RUNNING: 409,
      MACHINE_STATE_CONFLICT: 409,
      MACHINE_QUOTA_EXCEEDED: 422,
      MACHINE_DISK_FULL: 422,
      MACHINE_START_FAILED: 422,
      MACHINE_STORAGE_GROW_FAILED: 422,
      MACHINE_IMAGE_UNPACK_FAILED: 422,
    }

    for (const [code, http] of Object.entries(expected)) {
      assert.equal(errorCatalog.find((e) => e.code === code)?.http, http, code)
    }

    assert.ok(warningCatalog.includes('MACHINE_RESTART_REQUIRED'))
    assert.ok(warningCatalog.includes('MACHINE_SNAPSHOT_CRASH_CONSISTENT'))
    assert.ok(doc.components.schemas.ErrorCode.enum.includes('MACHINE_QUOTA_EXCEEDED'))
  })

  test('live replies match their declared schemas, with and without fields', async () => {
    await createProject(h, 'alpha')
    const dev = await createPreview(h, 'alpha', 'dev')
    const box = await createMachine(h, dev.id, {
      name: 'checked',
    })

    await waitForMachine(h, box.id, 'running')
    const exec = await api('POST', `/v1/machines/${box.id}/exec`, {
      command: ['echo', 'x'],
    })
    const snapshot = await api('POST', `/v1/machines/${box.id}/snapshots`, {
      name: 'checked',
    })
    const reads: [string, string][] = [
      ['/v1/machines/{machine}', `/v1/machines/${box.id}`],
      ['/v1/machines/{machine}', `/v1/machines/${box.id}?fields=*`],
      ['/v1/projects/{project}/machines', placed(h, dev.id, `machines?fields=*`)],
      ['/v1/machines/{machine}/runs', `/v1/machines/${box.id}/runs?fields=*`],
      ['/v1/machines/{machine}/metrics', `/v1/machines/${box.id}/metrics`],
      ['/v1/machines/{machine}/connections', `/v1/machines/${box.id}/connections`],
      ['/v1/machines/{machine}/dns-log', `/v1/machines/${box.id}/dns-log`],
      ['/v1/machines/{machine}/snapshots', `/v1/machines/${box.id}/snapshots?fields=*`],
      ['/v1/projects/{project}/machine-snapshots', placed(h, dev.id, `machine-snapshots?fields=*`)],
      ['/v1/machine-snapshots/{id}', `/v1/machine-snapshots/${snapshot.body.id}?fields=*`],
      ['/v1/machines/{machine}/keys', `/v1/machines/${box.id}/keys`],
      ['/v1/machines/{machine}/keys/resolved', `/v1/machines/${box.id}/keys/resolved`],
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
      ['post', '/v1/machines/{machine}/exec', exec],
      ['post', '/v1/machines/{machine}/snapshots', snapshot],
    ]

    for (const [method, path, reply] of writes) {
      const schema = doc.paths[path][method].responses['201'].content['application/json'].schema
      const compiled = compileResponse(schema, doc.components.schemas)

      assert.ok(
        compiled.check(reply.body),
        `${path} does not match its schema: ${compiled.errors(reply.body).join('; ')}`,
      )
    }

    const patched = await api('PATCH', `/v1/machines/${box.id}`, {
      docker: true,
    })
    const patchSchema = compileResponse(
      doc.paths['/v1/machines/{machine}'].patch.responses['200'].content['application/json'].schema,
      doc.components.schemas,
    )

    assert.ok(patchSchema.check(patched.body), patchSchema.errors(patched.body).join('; '))
  })

  test('a request body outside the schema is VALIDATION_FAILED with issue paths', async () => {
    await createProject(h, 'beta')
    const envId = (await createPreview(h, 'beta', 'dev')).id
    const cases: [string, unknown][] = [
      [
        placed(h, envId, `machines`),
        {
          network: 'wan',
        },
      ],
      [
        placed(h, envId, `machines`),
        {
          size: {
            cpu_millis: 1,
          },
        },
      ],
      [
        placed(h, envId, `machines`),
        {
          unknown: true,
        },
      ],
      [
        placed(h, envId, `machines`),
        {
          from: {
            machine: 'a',
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

describe('the project summary', () => {
  test('machine_count and workspace_count count plain machines and workspaces across production and every preview', async () => {
    const counted = await createProject(h, 'counted')
    const empty = await createProject(h, 'uncounted')
    const staging = await createPreview(h, counted.id, 'staging')
    const count = async (id: string) => {
      const list = await api('GET', '/v1/projects')
      const one = await api('GET', `/v1/projects/${id}`)
      const listed = list.body.items.find((p: any) => p.id === id)

      assert.equal(listed.machine_count, one.body.machine_count)
      assert.equal(listed.workspace_count, one.body.workspace_count)

      return [one.body.machine_count, one.body.workspace_count]
    }

    assert.deepEqual(await count(counted.id), [0, 0])
    const first = await h.call('POST', placed(h, productionId(h, counted.id), 'machines'), {
      cookie: h.admin.cookie,
      origin: localOrigin,
      body: {
        name: 'first',
      },
    })

    assert.equal(first.status, 201, first.text)
    await createMachine(h, staging.id, {
      name: 'second',
    })
    await createMachine(h, staging.id, {
      name: 'third',
      workspace: {
        agent: 'claude',
        repository: 'https://github.com/acme/third',
      },
    })
    assert.deepEqual(await count(counted.id), [2, 1])
    assert.deepEqual(await count(empty.id), [0, 0])
  })
})

describe('growing the machine filesystem', () => {
  const grow = (size_bytes: number, token = h.admin.token) =>
    api(
      'POST',
      '/v1/servers/station-1/machine-storage/grow',
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
    const stored = (await api('GET', '/v1/servers/station-1?fields=capabilities')).body.capabilities
      .sandboxes

    assert.equal(stored.filesystem_bytes, 161061273600)
    const inventory = (await api('GET', '/v1/inventory')).body.machine_storage

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
          target: '*',
          level: 'deploy',
        },
      ],
      'deployer',
    )
    const reply = await grow(190 * 1024 ** 3, deploy)

    assert.equal(reply.status, 403)
    assert.equal(reply.body.error.code, 'INSTANCE_SCOPE_REQUIRED')
  })

  test('a failing step comes back as MACHINE_STORAGE_GROW_FAILED naming the step', async () => {
    const failing = await startFakeStation(h, 'station-failing', {
      machines: {
        growFailure: {
          step: 'resize',
          error: 'btrfs: no space',
        },
      },
    })
    const reply = await api('POST', '/v1/servers/station-failing/machine-storage/grow', {
      size_bytes: 150 * 1024 ** 3,
    })

    assert.equal(reply.status, 422)
    assert.equal(reply.body.error.code, 'MACHINE_STORAGE_GROW_FAILED')
    assert.deepEqual(
      [reply.body.error.details.step, reply.body.error.details.error],
      ['resize', 'btrfs: no space'],
    )
    await failing.close()
  })

  test('a station without the capability answers SERVER_CAPABILITY_MISSING', async () => {
    await startFakeStation(h, 'station-plain')
    const reply = await api('POST', '/v1/servers/station-plain/machine-storage/grow', {
      size_bytes: 1 << 40,
    })

    assert.equal(reply.status, 422)
    assert.equal(reply.body.error.code, 'SERVER_CAPABILITY_MISSING')
  })

  test('under platform.protected a non-human grow waits for approval and a human approves it', async () => {
    const set = await h.call('PATCH', '/v1/settings', {
      cookie: h.admin.cookie,
      origin: localOrigin,
      body: {
        'platform.protected': true,
      },
    })

    assert.equal(set.status, 200, set.text)
    const waiting = await grow(180 * 1024 ** 3)

    assert.equal(waiting.status, 202, waiting.text)
    assert.equal(waiting.body.changes[0].entity, 'machine_storage')
    assert.equal(
      station.received.filter(
        (m) => m.type === 'sandbox.storage.grow' && (m.body as any).size_bytes === 180 * 1024 ** 3,
      ).length,
      0,
    )
    const approved = await h.call('POST', `/v1/approvals/${waiting.body.id}/decision`, {
      body: {
        decision: 'approve',
      },
      cookie: h.admin.cookie,
      origin: localOrigin,
    })

    assert.equal(approved.status, 200, approved.text)
    assert.equal(approved.body.grows[0].filesystem_bytes, 193273528320)
    const human = await h.call('POST', '/v1/servers/station-1/machine-storage/grow', {
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
