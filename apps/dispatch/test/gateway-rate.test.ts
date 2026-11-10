import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { localOrigin, startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import type { FakeStation } from './helpers/fake-station.ts'
import { seedLockfile } from './helpers/seed.ts'

let h: Dispatch
let station: FakeStation

before(async () => {
  h = await startDispatch()
  seedLockfile(h)
  station = await startFakeStation(h)
})

after(() => h.close())

const key = 'gateway.rate_per_source'
const human = () => ({
  cookie: h.admin.cookie,
  origin: localOrigin,
})
const patch = (
  value: unknown,
  auth: { token: string } | { cookie: string; origin: string } = human(),
) =>
  h.call('PATCH', '/v1/settings', {
    ...auth,
    body: {
      [key]: value,
    },
  })

describe('gateway.rate_per_source', () => {
  test('defaults to 20 and the generation carries it', async () => {
    const listed = (
      await h.call('GET', `/v1/settings?prefix=gateway.`, {
        token: h.admin.token,
      })
    ).body
    assert.equal(listed.items.find((s: { key: string }) => s.key === key).value, 20)
    const doc = await station.waitForGeneration((d) => d.station.settings[key] === 20)
    assert.equal(doc.station.settings[key], 20)
  })

  test('a changed value reaches stationd and 0 is allowed', async () => {
    assert.equal((await patch(150)).status, 200)
    assert.equal(
      (await station.waitForGeneration((d) => d.station.settings[key] === 150)).station.settings[
        key
      ],
      150,
    )
    assert.equal((await patch(0)).status, 200)
    assert.equal(
      (await station.waitForGeneration((d) => d.station.settings[key] === 0)).station.settings[key],
      0,
    )
  })

  test('negative, fractional, huge and non-numeric values are refused', async () => {
    for (const value of [-1, 2.5, 1000001, '20', true]) {
      const reply = await patch(value)
      assert.equal(reply.status, 400, `${JSON.stringify(value)} ${reply.text}`)
      assert.equal(reply.body.error.code, 'VALIDATION_FAILED')
      assert.equal(reply.body.error.details.issues[0].path, `/${key}`)
    }
  })

  test('is staged for a non-human actor under platform.protected', async () => {
    assert.equal(
      (
        await h.call('PATCH', '/v1/settings', {
          ...human(),
          body: {
            'platform.protected': true,
          },
        })
      ).status,
      200,
    )
    const staged = await patch(60, {
      token: h.admin.token,
    })
    assert.equal(staged.status, 202, staged.text)
    assert.equal(staged.body.environment_id, null)
    const accepted = await h.call('POST', `/v1/staged-changes/${staged.body.id}/accept`, human())
    assert.equal(accepted.status, 200, accepted.text)
    assert.equal(
      (await station.waitForGeneration((d) => d.station.settings[key] === 60)).station.settings[
        key
      ],
      60,
    )
    assert.equal(
      (
        await h.call('PATCH', '/v1/settings', {
          ...human(),
          body: {
            'platform.protected': false,
          },
        })
      ).status,
      200,
    )
  })
})
