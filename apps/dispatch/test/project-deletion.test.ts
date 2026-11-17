import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import {
  localOrigin,
  mintToken,
  startDispatch,
  startFakeStation,
  type Dispatch,
} from './helpers/dispatch.ts'
import { FakeRegistry } from './helpers/registry.ts'
import {
  approveWaiting,
  createApp,
  createProject,
  placed,
  productionId,
  rows,
  seedLockfile,
  waitForActive,
} from './helpers/seed.ts'

let h: Dispatch
let registry: FakeRegistry

before(async () => {
  registry = FakeRegistry.install()
  registry.publish('nginx:1.27')
  h = await startDispatch()
  seedLockfile(h)
  await startFakeStation(h)
})

after(async () => {
  await h.close()
  registry.restore()
})

const token = () => h.admin.token
const del = (path: string) =>
  h.call('DELETE', path, {
    token: token(),
  })

describe('project deletion', () => {
  test('a project whose apps were deleted is deleted, and its history rows stay', async () => {
    const project = await createProject(h, 'doomed')
    const envId = productionId(h, project.id)
    const web = await createApp(h, envId, {
      name: 'web',
      ref: 'nginx:1.27',
      ports: [
        {
          port: 80,
        },
      ],
      deploy: true,
    })

    await waitForActive(h, web.id)
    await approveWaiting(
      h,
      await h.call('PATCH', `/v1/projects/${project.id}/keys`, {
        token: token(),
        body: {
          set: [
            {
              name: 'SHARED',
              kind: 'sealed',
              value: 'hunter2hunter2',
            },
          ],
        },
      }),
    )

    const blocked = await del(`/v1/projects/${project.id}`)

    assert.equal(blocked.status, 409)
    assert.equal(blocked.body.error.code, 'DELETE_HAS_DEPENDENTS')

    const removedApp = await approveWaiting(h, await del(`/v1/apps/${web.id}`))

    assert.equal(removedApp.status, 200, removedApp.text)

    const removed = await del(`/v1/projects/${project.id}`)

    assert.equal(removed.status, 200, removed.text)
    assert.deepEqual(removed.body, {
      deleted: true,
    })
    assert.equal(
      (
        await h.call('GET', `/v1/projects/${project.id}`, {
          token: token(),
        })
      ).status,
      404,
    )
    assert.equal(rows(h, 'select id from target where project_id = ?', project.id).length, 0)
    assert.equal(rows(h, 'select id from deployment where app_id = ?', web.id).length > 0, true)
    assert.equal(rows(h, 'select id from key where project_id = ?', project.id).length, 0)
  })

  test('its approvals are kept as the audit trail, waiting ones superseded, and stay readable', async () => {
    const project = await createProject(h, 'audited')
    const envId = productionId(h, project.id)
    const applied = await createApp(h, envId, {
      name: 'first',
      ref: 'nginx:1.27',
      ports: [
        {
          port: 80,
        },
      ],
    })
    const pending = (
      await h.call('POST', placed(h, envId, 'apps'), {
        token: token(),
        body: {
          name: 'second',
          kind: 'web',
          source: {
            type: 'image',
            ref: 'nginx:1.27',
          },
          ports: [
            {
              port: 80,
            },
          ],
          keys: [
            {
              name: 'TOKEN',
              kind: 'sealed',
              value: 'hunter2hunter2',
            },
          ],
          deploy_on_create: false,
        },
      })
    ).body

    assert.equal(pending.status, 'waiting')
    assert.equal(
      rows(h, 'select id from approval_value where approval_id = ?', pending.id).length > 0,
      true,
    )
    const waitingDelete = await del(`/v1/apps/${applied.id}`)

    assert.equal(waitingDelete.status, 202, waitingDelete.text)
    const accepted = await h.call('POST', `/v1/approvals/${waitingDelete.body.id}/decision`, {
      body: {
        decision: 'approve',
      },
      cookie: h.admin.cookie,
      origin: localOrigin,
    })

    assert.equal(accepted.status, 200, accepted.text)

    const kept = rows<{ id: string; status: string }>(
      h,
      'select id, status from approval where project_id = ?',
      project.id,
    )
    const removed = await del(`/v1/projects/${project.id}`)

    assert.equal(removed.status, 200, removed.text)

    const after = rows<{ id: string; status: string }>(
      h,
      'select id, status from approval where project_id = ?',
      project.id,
    )

    assert.deepEqual(after.map((r) => r.id).sort(), kept.map((r) => r.id).sort())
    assert.equal(after.length >= 2, true)
    assert.equal(after.find((r) => r.id === pending.id)!.status, 'superseded')
    assert.equal(
      rows(h, 'select id from approval_value where approval_id = ?', pending.id).length,
      0,
    )
    assert.equal(
      rows(h, "select id from approval where project_id = ? and status = 'waiting'", project.id)
        .length,
      0,
    )

    for (const row of after) {
      const read = await h.call('GET', `/v1/approvals/${row.id}?fields=changes`, {
        token: token(),
      })

      assert.equal(read.status, 200, read.text)
      assert.equal(read.body.project_id, project.id)
      assert.equal(read.body.status, row.status)
      assert.ok(read.body.changes.length > 0)
    }

    const listed = await h.call('GET', '/v1/approvals?status=superseded', {
      token: token(),
    })

    assert.equal(
      listed.body.items.some((i: any) => i.id === pending.id),
      true,
    )

    const accept = await h.call('POST', `/v1/approvals/${pending.id}/decision`, {
      body: {
        decision: 'approve',
      },
      cookie: h.admin.cookie,
      origin: localOrigin,
    })

    assert.equal(accept.body.error.code, 'APPROVAL_SUPERSEDED')
    const other = await createProject(h, 'bystander')
    const scoped = await mintToken(
      h,
      [
        {
          project_id: other.id,
          target: '*',
          level: 'admin',
        },
      ],
      'bystander-admin',
    )

    assert.equal(
      (
        await h.call('GET', `/v1/approvals/${pending.id}`, {
          token: scoped,
        })
      ).status,
      403,
    )
    assert.equal(
      (
        await h.call('GET', `/v1/approvals?status=all&project=${project.id}`, {
          token: scoped,
        })
      ).body.items.length,
      0,
    )
  })
})
