import assert from 'node:assert/strict'
import { after, before, describe, mock, test } from 'node:test'

import { and, eq } from 'drizzle-orm'

import { workspaceEnv } from '@stationly/protocol'

import { app } from '../src/db/schema.ts'

import { localOrigin, startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import type { FakeStation } from './helpers/fake-station.ts'
import {
  approveWaiting,
  createApp,
  createPreview,
  createProject,
  pinPlatform,
  productionId,
  waitForMachine,
} from './helpers/seed.ts'

const repository = 'https://github.com/acme/app'

let h: Dispatch
let station: FakeStation
let project: any
let previewId: string
let pushToken: string

const asHuman = (method: string, path: string, body?: unknown) =>
  h.call(method, path, {
    cookie: h.admin.cookie,
    origin: localOrigin,
    body,
  })

const appIn = (targetId: string, name: string) =>
  h.db
    .select()
    .from(app)
    .where(and(eq(app.target_id, targetId), eq(app.name, name)))
    .get()!

const patchApp = (appId: string) =>
  h.call('PATCH', `/v1/apps/${appId}`, {
    token: pushToken,
    body: {
      drain_timeout_s: 12,
      deploy: false,
    },
  })

before(async () => {
  h = await startDispatch()
  pinPlatform(h, {
    machines: true,
  })
  station = await startFakeStation(h, 'station-1', {
    machines: {},
  })
  project = await createProject(h, 'alpha')
  mock.method(h.deps.github, 'resolveRepo', () =>
    Promise.resolve({
      auth: 'public' as const,
      default_branch: 'main',
    }),
  )

  await createApp(h, productionId(h, project.id), {
    name: 'web',
    ref: 'docker.io/library/nginx:1.27',
    ports: [
      {
        port: 80,
      },
    ],
    extra: {
      source: {
        type: 'railpack',
        repo: 'github.com/acme/app',
        branch: 'main',
      },
    },
  })

  const keyed = await approveWaiting(
    h,
    await asHuman('PATCH', `/v1/projects/${project.id}/environment-variables`, {
      target: 'production',
      set: [
        {
          name: 'ANTHROPIC_API_KEY',
          kind: 'secret',
          value: 'sk-ant-test-value',
        },
      ],
    }),
  )

  assert.equal(keyed.status, 200, keyed.text)

  const created = await asHuman('POST', '/v1/tasks', {
    project: 'alpha',
    repository,
    agent: 'claude',
    prompt: 'Make the button blue',
    machine: 'own',
  })

  assert.equal(created.status, 202, created.text)
  await waitForMachine(h, created.body.machine.id, 'running')

  const deployed = await asHuman('POST', `/v1/tasks/${created.body.id}/preview`)

  assert.equal(deployed.status, 202, deployed.text)
  previewId = deployed.body.preview.id

  const delivery = station.secrets.find((entry) => entry.target.run_id === deployed.body.run_id)

  assert.ok(delivery)
  pushToken = delivery.values[workspaceEnv.token]!
  assert.ok(pushToken)
})

after(async () => {
  mock.restoreAll()
  await h.close()
})

describe('the preview push token of a task', () => {
  test('cannot mint a token of its own', async () => {
    const reply = await h.call('POST', '/v1/tokens', {
      token: pushToken,
      body: {
        name: 'escape',
        kind: 'scoped',
        scopes: [
          {
            project_id: project.id,
            target: 'previews',
            level: 'deploy',
          },
        ],
      },
    })

    assert.equal(reply.status, 403, reply.text)
    assert.equal(reply.body.error.code, 'FORBIDDEN_SCOPE')
    assert.equal(reply.body.error.details.reason, 'machine_held')
  })

  test('deploys its own preview only', async () => {
    const other = await createPreview(h, 'alpha', 'other')
    const own = await patchApp(appIn(previewId, 'web').id)

    assert.equal(own.status, 200, own.text)

    const elsewhere = await patchApp(appIn(other.id, 'web').id)

    assert.equal(elsewhere.status, 403, elsewhere.text)
    assert.equal(elsewhere.body.error.code, 'FORBIDDEN_SCOPE')

    const production = await patchApp(appIn(productionId(h, project.id), 'web').id)

    assert.equal(production.status, 403, production.text)
  })
})
