import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { localOrigin, mintToken, startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import { FakeRegistry } from './helpers/registry.ts'
import { createProject, createService, rows, seedLockfile, waitForDeployment } from './helpers/seed.ts'

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
const del = (path: string) => h.call('DELETE', path, { token: token() })

describe('project deletion', () => {
  test('a project whose services were deleted is deleted, and its history rows stay', async () => {
    const project = await createProject(h, 'doomed')
    const envId = project.default_environment_id as string
    const web = await createService(h, envId, { name: 'web', ref: 'nginx:1.27', ports: [{ port: 80 }], deploy: true })
    await waitForDeployment(h, web.deployments[0].id, 'active')
    await h.call('PATCH', `/v1/projects/${project.id}/variables`, { token: token(), body: { environment: 'default', set: [{ key: 'SHARED', kind: 'sealed', value: 'hunter2hunter2' }] } })

    const blocked = await del(`/v1/projects/${project.id}`)
    assert.equal(blocked.status, 409)
    assert.equal(blocked.body.error.code, 'DELETE_HAS_DEPENDENTS')

    const removedService = await del(`/v1/services/${web.id}`)
    assert.equal(removedService.status, 200, removedService.text)

    const removed = await del(`/v1/projects/${project.id}`)
    assert.equal(removed.status, 200, removed.text)
    assert.deepEqual(removed.body, { deleted: true })
    assert.equal((await h.call('GET', `/v1/projects/${project.id}`, { token: token() })).status, 404)
    assert.equal(rows(h, 'select id from environment where project_id = ?', project.id).length, 0)
    assert.equal(rows(h, 'select id from deployment where service_id = ?', web.id).length > 0, true)
    assert.equal(rows(h, 'select id from variable where project_id = ?', project.id).length, 0)
  })

  test('its staged changes are kept as the audit trail, pending ones superseded, and stay readable', async () => {
    const project = await createProject(h, 'audited')
    const envId = project.default_environment_id as string
    const applied = await createService(h, envId, { name: 'first', ref: 'nginx:1.27', ports: [{ port: 80 }] })
    const protect = await h.call('PATCH', `/v1/environments/${envId}`, { cookie: h.admin.cookie, origin: localOrigin, body: { protected: true } })
    assert.equal(protect.status, 200, protect.text)
    const pending = await createService(h, envId, { name: 'second', ref: 'nginx:1.27', ports: [{ port: 80 }], variables: [{ key: 'TOKEN', kind: 'sealed', value: 'hunter2hunter2' }] })
    assert.equal(pending.status, 'staged')
    assert.equal(rows(h, 'select id from staged_value where staged_change_id = ?', pending.id).length > 0, true)
    const stagedDelete = await del(`/v1/services/${applied.id}`)
    assert.equal(stagedDelete.status, 202, stagedDelete.text)
    const accepted = await h.call('POST', `/v1/staged-changes/${stagedDelete.body.id}/accept`, { cookie: h.admin.cookie, origin: localOrigin })
    assert.equal(accepted.status, 200, accepted.text)
    const lift = await h.call('PATCH', `/v1/environments/${envId}`, { cookie: h.admin.cookie, origin: localOrigin, body: { protected: false } })
    assert.equal(lift.status, 200, lift.text)

    const kept = rows<{ id: string; status: string }>(h, 'select id, status from staged_change where environment_id = ?', envId)
    const removed = await del(`/v1/projects/${project.id}`)
    assert.equal(removed.status, 200, removed.text)

    const after = rows<{ id: string; status: string }>(h, 'select id, status from staged_change where environment_id = ?', envId)
    assert.deepEqual(after.map(r => r.id).sort(), kept.map(r => r.id).sort())
    assert.equal(after.length >= 2, true)
    assert.equal(after.find(r => r.id === pending.id)!.status, 'superseded')
    assert.equal(rows(h, 'select id from staged_value where staged_change_id = ?', pending.id).length, 0)
    assert.equal(rows(h, "select id from staged_change where environment_id = ? and status = 'staged'", envId).length, 0)

    for (const row of after) {
      const read = await h.call('GET', `/v1/staged-changes/${row.id}?fields=changes`, { token: token() })
      assert.equal(read.status, 200, read.text)
      assert.equal(read.body.environment_id, envId)
      assert.equal(read.body.status, row.status)
      assert.ok(read.body.changes.length > 0)
    }
    const listed = await h.call('GET', '/v1/staged-changes?status=superseded', { token: token() })
    assert.equal(listed.body.items.some((i: any) => i.id === pending.id), true)

    const accept = await h.call('POST', `/v1/staged-changes/${pending.id}/accept`, { cookie: h.admin.cookie, origin: localOrigin })
    assert.equal(accept.body.error.code, 'STAGED_CHANGE_SUPERSEDED')
    const other = await createProject(h, 'bystander')
    const scoped = await mintToken(h, [{ project_id: other.id, environment_id: '*', level: 'admin' }], 'bystander-admin')
    assert.equal((await h.call('GET', `/v1/staged-changes/${pending.id}`, { token: scoped })).status, 403)
    assert.equal((await h.call('GET', `/v1/environments/${envId}/staged-changes`, { token: token() })).status, 404)
  })
})
