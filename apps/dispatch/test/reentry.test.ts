import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { and, eq } from 'drizzle-orm'

import { environment_variable, secret_value } from '../src/db/schema.ts'

import { startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
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

type Value = { name: string; kind: 'literal' | 'secret'; value: string }

const api = (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
  h.call(method, path, {
    token: h.admin.token,
    body,
    headers,
  })

const setValues = async (projectId: string, set: Value[]) => {
  const reply = await approveWaiting(
    h,
    await api('PATCH', `/v1/projects/${projectId}/environment-variables`, {
      target: 'production',
      set,
      apply: false,
    }),
  )

  assert.equal(reply.status, 200, reply.text)
}

const projectWith = async (name: string, set: Value[]) => {
  const project = await createProject(h, name)

  await setValues(project.id, set)

  return project
}

const versionsOf = (projectId: string, name: string, scope: 'project' | 'app' = 'project') => {
  const row = h.db
    .select()
    .from(environment_variable)
    .where(
      and(
        eq(environment_variable.project_id, projectId),
        eq(environment_variable.scope, scope),
        eq(environment_variable.name, name),
      ),
    )
    .get()!

  return h.db
    .select()
    .from(secret_value)
    .where(eq(secret_value.environment_variable_id, row.id))
    .all()
}

const needReentry = (projectId: string, name: string, scope: 'project' | 'app' = 'project') => {
  const [head] = versionsOf(projectId, name, scope)

  h.db
    .update(secret_value)
    .set({
      needs_reentry: true,
    })
    .where(eq(secret_value.environment_variable_id, head!.environment_variable_id))
    .run()

  return head!
}

const refusedForReentry = (reply: { status: number; body: any; text: string }, id: string) => {
  assert.equal(reply.status, 422, reply.text)
  assert.equal(reply.body.error.code, 'SECRETS_NEED_REENTRY')
  assert.equal(reply.body.error.details.secret_value_id, id)
}

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

test('export refuses a value that needs re-entry with SECRETS_NEED_REENTRY', async () => {
  const project = await projectWith('export-reentry', [
    {
      name: 'PLAIN',
      kind: 'literal',
      value: 'v1',
    },
  ])
  const exported = () =>
    api('GET', `/v1/projects/${project.id}/manifest`, undefined, {
      accept: 'application/json',
    })

  assert.equal((await exported()).status, 200)
  const head = needReentry(project.id, 'PLAIN')

  refusedForReentry(await exported(), head.id)
})

test('a preview refuses a production value that needs re-entry and creates no preview', async () => {
  const project = await createProject(h, 'clone-reentry')

  await createApp(h, productionId(h, project.id), {
    name: 'web',
    kind: 'worker',
    ref: 'nginx:1.27',
    environment_variables: [
      {
        name: 'TOKEN',
        kind: 'literal',
        value: 'clone-value',
      },
    ],
  })
  const clone = (name: string) =>
    api('POST', `/v1/projects/${project.id}/previews`, {
      name,
      deploy_on_create: false,
    })

  assert.equal((await clone('before')).status, 201)
  const head = needReentry(project.id, 'TOKEN', 'app')

  refusedForReentry(await clone('after'), head.id)
  assert.deepEqual(
    (await api('GET', `/v1/projects/${project.id}/previews`)).body.items
      .map((e: any) => e.name)
      .sort(),
    ['before'],
  )
})

test('a plan treats a secret value that needs re-entry as missing', async () => {
  const project = await projectWith('plan-reentry', [
    {
      name: 'KEPT',
      kind: 'secret',
      value: 'secret-kept-value',
    },
    {
      name: 'LOST',
      kind: 'secret',
      value: 'secret-lost-value',
    },
  ])

  needReentry(project.id, 'LOST')
  const plan = await api('POST', `/v1/projects/${project.id}/manifest/apply`, {
    plan: true,
    manifest: {
      version: 1,
      project: 'plan-reentry',
      env: {
        KEPT: {
          secret: true,
        },
        LOST: {
          secret: true,
        },
      },
    },
  })

  assert.equal(plan.status, 200, plan.text)
  assert.deepEqual(
    plan.body.warnings
      .filter((w: any) => w.code === 'SECRET_VALUE_MISSING')
      .map((w: any) => w.path),
    ['/env/LOST'],
  )
})

test('re-entering the same value writes a version because the no-op check treats it as unset', async () => {
  const same = [
    {
      name: 'PLAIN',
      kind: 'literal' as const,
      value: 'unchanged',
    },
  ]
  const project = await projectWith('noop-reentry', same)

  await setValues(project.id, same)
  assert.equal(versionsOf(project.id, 'PLAIN').length, 1)
  needReentry(project.id, 'PLAIN')
  await setValues(project.id, same)
  assert.deepEqual(
    versionsOf(project.id, 'PLAIN')
      .sort((a, b) => a.version - b.version)
      .map((v) => [v.version, v.needs_reentry]),
    [
      [1, true],
      [2, false],
    ],
  )
})
