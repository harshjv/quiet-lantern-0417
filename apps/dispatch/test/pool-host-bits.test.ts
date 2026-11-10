import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { setupInstance } from '../src/auth/bootstrap.ts'
import { storedSetting } from '../src/db/settings.ts'
import { installProposalProblem } from '../src/station/server.ts'

import { adminEmail, adminPassword, startDispatch, type Dispatch } from './helpers/dispatch.ts'

const unmasked = '10.200.5.0/16'
const suggestion = 'use 10.200.0.0/16'

let h: Dispatch
let fresh: Dispatch

before(async () => {
  h = await startDispatch()
  fresh = await startDispatch({
    setup: false,
  })
})

after(async () => {
  await Promise.all([h.close(), fresh.close()])
})

test('setup refuses a pool with host bits set and stores nothing', async () => {
  await assert.rejects(
    setupInstance(
      fresh.deps,
      {
        email: adminEmail,
        password: adminPassword,
        'ipam.pool': unmasked,
      },
      {
        type: 'system',
        id: null,
        client: 'test',
      },
    ),
    {
      code: 'VALIDATION_FAILED',
      message: `ipam.pool ${unmasked} has host bits set; ${suggestion}.`,
    },
  )
  assert.equal(storedSetting(fresh.db, 'ipam.pool'), undefined)
})

for (const key of ['ipam.pool', 'ipam.virtual_prefix']) {
  test(`PATCH /v1/settings refuses ${key} with host bits set`, async () => {
    const reply = await h.call('PATCH', '/v1/settings', {
      token: h.admin.token,
      body: {
        [key]: unmasked,
      },
    })
    assert.equal(reply.status, 400, reply.text)
    assert.equal(reply.body.error.code, 'VALIDATION_FAILED')
    assert.deepEqual(reply.body.error.details.issues, [
      {
        path: `/${key}`,
        message: `${unmasked} has host bits set; ${suggestion}`,
      },
    ])
    assert.equal(storedSetting(h.db, key as 'ipam.pool'), undefined)
  })
}

test('the install proposal refuses a pool with host bits set before its other checks', () => {
  assert.equal(
    installProposalProblem({
      ipam_pool: unmasked,
      registry_subnet: '10.200.5.0/24',
    }),
    `ipam_pool ${unmasked} has host bits set; ${suggestion}`,
  )
  assert.equal(
    installProposalProblem({
      ipam_pool: '10.200.0.0/16',
      registry_subnet: '10.200.5.0/24',
    }),
    null,
  )
})
