import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { and, eq } from 'drizzle-orm'

import { createPreview as createPreviewRow } from '../src/api/routes/previews.ts'
import { app, key, project, secret_value } from '../src/db/schema.ts'
import { decryptValue, headValue } from '../src/secrets/values.ts'

import { localOrigin, startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import { FakeRegistry } from './helpers/registry.ts'
import {
  approveWaiting,
  createApp,
  createProject,
  productionId,
  seedLockfile,
} from './helpers/seed.ts'

let h: Dispatch
let registry: FakeRegistry
let proj: any
let production: string
let web: any
let db: any
let counter = 0

const asAdmin = (method: string, path: string, body?: unknown) =>
  h.call(method, path, {
    token: h.admin.token,
    body,
  })

const asHuman = (method: string, path: string, body?: unknown) =>
  h.call(method, path, {
    cookie: h.admin.cookie,
    origin: localOrigin,
    body,
  })

const appsIn = (targetId: string) => {
  const apps = h.db.select().from(app).where(eq(app.target_id, targetId)).all()

  return {
    web: apps.find((s) => s.name === 'web')!,
    db: apps.find((s) => s.name === 'db')!,
    api: apps.find((s) => s.name === 'api')!,
    site: apps.find((s) => s.name === 'site')!,
  }
}

const clone = async (name = `preview-${(counter += 1)}`) => {
  const made = await asAdmin('POST', `/v1/projects/${proj.id}/previews`, {
    name,
    deploy_on_create: false,
  })

  assert.equal(made.status, 201, made.text)

  return {
    id: made.body.id as string,
    name,
    ...appsIn(made.body.id),
  }
}

const pullRequest = (number: number) => {
  const row = h.db.select().from(project).where(eq(project.id, proj.id)).get()!
  const made = createPreviewRow(
    {
      deps: h.deps,
    },
    {
      principal: {
        actor: {
          type: 'system',
          id: null,
          client: 'test',
        },
      },
      request_id: 'req_test',
    } as never,
    row,
    {
      name: `pr-${number}`,
      origin: {
        type: 'pull_request',
        repo: 'github.com/acme/app',
        number,
        head_sha: 'abc',
        fork: false,
      },
      expires_at: null,
      deploy: false,
    },
  )

  return {
    id: made.preview.id,
    name: `pr-${number}`,
    ...appsIn(made.preview.id),
  }
}

const keyOf = (appId: string, name: string) =>
  h.db
    .select()
    .from(key)
    .where(and(eq(key.app_id, appId), eq(key.name, name)))
    .get()!

const valueOf = (appId: string, name: string, target: 'production' | 'preview' = 'production') => {
  const head = headValue(h.db, keyOf(appId, name).id, target)

  return head ? decryptValue(h.deps.keyring, head) : null
}

const deploy = (appId: string) => asAdmin('POST', `/v1/apps/${appId}/deployments`, {})

const approved = async (reply: { status: number; body: any; text: string }) => {
  const done = await approveWaiting(h, reply)

  assert.equal(done.status, 200, done.text)
}

const setAppPreviewValue = async (appId: string, name: string, value: string) =>
  approved(
    await asAdmin('PATCH', `/v1/apps/${appId}/keys`, {
      target: 'preview',
      set: [
        {
          name,
          kind: 'sealed',
          value,
        },
      ],
    }),
  )

before(async () => {
  registry = FakeRegistry.install()
  registry.publish('nginx:1.27')
  h = await startDispatch()
  seedLockfile(h)
  await startFakeStation(h)
  proj = await createProject(h)
  production = productionId(h, proj.id)
  db = await createApp(h, production, {
    name: 'db',
    kind: 'worker',
    ref: 'nginx:1.27',
    keys: [
      {
        name: 'URL',
        kind: 'sealed',
        value: 'postgres://prod-password@db',
      },
    ],
  })
  web = await createApp(h, production, {
    name: 'web',
    ref: 'nginx:1.27',
    ports: [
      {
        port: 8080,
      },
    ],
    keys: [
      {
        name: 'API_KEY',
        kind: 'sealed',
        value: 'production-api-key',
      },
      {
        name: 'PLAIN',
        kind: 'literal',
        value: 'visible',
      },
      {
        name: 'DATABASE_URL',
        kind: 'reference',
        reference: '${{db.URL}}',
      },
    ],
  })
  await approved(
    await asHuman('PATCH', `/v1/projects/${proj.id}/keys`, {
      target: 'production',
      set: [
        {
          name: 'PROJECT_SECRET',
          kind: 'sealed',
          value: 'production-project-secret',
        },
        {
          name: 'PROJECT_PLAIN',
          kind: 'literal',
          value: 'project-visible',
        },
      ],
    }),
  )
})

after(async () => {
  await h.close()
  registry.restore()
})

describe("a preview never reads production's sealed values", () => {
  test('plain values and references are copied, a sealed app key arrives with no value', async () => {
    const copy = await clone()

    assert.equal(valueOf(copy.web.id, 'PLAIN'), 'visible')
    assert.equal(keyOf(copy.web.id, 'DATABASE_URL').reference, '${{db.URL}}')
    assert.equal(keyOf(copy.web.id, 'API_KEY').kind, 'sealed')
    assert.equal(
      h.db
        .select()
        .from(secret_value)
        .where(eq(secret_value.key_id, keyOf(copy.web.id, 'API_KEY').id))
        .all().length,
      0,
    )
    assert.equal(valueOf(copy.db.id, 'URL'), null)
    assert.equal(valueOf(copy.db.id, 'URL', 'preview'), null)
  })

  test('project keys hold no copy; a preview reads them through their one preview value', async () => {
    await clone()
    const previewRows = (name: string) =>
      h.db
        .select()
        .from(secret_value)
        .where(
          and(
            eq(
              secret_value.key_id,
              h.db
                .select()
                .from(key)
                .where(and(eq(key.project_id, proj.id), eq(key.name, name)))
                .get()!.id,
            ),
            eq(secret_value.target, 'preview'),
          ),
        )
        .all()

    assert.equal(previewRows('PROJECT_PLAIN').length, 0)
    assert.equal(previewRows('PROJECT_SECRET').length, 0)
  })

  test('a pull request preview gets the same treatment', () => {
    const pr = pullRequest(42)

    assert.equal(valueOf(pr.web.id, 'PLAIN'), 'visible')
    assert.equal(valueOf(pr.web.id, 'API_KEY'), null)
    assert.equal(valueOf(pr.web.id, 'API_KEY', 'preview'), null)
  })
})

describe('a missing sealed value is a clear state', () => {
  test('a deploy in the preview is refused naming the key and the preview, with the fix', async () => {
    const copy = await clone('needs-keys')
    const refused = await deploy(copy.web.id)

    assert.equal(refused.status, 422, refused.text)
    assert.equal(refused.body.error.code, 'KEY_UNRESOLVED')
    assert.equal(refused.body.error.details.key, 'API_KEY')
    assert.equal(refused.body.error.details.preview, 'needs-keys')
    assert.equal(
      refused.body.error.fix,
      "Set a preview value for API_KEY; previews never read production's sealed values.",
    )
  })

  test('a reference to a sealed key with no preview value is unresolved, and resolves once it has one', async () => {
    const plain = await clone('no-database')

    await asAdmin('PATCH', `/v1/apps/${plain.web.id}/keys`, {
      set: [
        {
          name: 'API_KEY',
          kind: 'sealed',
          value: 'preview-api-key',
        },
      ],
    })

    const refused = await deploy(plain.web.id)

    assert.equal(refused.status, 422, refused.text)
    assert.match(refused.body.error.explanation, /db\.URL/)
    assert.equal(refused.body.error.details.preview, 'no-database')

    await setAppPreviewValue(db.id, 'URL', 'postgres://preview-password@db')

    const copy = await clone('with-database')

    assert.equal(valueOf(copy.db.id, 'URL', 'preview'), 'postgres://preview-password@db')
    assert.equal(valueOf(copy.db.id, 'URL'), null)
    await asAdmin('PATCH', `/v1/apps/${copy.web.id}/keys`, {
      set: [
        {
          name: 'API_KEY',
          kind: 'sealed',
          value: 'preview-api-key',
        },
      ],
    })

    const accepted = await deploy(copy.web.id)

    assert.ok(accepted.status === 201 || accepted.status === 202, accepted.text)
  })
})

describe("a sealed app key's preview value", () => {
  test('is copied into previews made afterwards, never its production value', async () => {
    const before = await clone()

    await setAppPreviewValue(web.id, 'API_KEY', 'preview-api-key')
    assert.equal(valueOf(web.id, 'API_KEY'), 'production-api-key')
    assert.equal(valueOf(web.id, 'API_KEY', 'preview'), 'preview-api-key')

    const after = await clone()

    assert.equal(valueOf(before.web.id, 'API_KEY', 'preview'), null)
    assert.equal(valueOf(after.web.id, 'API_KEY', 'preview'), 'preview-api-key')
    assert.equal(valueOf(after.web.id, 'API_KEY'), null)
  })

  test('is listed with the key', async () => {
    const listed = await asAdmin('GET', `/v1/apps/${web.id}/keys`)
    const entry = listed.body.items.find((item: any) => item.name === 'API_KEY')

    assert.deepEqual(entry.targets, ['preview', 'production'])
  })
})

describe('a project key in previews', () => {
  let api: any

  const projectKey = (name: string, kind: 'sealed' | 'literal', value: string) =>
    asHuman('PATCH', `/v1/projects/${proj.id}/keys`, {
      target: 'production',
      set: [
        {
          name,
          kind,
          value,
        },
      ],
    })

  before(async () => {
    await approved(await projectKey('EVERYWHERE_SECRET', 'sealed', 'stripe-live-key'))
    await approved(await projectKey('EVERYWHERE_PLAIN', 'literal', 'plain-production'))
    api = await createApp(h, production, {
      name: 'api',
      kind: 'worker',
      ref: 'nginx:1.27',
      keys: [
        {
          name: 'STRIPE_KEY',
          kind: 'reference',
          reference: '${{project.EVERYWHERE_SECRET}}',
        },
      ],
    })
    await createApp(h, production, {
      name: 'site',
      kind: 'worker',
      ref: 'nginx:1.27',
      keys: [
        {
          name: 'MODE',
          kind: 'reference',
          reference: '${{project.EVERYWHERE_PLAIN}}',
        },
      ],
    })
  })

  test('a sealed one with no preview value does not resolve', async () => {
    const pr = pullRequest(7)
    const refused = await deploy(pr.api.id)

    assert.equal(refused.status, 422, refused.text)
    assert.equal(refused.body.error.code, 'KEY_UNRESOLVED')
    assert.match(refused.body.error.explanation, /EVERYWHERE_SECRET/)
    assert.equal(refused.body.error.details.preview, 'pr-7')
    assert.match(refused.body.error.fix, /preview value/)
  })

  test('a literal one falls back to its production value', async () => {
    const accepted = await deploy(pullRequest(8).site.id)

    assert.ok(accepted.status === 201 || accepted.status === 202, accepted.text)
  })

  test('a sealed one resolves once it has a preview value, shared by every preview', async () => {
    const set = await asAdmin('PATCH', `/v1/projects/${proj.id}/keys`, {
      target: 'preview',
      set: [
        {
          name: 'EVERYWHERE_SECRET',
          kind: 'sealed',
          value: 'stripe-test-key',
        },
      ],
    })

    assert.equal(set.status, 200, set.text)

    for (const number of [9, 10]) {
      const accepted = await deploy(pullRequest(number).api.id)

      assert.ok(accepted.status === 201 || accepted.status === 202, accepted.text)
    }
  })

  test('production itself resolves its production value', async () => {
    const accepted = await deploy(api.id)

    assert.ok(accepted.status === 201 || accepted.status === 202, accepted.text)
  })
})
