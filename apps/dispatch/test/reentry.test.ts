import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { and, eq } from 'drizzle-orm'

import { secret_value, variable } from '../src/db/schema.ts'

import { startDispatch, type Dispatch } from './helpers/dispatch.ts'
import { createProject } from './helpers/seed.ts'

let h: Dispatch

type Value = { key: string; kind: 'literal' | 'sealed'; value: string }

const api = (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
  h.call(method, path, {
    token: h.admin.token,
    body,
    headers,
  })

const setValues = async (projectId: string, set: Value[]) => {
  const reply = await api('PATCH', `/v1/projects/${projectId}/variables`, {
    environment: 'production',
    set,
    apply: false,
  })

  assert.equal(reply.status, 200, reply.text)
}

const projectWith = async (name: string, set: Value[]) => {
  const project = await createProject(h, name)

  await setValues(project.id, set)

  return project
}

const versionsOf = (projectId: string, key: string) => {
  const row = h.db
    .select()
    .from(variable)
    .where(and(eq(variable.project_id, projectId), eq(variable.key, key)))
    .get()!

  return h.db.select().from(secret_value).where(eq(secret_value.variable_id, row.id)).all()
}

const needReentry = (projectId: string, key: string) => {
  const [head] = versionsOf(projectId, key)

  h.db
    .update(secret_value)
    .set({
      needs_reentry: true,
    })
    .where(eq(secret_value.variable_id, head!.variable_id))
    .run()

  return head!
}

const refusedForReentry = (reply: { status: number; body: any; text: string }, id: string) => {
  assert.equal(reply.status, 422, reply.text)
  assert.equal(reply.body.error.code, 'SECRETS_NEED_REENTRY')
  assert.equal(reply.body.error.details.secret_value_id, id)
}

before(async () => {
  h = await startDispatch()
})

after(async () => {
  await h.close()
})

test('export refuses a value that needs re-entry with SECRETS_NEED_REENTRY', async () => {
  const project = await projectWith('export-reentry', [
    {
      key: 'PLAIN',
      kind: 'literal',
      value: 'v1',
    },
  ])
  const exported = () =>
    api('GET', `/v1/projects/${project.id}/manifest?environment=production`, undefined, {
      accept: 'application/json',
    })

  assert.equal((await exported()).status, 200)
  const head = needReentry(project.id, 'PLAIN')

  refusedForReentry(await exported(), head.id)
})

test('a clone refuses a source value that needs re-entry and creates no environment', async () => {
  const project = await projectWith('clone-reentry', [
    {
      key: 'TOKEN',
      kind: 'sealed',
      value: 'sealed-clone-value',
    },
  ])
  const clone = (name: string) =>
    api('POST', `/v1/projects/${project.id}/environments`, {
      name,
      source_environment_id: project.default_environment_id,
    })

  assert.equal((await clone('before')).status, 201)
  const head = needReentry(project.id, 'TOKEN')

  refusedForReentry(await clone('after'), head.id)
  assert.deepEqual(
    (await api('GET', `/v1/projects/${project.id}/environments`)).body.items
      .map((e: any) => e.name)
      .sort(),
    ['before', 'production'],
  )
})

test('a plan treats a sealed value that needs re-entry as missing', async () => {
  const project = await projectWith('plan-reentry', [
    {
      key: 'KEPT',
      kind: 'sealed',
      value: 'sealed-kept-value',
    },
    {
      key: 'LOST',
      kind: 'sealed',
      value: 'sealed-lost-value',
    },
  ])

  needReentry(project.id, 'LOST')
  const plan = await api('POST', `/v1/projects/${project.id}/manifest/apply`, {
    environment: 'production',
    plan: true,
    manifest: {
      version: 1,
      project: 'plan-reentry',
      variables: {
        KEPT: {
          sealed: true,
        },
        LOST: {
          sealed: true,
        },
      },
    },
  })

  assert.equal(plan.status, 200, plan.text)
  assert.deepEqual(
    plan.body.warnings
      .filter((w: any) => w.code === 'SEALED_VALUE_MISSING')
      .map((w: any) => w.path),
    ['/variables/LOST'],
  )
})

test('re-entering the same value writes a version because the no-op check treats it as unset', async () => {
  const same = [
    {
      key: 'PLAIN',
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
