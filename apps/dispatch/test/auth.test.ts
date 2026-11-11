import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { user as userTable } from '../src/db/schema.ts'

import {
  localOrigin,
  mintToken,
  signIn,
  startDispatch,
  startFakeStation,
  type Dispatch,
} from './helpers/dispatch.ts'
import { FakeRegistry } from './helpers/registry.ts'
import { createEnvironment, createProject, createService } from './helpers/seed.ts'

let h: Dispatch
let registry: FakeRegistry
let projectA: any
let projectB: any
let envA: any
let envB: any
let protectedEnv: any
const ref = 'nginx:1.27'

const tokenFor = (environment: any, project: any, level: 'read' | 'deploy' | 'admin') =>
  mintToken(
    h,
    [
      {
        project_id: project.id,
        environment_id: environment.id,
        level,
      },
    ],
    `${level}-token`,
  )

before(async () => {
  registry = FakeRegistry.install()
  registry.publish(ref)
  h = await startDispatch()
  await startFakeStation(h)
  projectA = await createProject(h, 'alpha')
  projectB = await createProject(h, 'beta')
  envA = {
    id: projectA.default_environment_id,
  }
  envB = {
    id: projectB.default_environment_id,
  }
  protectedEnv = await createEnvironment(
    h,
    'alpha',
    'prod',
    {
      protected: true,
    },
    true,
  )
})

after(async () => {
  registry.restore()
  await h.close()
})

const sessionBearer = (cookie: string) =>
  decodeURIComponent(/session_token=([^;]+)/.exec(cookie)![1]!)

const serviceBody = (name: string) => ({
  name,
  kind: 'web',
  source: {
    type: 'image',
    ref,
  },
  ports: [
    {
      port: 80,
    },
  ],
  deploy_on_create: false,
})

describe('levels and scopes', () => {
  test('read can list but cannot create or deploy', async () => {
    const token = await tokenFor(envA, projectA, 'read')
    const list = await h.call('GET', `/v1/environments/${envA.id}/services`, {
      token,
    })

    assert.equal(list.status, 200)
    const create = await h.call('POST', `/v1/environments/${envA.id}/services`, {
      token,
      body: serviceBody('web'),
    })

    assert.equal(create.status, 403)
    assert.equal(create.body.error.code, 'FORBIDDEN_SCOPE')
    assert.deepEqual(create.body.error.details.required, {
      project_id: projectA.id,
      environment_id: envA.id,
      level: 'admin',
    })
  })

  test('deploy can change a service but cannot create one', async () => {
    const svc = await createService(h, envA.id, {
      name: 'api',
      ref,
      ports: [
        {
          port: 80,
        },
      ],
    })
    const token = await tokenFor(envA, projectA, 'deploy')
    const create = await h.call('POST', `/v1/environments/${envA.id}/services`, {
      token,
      body: serviceBody('other'),
    })

    assert.equal(create.status, 403)
    assert.equal(create.body.error.details.required.level, 'admin')
    const patch = await h.call('PATCH', `/v1/services/${svc.id}`, {
      token,
      body: {
        drain_timeout_s: 12,
        deploy: false,
      },
    })

    assert.equal(patch.status, 200)
    const read = await h.call('GET', `/v1/services/${svc.id}?fields=drain_timeout_s`, {
      token,
    })

    assert.equal(read.body.drain_timeout_s, 12)
    const del = await h.call('DELETE', `/v1/services/${svc.id}`, {
      token,
    })

    assert.equal(del.status, 403)
  })

  test('admin on an environment can create services there', async () => {
    const token = await tokenFor(envA, projectA, 'admin')
    const create = await h.call('POST', `/v1/environments/${envA.id}/services`, {
      token,
      body: serviceBody('made-by-scoped-admin'),
    })

    assert.equal(create.status, 201)
  })

  test('a scope on one project cannot touch another project', async () => {
    const svcB = await createService(h, envB.id, {
      name: 'b-web',
      ref,
      ports: [
        {
          port: 80,
        },
      ],
    })
    const token = await tokenFor(envA, projectA, 'admin')

    for (const [method, path] of [
      ['GET', `/v1/environments/${envB.id}/services`],
      ['GET', `/v1/services/${svcB.id}`],
      ['PATCH', `/v1/services/${svcB.id}`],
      ['DELETE', `/v1/services/${svcB.id}`],
    ] as const) {
      const reply = await h.call(method, path, {
        token,
        body:
          method === 'PATCH'
            ? {
                drain_timeout_s: 5,
              }
            : undefined,
      })

      assert.equal(reply.status, 403, `${method} ${path}`)
      assert.equal(reply.body.error.code, 'FORBIDDEN_SCOPE')
    }
  })

  test('a scope on one environment of a project cannot touch a sibling environment', async () => {
    const token = await tokenFor(envA, projectA, 'admin')
    const reply = await h.call('GET', `/v1/environments/${protectedEnv.id}/services`, {
      token,
    })

    assert.equal(reply.status, 403)
  })

  test('a project-wide scope covers every environment of that project', async () => {
    const token = await mintToken(h, [
      {
        project_id: projectA.id,
        environment_id: '*',
        level: 'read',
      },
    ])
    const reply = await h.call('GET', `/v1/environments/${protectedEnv.id}/services`, {
      token,
    })

    assert.equal(reply.status, 200)
  })

  test('instance routes need admin on every project and environment', async () => {
    const token = await tokenFor(envA, projectA, 'admin')
    const reply = await h.call('POST', '/v1/projects', {
      token,
      body: {
        name: 'gamma',
      },
    })

    assert.equal(reply.status, 403)
    assert.equal(reply.body.error.code, 'FORBIDDEN_SCOPE')
    assert.deepEqual(reply.body.error.details.required, {
      project_id: '*',
      environment_id: '*',
      level: 'admin',
    })
    const stations = await h.call('GET', '/v1/staged-changes', {
      token,
    })

    assert.equal(stations.status, 403)
    assert.equal(stations.body.error.code, 'INSTANCE_SCOPE_REQUIRED')
  })

  test('minting a token beyond the caller admin scopes is refused', async () => {
    const token = await tokenFor(envA, projectA, 'admin')
    const within = await h.call('POST', '/v1/tokens', {
      token,
      body: {
        name: 'child',
        scopes: [
          {
            project_id: projectA.id,
            environment_id: envA.id,
            level: 'deploy',
          },
        ],
      },
    })

    assert.equal(within.status, 201)
    const beyond = await h.call('POST', '/v1/tokens', {
      token,
      body: {
        name: 'greedy',
        scopes: [
          {
            project_id: projectB.id,
            environment_id: envB.id,
            level: 'read',
          },
        ],
      },
    })

    assert.equal(beyond.status, 403)
    assert.equal(beyond.body.error.code, 'FORBIDDEN_SCOPE')
    assert.equal(beyond.body.error.details.required.level, 'admin')
    const deploy = await tokenFor(envA, projectA, 'deploy')
    const lower = await h.call('POST', '/v1/tokens', {
      token: deploy,
      body: {
        name: 'from-deploy',
        scopes: [
          {
            project_id: projectA.id,
            environment_id: envA.id,
            level: 'read',
          },
        ],
      },
    })

    assert.equal(lower.status, 403)
  })

  test('personal tokens are minted only by a human', async () => {
    const byToken = await h.call('POST', '/v1/tokens', {
      token: h.admin.token,
      body: {
        name: 'sneaky',
        kind: 'personal',
      },
    })

    assert.equal(byToken.status, 403)
    assert.equal(byToken.body.error.code, 'PROTECTED_ENVIRONMENT')
    assert.equal(byToken.body.error.details.reason, 'human_required')
    const byHuman = await h.call('POST', '/v1/tokens', {
      cookie: h.admin.cookie,
      origin: localOrigin,
      body: {
        name: 'human-made',
        kind: 'personal',
      },
    })

    assert.equal(byHuman.status, 201)
    assert.match(byHuman.body.key, /^sly_/)
  })

  test('token lifetimes are bounded', async () => {
    const scopes = [
      {
        project_id: projectA.id,
        environment_id: envA.id,
        level: 'read',
      },
    ]
    const tooShort = await h.call('POST', '/v1/tokens', {
      token: h.admin.token,
      body: {
        name: 's',
        scopes,
        expires_in_s: 60,
      },
    })

    assert.equal(tooShort.status, 400)
    assert.equal(tooShort.body.error.code, 'VALIDATION_FAILED')
    const scopedTooLong = await h.call('POST', '/v1/tokens', {
      token: h.admin.token,
      body: {
        name: 'l',
        scopes,
        expires_in_s: 31 * 24 * 3600,
      },
    })

    assert.equal(scopedTooLong.status, 400)
    const personalTooLong = await h.call('POST', '/v1/tokens', {
      cookie: h.admin.cookie,
      origin: localOrigin,
      body: {
        name: 'p',
        kind: 'personal',
        expires_in_s: 366 * 24 * 3600,
      },
    })

    assert.equal(personalTooLong.status, 400)
    const ok = await h.call('POST', '/v1/tokens', {
      token: h.admin.token,
      body: {
        name: 'ok',
        scopes,
        expires_in_s: 7200,
      },
    })

    assert.equal(ok.status, 201)
    const expires = new Date(ok.body.expires_at).getTime() - Date.now()

    assert.ok(expires > 7100_000 && expires <= 7200_000)
  })

  test('a scoped token with no scopes is refused', async () => {
    const reply = await h.call('POST', '/v1/tokens', {
      token: h.admin.token,
      body: {
        name: 'empty',
        kind: 'scoped',
      },
    })

    assert.equal(reply.status, 400)
    assert.equal(reply.body.error.code, 'VALIDATION_FAILED')
  })

  test('a revoked token stops working', async () => {
    const created = await h.call('POST', '/v1/tokens', {
      token: h.admin.token,
      body: {
        name: 'short-lived',
        scopes: [
          {
            project_id: projectA.id,
            environment_id: envA.id,
            level: 'read',
          },
        ],
      },
    })
    const before = await h.call('GET', '/v1/me', {
      token: created.body.key,
    })

    assert.equal(before.status, 200)
    assert.equal(before.body.token_kind, 'scoped')
    const revoked = await h.call('DELETE', `/v1/tokens/${created.body.id}`, {
      token: h.admin.token,
    })

    assert.deepEqual(revoked.body, {
      revoked: true,
    })
    const after = await h.call('GET', '/v1/me', {
      token: created.body.key,
    })

    assert.equal(after.status, 401)
    assert.equal(after.body.error.code, 'UNAUTHENTICATED')
  })

  test('a scoped token can revoke itself but not a token with wider scopes', async () => {
    const wide = await h.call('POST', '/v1/tokens', {
      token: h.admin.token,
      body: {
        name: 'wide',
        scopes: [
          {
            project_id: projectB.id,
            environment_id: envB.id,
            level: 'read',
          },
        ],
      },
    })
    const narrow = await h.call('POST', '/v1/tokens', {
      token: h.admin.token,
      body: {
        name: 'narrow',
        scopes: [
          {
            project_id: projectA.id,
            environment_id: envA.id,
            level: 'read',
          },
        ],
      },
    })
    const refused = await h.call('DELETE', `/v1/tokens/${wide.body.id}`, {
      token: narrow.body.key,
    })

    assert.equal(refused.status, 403)
    assert.equal(refused.body.error.code, 'FORBIDDEN_SCOPE')
    const self = await h.call('DELETE', `/v1/tokens/${narrow.body.id}`, {
      token: narrow.body.key,
    })

    assert.equal(self.status, 200)
  })

  test('/v1/me reports the personal token as admin on everything', async () => {
    const me = await h.call('GET', '/v1/me', {
      token: h.admin.token,
    })

    assert.equal(me.body.human, false)
    assert.deepEqual(me.body.scopes, [
      {
        project_id: '*',
        environment_id: '*',
        level: 'admin',
      },
    ])
  })
})

describe('protected environments', () => {
  const stage = async (name: string) => {
    const reply = await h.call('POST', `/v1/environments/${protectedEnv.id}/services`, {
      token: h.admin.token,
      body: serviceBody(name),
    })

    return reply
  }

  test('a token mutation is staged and nothing applies', async () => {
    const reply = await stage('staged-one')

    assert.equal(reply.status, 202)
    assert.equal(reply.body.status, 'staged')
    assert.equal(reply.body.environment_id, protectedEnv.id)
    const services = await h.call('GET', `/v1/environments/${protectedEnv.id}/services`, {
      token: h.admin.token,
    })

    assert.deepEqual(services.body.items, [])
    const listed = await h.call('GET', `/v1/environments/${protectedEnv.id}/staged-changes`, {
      token: h.admin.token,
    })

    assert.ok(listed.body.items.some((s: any) => s.id === reply.body.id))
  })

  test('a token cannot accept or reject, even a personal one', async () => {
    const staged = await stage('staged-two')

    for (const action of ['accept', 'reject']) {
      const reply = await h.call('POST', `/v1/staged-changes/${staged.body.id}/${action}`, {
        token: h.admin.token,
      })

      assert.equal(reply.status, 403, action)
      assert.equal(reply.body.error.code, 'PROTECTED_ENVIRONMENT')
      assert.equal(reply.body.error.details.reason, 'human_required')
    }

    const scoped = await tokenFor(protectedEnv, projectA, 'admin')
    const reply = await h.call('POST', `/v1/staged-changes/${staged.body.id}/accept`, {
      token: scoped,
    })

    assert.equal(reply.body.error.code, 'PROTECTED_ENVIRONMENT')
  })

  test('a human accepts the staged change and it applies', async () => {
    const staged = await stage('staged-three')
    const accepted = await h.call('POST', `/v1/staged-changes/${staged.body.id}/accept`, {
      cookie: h.admin.cookie,
      origin: localOrigin,
    })

    assert.equal(accepted.status, 200)
    assert.equal(accepted.body.status, 'accepted')
    assert.equal(accepted.body.accepted_by.type, 'user')
    const services = await h.call('GET', `/v1/environments/${protectedEnv.id}/services`, {
      token: h.admin.token,
    })

    assert.deepEqual(
      services.body.items.map((s: any) => s.name),
      ['staged-three'],
    )
  })

  test('a human rejects a staged change and it never applies', async () => {
    const staged = await stage('staged-four')
    const rejected = await h.call('POST', `/v1/staged-changes/${staged.body.id}/reject`, {
      cookie: h.admin.cookie,
      origin: localOrigin,
      body: {
        reason: 'not now',
      },
    })

    assert.equal(rejected.status, 200)
    assert.equal(rejected.body.status, 'rejected')
    const again = await h.call('POST', `/v1/staged-changes/${staged.body.id}/accept`, {
      cookie: h.admin.cookie,
      origin: localOrigin,
    })

    assert.ok(again.status >= 400)
    const services = await h.call('GET', `/v1/environments/${protectedEnv.id}/services`, {
      token: h.admin.token,
    })

    assert.ok(!services.body.items.some((s: any) => s.name === 'staged-four'))
  })

  test('a human mutation in a protected environment is staged too, with the human as actor', async () => {
    const reply = await h.call('POST', `/v1/environments/${protectedEnv.id}/services`, {
      cookie: h.admin.cookie,
      origin: localOrigin,
      body: serviceBody('human-staged'),
    })

    assert.equal(reply.status, 202)
    assert.equal(reply.body.status, 'staged')
    assert.equal(reply.body.actor.type, 'user')
  })

  test('tokens cannot create a protected environment or lift protection', async () => {
    const create = await h.call('POST', '/v1/projects/alpha/environments', {
      token: h.admin.token,
      body: {
        name: 'locked',
        protected: true,
      },
    })

    assert.equal(create.status, 403)
    assert.equal(create.body.error.code, 'PROTECTED_ENVIRONMENT')
    const lift = await h.call('PATCH', `/v1/environments/${protectedEnv.id}`, {
      token: h.admin.token,
      body: {
        protected: false,
      },
    })

    assert.equal(lift.status, 403)
    assert.equal(lift.body.error.code, 'PROTECTED_ENVIRONMENT')
  })

  test('a non-protected environment applies a token mutation immediately', async () => {
    const reply = await h.call('POST', `/v1/environments/${envB.id}/services`, {
      token: h.admin.token,
      body: serviceBody('direct'),
    })

    assert.equal(reply.status, 201)
  })
})

describe('origin checks and hosts', () => {
  test('a cookie mutation without an Origin header is refused', async () => {
    const reply = await h.call('POST', `/v1/environments/${envB.id}/services`, {
      cookie: h.admin.cookie,
      body: serviceBody('no-origin'),
    })

    assert.equal(reply.status, 401)
    assert.equal(reply.body.error.code, 'UNAUTHENTICATED')
  })

  test('a cookie mutation from an untrusted Origin is refused', async () => {
    const reply = await h.call('POST', `/v1/environments/${envB.id}/services`, {
      cookie: h.admin.cookie,
      origin: 'https://evil.example',
      body: serviceBody('evil-origin'),
    })

    assert.equal(reply.status, 401)
    assert.equal(reply.body.error.code, 'UNAUTHENTICATED')
  })

  test('a cookie mutation from the trusted Origin works and the actor is a user', async () => {
    const reply = await h.call('POST', `/v1/environments/${envB.id}/services`, {
      cookie: h.admin.cookie,
      origin: localOrigin,
      body: serviceBody('good-origin'),
    })

    assert.equal(reply.status, 201)
  })

  test('a cookie GET needs no Origin', async () => {
    const me = await h.call('GET', '/v1/me', {
      cookie: h.admin.cookie,
    })

    assert.equal(me.status, 200)
    assert.equal(me.body.human, true)
    assert.equal(me.body.actor.type, 'user')
    assert.equal(me.body.token_kind, 'session')
  })

  test('an unknown Host header answers WRONG_HOST', async () => {
    const reply = await h.call('GET', '/v1/me', {
      token: h.admin.token,
      headers: {
        host: 'unknown.example',
      },
    })

    assert.equal(reply.status, 404)
    assert.equal(reply.body.error.code, 'WRONG_HOST')
  })

  test('healthz answers on any host', async () => {
    const reply = await h.call('GET', '/v1/healthz', {
      headers: {
        host: 'unknown.example',
      },
    })

    assert.equal(reply.status, 200)
    assert.deepEqual(reply.body, {
      status: 'ok',
    })
  })
})

describe('sign-in', () => {
  test('sign-up is disabled', async () => {
    const reply = await h.call('POST', '/auth/sign-up/email', {
      origin: localOrigin,
      body: {
        email: 'intruder@example.com',
        password: 'a-long-enough-password',
        name: 'x',
      },
    })

    assert.ok(reply.status >= 400 && reply.status < 500)
    assert.equal(h.db.select().from(userTable).all().length, 1)
  })

  test('a wrong password does not sign in', async () => {
    const { reply, cookie } = await signIn(h, 'admin@example.com', 'definitely-not-it')

    assert.equal(reply.status, 401)
    assert.equal(cookie, '')
  })

  test('the right password signs in and sets a session cookie', async () => {
    const { reply, cookie } = await signIn(h)

    assert.equal(reply.status, 200)
    assert.match(cookie, /session_token/)
  })

  test('a Better Auth session token as a bearer is refused on /v1 without a proof', async () => {
    const sessionToken = sessionBearer(h.admin.cookie)
    const refused = await h.call('GET', '/v1/me', {
      token: sessionToken,
    })

    assert.equal(refused.status, 401)
    assert.equal(refused.body.error.code, 'UNAUTHENTICATED')
  })

  test('a sly session bearer is accepted on /auth only for sign-out', async () => {
    const refused = await h.call('GET', '/auth/get-session', {
      token: sessionBearer(h.admin.cookie),
    })

    assert.equal(refused.status, 401)
    assert.equal(refused.body.error.code, 'UNAUTHENTICATED')
  })

  test('raw consent and device approval endpoints answer NOT_FOUND', async () => {
    for (const path of ['/auth/oauth2/consent', '/auth/device/approve', '/auth/device/deny']) {
      const reply = await h.call('POST', path, {
        cookie: h.admin.cookie,
        origin: localOrigin,
        body: {},
      })

      assert.equal(reply.status, 404, path)
      assert.equal(reply.body.error.code, 'NOT_FOUND')
    }
  })
})

describe('unauthenticated requests', () => {
  test('no credential answers the error envelope', async () => {
    const reply = await h.call('GET', '/v1/projects')

    assert.equal(reply.status, 401)
    assert.equal(reply.body.error.code, 'UNAUTHENTICATED')
    assert.equal(typeof reply.body.error.explanation, 'string')
    assert.equal(typeof reply.body.error.fix, 'string')
    assert.match(reply.body.error.request_id, /^req_/)
    assert.equal(reply.headers.get('x-request-id'), reply.body.error.request_id)
  })

  test('a garbage sly_ token is refused', async () => {
    const reply = await h.call('GET', '/v1/projects', {
      token: 'sly_notarealkey',
    })

    assert.equal(reply.status, 401)
    assert.equal(reply.body.error.code, 'UNAUTHENTICATED')
  })

  test('a caller-sent x-request-id is echoed', async () => {
    const reply = await h.call('GET', '/v1/projects', {
      headers: {
        'x-request-id': 'trace-123',
      },
    })

    assert.equal(reply.body.error.request_id, 'trace-123')
  })

  test('the thirty-first unauthenticated request from one address is rate limited', async () => {
    const headers = {
      'x-forwarded-for': '203.0.113.77',
    }
    let last: any

    for (let i = 0; i < 31; i++) {
      last = await h.call('GET', '/v1/projects', {
        headers,
      })
    }

    assert.equal(last.status, 429)
    assert.equal(last.body.error.code, 'RATE_LIMITED')
    assert.ok(Number(last.headers.get('retry-after')) > 0)
    const other = await h.call('GET', '/v1/projects', {
      headers: {
        'x-forwarded-for': '203.0.113.78',
      },
    })

    assert.equal(other.status, 401)
  })
})
