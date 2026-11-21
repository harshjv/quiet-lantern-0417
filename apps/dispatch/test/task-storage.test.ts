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
import { pinPlatform, rows } from './helpers/seed.ts'

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

describe('the OpenAPI document', () => {
  test('lists the task storage grow route with its success schemas', () => {
    const operation = doc.paths['/v1/servers/{server}/task-storage/grow']?.post

    assert.ok(operation, 'POST /v1/servers/{server}/task-storage/grow is missing')
    assert.equal(operation.operationId, 'grow_task_storage')

    for (const status of [200, 202]) {
      assert.ok(
        operation.responses?.[String(status)]?.content?.['application/json']?.schema,
        `no ${status} schema`,
      )
    }

    assert.ok(doc.components.schemas.StorageGrown, 'component StorageGrown is not registered')
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
    assert.ok(doc.components.schemas.ErrorCode.enum.includes('MACHINE_QUOTA_EXCEEDED'))
  })
})

describe('growing task storage', () => {
  const grow = (size_bytes: number, token = h.admin.token) =>
    api(
      'POST',
      '/v1/servers/station-1/task-storage/grow',
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
    assert.equal(
      rows(h, "select id from audit_event where action = 'server.task_storage_grow'").length,
      1,
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
    const reply = await api('POST', '/v1/servers/station-failing/task-storage/grow', {
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
    const reply = await api('POST', '/v1/servers/station-plain/task-storage/grow', {
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
    assert.equal(waiting.body.changes[0].entity, 'task_storage')
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
    const human = await h.call('POST', '/v1/servers/station-1/task-storage/grow', {
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
