import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import { FakeRegistry } from './helpers/registry.ts'
import {
  createApp,
  createPreview,
  createProject,
  seedLockfile,
  waitForDeployment,
} from './helpers/seed.ts'

let h: Dispatch
let registry: FakeRegistry
let previewId: string

const token = () => h.admin.token

before(async () => {
  registry = FakeRegistry.install()
  registry.publish('nginx:1.27')
  h = await startDispatch()
  seedLockfile(h)
  await startFakeStation(h)
  previewId = (await createPreview(h, (await createProject(h)).id, 'staging')).id
})

after(async () => {
  await h.close()
  registry.restore()
})

const activeApp = async (name: string, keys: unknown[] = []) => {
  const created = await createApp(h, previewId, {
    name,
    ref: 'nginx:1.27',
    ports: [
      {
        port: 80,
      },
    ],
    keys,
    deploy: true,
  })

  await waitForDeployment(h, created.deployments[0].id, 'active')

  return created.id as string
}

const stateOf = async (id: string) =>
  (
    await h.call('GET', `/v1/apps/${id}`, {
      token: token(),
    })
  ).body as {
    stale: boolean
    stale_reasons: { code: string; keys: string[] }[]
  }

const setKey = (id: string, value: string, name = 'FOO') =>
  h.call('PATCH', `/v1/apps/${id}/keys`, {
    token: token(),
    body: {
      set: [
        {
          name,
          kind: 'literal',
          value,
        },
      ],
      apply: false,
    },
  })

const patchApp = (id: string, body: Record<string, unknown>) =>
  h.call('PATCH', `/v1/apps/${id}`, {
    token: token(),
    body: {
      deploy: false,
      ...body,
    },
  })

describe('keys', () => {
  test('an app with a current deployment and unchanged keys is not stale', async () => {
    const id = await activeApp('fresh', [
      {
        name: 'FOO',
        kind: 'literal',
        value: 'a',
      },
    ])

    assert.deepEqual(await stateOf(id), {
      ...(await stateOf(id)),
      stale: false,
      stale_reasons: [],
    })
  })

  test('an app without a current deployment is never stale', async () => {
    const created = await createApp(h, previewId, {
      name: 'never-deployed',
      ref: 'nginx:1.27',
      ports: [
        {
          port: 80,
        },
      ],
      deploy: false,
    })

    await setKey(created.id, 'x')
    assert.equal((await stateOf(created.id)).stale, false)
  })

  test('changing a value marks the app stale with KEYS_CHANGED naming the key', async () => {
    const id = await activeApp('changed', [
      {
        name: 'FOO',
        kind: 'literal',
        value: 'a',
      },
    ])
    const reply = await setKey(id, 'b')

    assert.equal(reply.status, 200)
    const state = await stateOf(id)

    assert.equal(state.stale, true)
    assert.equal(state.stale_reasons[0]!.code, 'KEYS_CHANGED')
    assert.deepEqual(state.stale_reasons[0]!.keys, ['FOO'])
  })

  test('setting the value it already has is a no-op and leaves the app not stale', async () => {
    const id = await activeApp('noop', [
      {
        name: 'FOO',
        kind: 'literal',
        value: 'a',
      },
    ])
    const reply = await setKey(id, 'a')

    assert.equal(reply.status, 200)
    assert.equal((await stateOf(id)).stale, false)
  })

  test('writing the old value again is a new secret version, so the app stays stale until deployed', async () => {
    const id = await activeApp('restored', [
      {
        name: 'FOO',
        kind: 'literal',
        value: 'a',
      },
    ])

    await setKey(id, 'b')
    await setKey(id, 'a')
    assert.equal((await stateOf(id)).stale, true)
  })

  test('a removed key marks the app stale', async () => {
    const id = await activeApp('removed', [
      {
        name: 'FOO',
        kind: 'literal',
        value: 'a',
      },
    ])
    const reply = await h.call('PATCH', `/v1/apps/${id}/keys`, {
      token: token(),
      body: {
        unset: ['FOO'],
        apply: false,
      },
    })

    assert.equal(reply.status, 200)
    const state = await stateOf(id)

    assert.equal(state.stale, true)
    assert.deepEqual(state.stale_reasons[0]!.keys, ['FOO'])
  })

  test('staleness clears when a deployment carrying the new digest becomes active', async () => {
    const id = await activeApp('activated', [
      {
        name: 'FOO',
        kind: 'literal',
        value: 'a',
      },
    ])

    await setKey(id, 'b')
    assert.equal((await stateOf(id)).stale, true)
    const deployed = await h.call('POST', `/v1/apps/${id}/deployments`, {
      token: token(),
      body: {},
    })

    assert.equal(deployed.status, 201)
    await waitForDeployment(h, deployed.body.id, 'active')
    assert.deepEqual((await stateOf(id)).stale_reasons, [])
    assert.equal((await stateOf(id)).stale, false)
  })

  test('a plain redeploy takes the current key versions and clears staleness', async () => {
    const id = await activeApp('redeploy-takes', [
      {
        name: 'FOO',
        kind: 'literal',
        value: 'a',
      },
    ])

    await setKey(id, 'b')
    const redeployed = await h.call('POST', `/v1/apps/${id}/redeploy`, {
      token: token(),
      body: {},
    })

    assert.equal(redeployed.status, 201)
    await waitForDeployment(h, redeployed.body.id, 'active')
    assert.equal((await stateOf(id)).stale, false)
  })

  test('restart pins the current deployment environment, so the app stays stale', async () => {
    const id = await activeApp('restart-pins', [
      {
        name: 'FOO',
        kind: 'literal',
        value: 'a',
      },
    ])

    await setKey(id, 'b')
    const restarted = await h.call('POST', `/v1/apps/${id}/restart`, {
      token: token(),
    })

    assert.equal(restarted.status, 200)
    await waitForDeployment(h, restarted.body.id, 'active')
    assert.equal((await stateOf(id)).stale, true)
  })
})

describe('configuration', () => {
  test('a limits change recorded against the deployment snapshot marks CONFIG_CHANGED naming the field', async () => {
    const id = await activeApp('limits')
    const reply = await patchApp(id, {
      limits: {
        memory_bytes: 268435456,
      },
    })

    assert.equal(reply.status, 200)
    const state = await stateOf(id)

    assert.equal(state.stale, true)
    assert.equal(state.stale_reasons[0]!.code, 'CONFIG_CHANGED')
    assert.deepEqual(state.stale_reasons[0]!.keys, ['limits'])
  })

  test('patching a field back to its snapshot value clears staleness', async () => {
    const id = await activeApp('limits-back')

    await patchApp(id, {
      limits: {
        memory_bytes: 268435456,
      },
    })
    assert.equal((await stateOf(id)).stale, true)
    await patchApp(id, {
      limits: {
        memory_bytes: 536870912,
      },
    })
    assert.equal((await stateOf(id)).stale, false)
  })

  test('patching a field to the value it already has is a no-op', async () => {
    const id = await activeApp('limits-same')
    const reply = await patchApp(id, {
      limits: {
        memory_bytes: 536870912,
      },
    })

    assert.equal(reply.status, 200)
    assert.equal((await stateOf(id)).stale, false)
  })

  test('deploying the changed configuration clears CONFIG_CHANGED on activation', async () => {
    const id = await activeApp('limits-deploy')

    await patchApp(id, {
      limits: {
        memory_bytes: 268435456,
      },
    })
    const deployed = await h.call('POST', `/v1/apps/${id}/deployments`, {
      token: token(),
      body: {},
    })

    await waitForDeployment(h, deployed.body.id, 'active')
    assert.equal((await stateOf(id)).stale, false)
  })

  test('keys and configuration reasons are reported together', async () => {
    const id = await activeApp('both', [
      {
        name: 'FOO',
        kind: 'literal',
        value: 'a',
      },
    ])

    await setKey(id, 'b')
    await patchApp(id, {
      limits: {
        memory_bytes: 268435456,
      },
    })
    const codes = (await stateOf(id)).stale_reasons.map((r) => r.code).sort()

    assert.deepEqual(codes, ['CONFIG_CHANGED', 'KEYS_CHANGED'])
  })
})
