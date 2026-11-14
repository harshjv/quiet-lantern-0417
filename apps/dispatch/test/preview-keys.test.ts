import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { and, eq } from 'drizzle-orm'

import { cloneInto } from '../src/api/routes/environments.ts'
import { newId } from '../src/db/ids.ts'
import { environment, project, secret_value, service, variable } from '../src/db/schema.ts'
import { decryptValue, headValue } from '../src/secrets/values.ts'

import { localOrigin, startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import { FakeRegistry } from './helpers/registry.ts'
import { createProject, createService, seedLockfile } from './helpers/seed.ts'

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

const clone = async (name = `preview-${(counter += 1)}`) => {
  const made = await asAdmin('POST', `/v1/projects/${proj.id}/environments`, {
    name,
    source_environment_id: production,
    deploy_on_create: false,
  })

  assert.equal(made.status, 201, made.text)

  const services = h.db.select().from(service).where(eq(service.environment_id, made.body.id)).all()

  return {
    id: made.body.id as string,
    name,
    web: services.find((s) => s.name === 'web')!,
    db: services.find((s) => s.name === 'db')!,
  }
}

const variableOf = (serviceId: string, key: string) =>
  h.db
    .select()
    .from(variable)
    .where(and(eq(variable.service_id, serviceId), eq(variable.key, key)))
    .get()!

const valueOf = (serviceId: string, key: string) => {
  const row = variableOf(serviceId, key)
  const head = headValue(h.db, row.id, null)

  return head ? decryptValue(h.deps.keyring, head) : null
}

const deploy = (serviceId: string) => asAdmin('POST', `/v1/services/${serviceId}/deployments`, {})

const markCopied = (serviceId: string, key: string, flag = true) =>
  asHuman('PATCH', `/v1/services/${serviceId}/variables`, {
    set: [
      {
        key,
        kind: 'sealed',
        copy_to_clones: flag,
      },
    ],
  })

before(async () => {
  registry = FakeRegistry.install()
  registry.publish('nginx:1.27')
  h = await startDispatch()
  seedLockfile(h)
  await startFakeStation(h)
  proj = await createProject(h)
  production = proj.default_environment_id
  db = await createService(h, production, {
    name: 'db',
    kind: 'worker',
    ref: 'nginx:1.27',
    variables: [
      {
        key: 'URL',
        kind: 'sealed',
        value: 'postgres://prod-password@db',
      },
    ],
  })
  web = await createService(h, production, {
    name: 'web',
    ref: 'nginx:1.27',
    ports: [
      {
        port: 8080,
      },
    ],
    variables: [
      {
        key: 'API_KEY',
        kind: 'sealed',
        value: 'production-api-key',
      },
      {
        key: 'PLAIN',
        kind: 'literal',
        value: 'visible',
      },
      {
        key: 'DATABASE_URL',
        kind: 'reference',
        reference: '${{db.URL}}',
      },
    ],
  })
  await asHuman('PATCH', `/v1/projects/${proj.id}/variables`, {
    environment: 'production',
    set: [
      {
        key: 'PROJECT_SECRET',
        kind: 'sealed',
        value: 'production-project-secret',
      },
      {
        key: 'PROJECT_PLAIN',
        kind: 'literal',
        value: 'project-visible',
      },
    ],
  })
})

after(async () => {
  await h.close()
  registry.restore()
})

describe('a clone keeps sealed values in their source by default', () => {
  test('plain values and references are copied, a sealed key arrives with no value', async () => {
    const copy = await clone()

    assert.equal(valueOf(copy.web.id, 'PLAIN'), 'visible')
    assert.equal(variableOf(copy.web.id, 'DATABASE_URL').reference, '${{db.URL}}')
    assert.equal(variableOf(copy.web.id, 'API_KEY').kind, 'sealed')
    assert.equal(valueOf(copy.web.id, 'API_KEY'), null)
    assert.equal(
      h.db
        .select()
        .from(secret_value)
        .where(eq(secret_value.variable_id, variableOf(copy.web.id, 'API_KEY').id))
        .all().length,
      0,
    )
    assert.equal(valueOf(copy.db.id, 'URL'), null)
  })

  test('project values follow the same rule', async () => {
    const copy = await clone()
    const rows = (key: string) =>
      h.db
        .select()
        .from(secret_value)
        .where(
          and(
            eq(
              secret_value.variable_id,
              h.db
                .select()
                .from(variable)
                .where(and(eq(variable.project_id, proj.id), eq(variable.key, key)))
                .get()!.id,
            ),
            eq(secret_value.environment_id, copy.id),
          ),
        )
        .all()

    assert.equal(rows('PROJECT_PLAIN').length, 1)
    assert.equal(rows('PROJECT_SECRET').length, 0)
  })

  test('the value is copied once its variable is marked, and only for clones made afterwards', async () => {
    const before = await clone()
    const marked = await markCopied(web.id, 'API_KEY')

    assert.equal(marked.status, 200, marked.text)
    assert.equal(variableOf(web.id, 'API_KEY').copy_to_clones, true)
    assert.equal(valueOf(web.id, 'API_KEY'), 'production-api-key')

    const after = await clone()

    assert.equal(valueOf(before.web.id, 'API_KEY'), null)
    assert.equal(valueOf(after.web.id, 'API_KEY'), 'production-api-key')
    assert.equal(variableOf(after.web.id, 'API_KEY').copy_to_clones, true)

    await markCopied(web.id, 'API_KEY', false)
    assert.equal(valueOf((await clone()).web.id, 'API_KEY'), null)
  })

  test('a pull request environment gets the same treatment', () => {
    const source = h.db.select().from(environment).where(eq(environment.id, production)).get()!
    const row = h.db.select().from(project).where(eq(project.id, proj.id)).get()!
    const id = newId('environment')

    h.db
      .insert(environment)
      .values({
        id,
        project_id: proj.id,
        name: 'pr-42',
        protected: false,
        ephemeral: true,
        source_environment_id: production,
        ttl_seconds: 3600,
        pull_request: {
          repo: 'github.com/acme/app',
          number: 42,
          head_sha: 'abc',
          fork: false,
        },
      })
      .run()
    cloneInto(
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
      source,
      h.db.select().from(environment).where(eq(environment.id, id)).get()!,
      false,
    )

    const web = h.db
      .select()
      .from(service)
      .where(and(eq(service.environment_id, id), eq(service.name, 'web')))
      .get()!

    assert.equal(valueOf(web.id, 'PLAIN'), 'visible')
    assert.equal(valueOf(web.id, 'API_KEY'), null)
  })
})

describe('setting the flag', () => {
  test('is a human change, refused for a token', async () => {
    const refused = await asAdmin('PATCH', `/v1/services/${web.id}/variables`, {
      set: [
        {
          key: 'API_KEY',
          kind: 'sealed',
          copy_to_clones: true,
        },
      ],
    })

    assert.equal(refused.status, 403, refused.text)
    assert.equal(refused.body.error.details.reason, 'human_required')
    assert.equal(variableOf(web.id, 'API_KEY').copy_to_clones, false)
  })

  test('is refused on a variable that is not sealed', async () => {
    const refused = await asHuman('PATCH', `/v1/services/${web.id}/variables`, {
      set: [
        {
          key: 'PLAIN',
          kind: 'literal',
          value: 'visible',
          copy_to_clones: true,
        },
      ],
    })

    assert.equal(refused.status, 400, refused.text)
  })

  test('is listed with the variable', async () => {
    await markCopied(web.id, 'API_KEY')

    const listed = await asAdmin('GET', `/v1/services/${web.id}/variables`)
    const entry = listed.body.items.find((item: any) => item.key === 'API_KEY')

    assert.equal(entry.copy_to_clones, true)
    await markCopied(web.id, 'API_KEY', false)
  })
})

describe('a missing sealed value is a clear state', () => {
  test('a deploy in the clone is refused naming the key and the environment, with the fix', async () => {
    const copy = await clone('needs-keys')
    const refused = await deploy(copy.web.id)

    assert.equal(refused.status, 422, refused.text)
    assert.equal(refused.body.error.code, 'VARIABLE_UNRESOLVED')
    assert.equal(refused.body.error.details.key, 'API_KEY')
    assert.equal(refused.body.error.details.environment, 'needs-keys')
    assert.equal(
      refused.body.error.fix,
      'Set a value for API_KEY in needs-keys, or mark it to be copied to new environments in production.',
    )
  })

  test('a reference to a sealed variable that was not copied is unresolved in the clone, and resolves once it was', async () => {
    const plain = await clone('no-database')

    await asAdmin('PATCH', `/v1/services/${plain.web.id}/variables`, {
      set: [
        {
          key: 'API_KEY',
          kind: 'sealed',
          value: 'preview-api-key',
        },
      ],
    })

    const refused = await deploy(plain.web.id)

    assert.equal(refused.status, 422, refused.text)
    assert.match(refused.body.error.explanation, /db\.URL/)
    assert.equal(refused.body.error.details.environment, 'no-database')

    await markCopied(db.id, 'URL')

    const copy = await clone('with-database')

    await asAdmin('PATCH', `/v1/services/${copy.web.id}/variables`, {
      set: [
        {
          key: 'API_KEY',
          kind: 'sealed',
          value: 'preview-api-key',
        },
      ],
    })

    const accepted = await deploy(copy.web.id)

    assert.ok(accepted.status === 201 || accepted.status === 202, accepted.text)
    await markCopied(db.id, 'URL', false)
  })
})

describe('a project value set for every environment', () => {
  let api: any
  let site: any

  const pullRequest = (number: number) => {
    const source = h.db.select().from(environment).where(eq(environment.id, production)).get()!
    const row = h.db.select().from(project).where(eq(project.id, proj.id)).get()!
    const id = newId('environment')

    h.db
      .insert(environment)
      .values({
        id,
        project_id: proj.id,
        name: `pr-${number}`,
        protected: false,
        ephemeral: true,
        source_environment_id: production,
        ttl_seconds: 3600,
        pull_request: {
          repo: 'github.com/acme/app',
          number,
          head_sha: 'abc',
          fork: false,
        },
      })
      .run()
    cloneInto(
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
      source,
      h.db.select().from(environment).where(eq(environment.id, id)).get()!,
      false,
    )

    const services = h.db.select().from(service).where(eq(service.environment_id, id)).all()

    return {
      name: `pr-${number}`,
      api: services.find((s) => s.name === 'api')!,
      site: services.find((s) => s.name === 'site')!,
    }
  }

  const everywhere = (key: string, kind: 'sealed' | 'literal', value: string) =>
    asHuman('PATCH', `/v1/projects/${proj.id}/variables`, {
      environment: 'default',
      set: [
        {
          key,
          kind,
          value,
        },
      ],
    })

  before(async () => {
    await everywhere('EVERYWHERE_SECRET', 'sealed', 'stripe-live-key')
    await everywhere('EVERYWHERE_PLAIN', 'literal', 'plain-default')
    api = await createService(h, production, {
      name: 'api',
      kind: 'worker',
      ref: 'nginx:1.27',
      variables: [
        {
          key: 'STRIPE_KEY',
          kind: 'reference',
          reference: '${{project.EVERYWHERE_SECRET}}',
        },
      ],
    })
    site = await createService(h, production, {
      name: 'site',
      kind: 'worker',
      ref: 'nginx:1.27',
      variables: [
        {
          key: 'MODE',
          kind: 'reference',
          reference: '${{project.EVERYWHERE_PLAIN}}',
        },
      ],
    })
  })

  test('a sealed one does not resolve in a pull request environment', async () => {
    const pr = pullRequest(7)
    const refused = await deploy(pr.api.id)

    assert.equal(refused.status, 422, refused.text)
    assert.equal(refused.body.error.code, 'VARIABLE_UNRESOLVED')
    assert.match(refused.body.error.explanation, /EVERYWHERE_SECRET/)
    assert.equal(refused.body.error.details.environment, 'pr-7')
    assert.match(refused.body.error.fix, /in production\.$/)
  })

  test('a plain one still does', async () => {
    const accepted = await deploy(pullRequest(8).site.id)

    assert.ok(accepted.status === 201 || accepted.status === 202, accepted.text)
  })

  test('a sealed one marked copy_to_clones does', async () => {
    const marked = await asHuman('PATCH', `/v1/projects/${proj.id}/variables`, {
      environment: 'default',
      set: [
        {
          key: 'EVERYWHERE_SECRET',
          kind: 'sealed',
          copy_to_clones: true,
        },
      ],
    })

    assert.equal(marked.status, 200, marked.text)

    const accepted = await deploy(pullRequest(9).api.id)

    assert.ok(accepted.status === 201 || accepted.status === 202, accepted.text)
  })

  test('production itself still resolves it', async () => {
    await asHuman('PATCH', `/v1/projects/${proj.id}/variables`, {
      environment: 'default',
      set: [
        {
          key: 'EVERYWHERE_SECRET',
          kind: 'sealed',
          copy_to_clones: false,
        },
      ],
    })

    const accepted = await deploy(api.id)

    assert.ok(accepted.status === 201 || accepted.status === 202, accepted.text)
    assert.ok(site)
  })
})
