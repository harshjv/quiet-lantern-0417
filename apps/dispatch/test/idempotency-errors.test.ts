import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { errorCatalog } from '@stationly/protocol'

import { project } from '../src/db/schema.ts'

import { localOrigin, mintToken, startDispatch, type Dispatch } from './helpers/dispatch.ts'
import { docsSkip, readDoc } from './helpers/docs.ts'

let h: Dispatch

before(async () => {
  h = await startDispatch()
})

after(async () => {
  await h?.close()
})

const post = (
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  token: string = h.admin.token,
) =>
  h.call('POST', path, {
    token,
    body,
    headers,
  })
const projects = () => h.db.select().from(project).all()
const statusOf = (code: string) => errorCatalog.find((e) => e.code === code)?.http

const assertEnvelope = (reply: { status: number; body: any; headers: Headers }, code: string) => {
  assert.equal(reply.status, statusOf(code), `${code} status`)
  assert.deepEqual(Object.keys(reply.body), ['error'])
  const { error } = reply.body
  assert.equal(error.code, code)
  assert.equal(typeof error.explanation, 'string')
  assert.ok(error.explanation.length > 0)
  assert.equal(typeof error.fix, 'string')
  assert.ok(error.fix.length > 0)
  assert.match(error.request_id, /^[A-Za-z0-9_.:-]{1,128}$/)
  assert.equal(error.request_id, reply.headers.get('x-request-id'))
  assert.equal(reply.headers.get('x-stationly-version'), '0.0.0')
  assert.ok(
    error.details === undefined || (typeof error.details === 'object' && error.details !== null),
  )
  assert.deepEqual(
    Object.keys(error).filter(
      (k) => !['code', 'explanation', 'fix', 'details', 'request_id'].includes(k),
    ),
    [],
  )
  return error
}

describe('idempotency', () => {
  test('a repeat with the same key and body replays the stored response and creates one entity', async () => {
    const first = await post(
      '/v1/projects',
      {
        name: 'idem-one',
      },
      {
        'idempotency-key': 'create-idem-one',
      },
    )
    assert.equal(first.status, 201)
    assert.equal(first.headers.get('idempotent-replayed'), null)
    const second = await post(
      '/v1/projects',
      {
        name: 'idem-one',
      },
      {
        'idempotency-key': 'create-idem-one',
      },
    )
    assert.equal(second.status, 201)
    assert.equal(second.headers.get('idempotent-replayed'), 'true')
    assert.deepEqual(second.body, first.body)
    assert.equal(projects().filter((p) => p.name === 'idem-one').length, 1)
  })

  test('the same key with a different body is IDEMPOTENCY_MISMATCH', async () => {
    await post(
      '/v1/projects',
      {
        name: 'idem-two',
      },
      {
        'idempotency-key': 'mismatch-key',
      },
    )
    const reply = await post(
      '/v1/projects',
      {
        name: 'idem-three',
      },
      {
        'idempotency-key': 'mismatch-key',
      },
    )
    const error = assertEnvelope(reply, 'IDEMPOTENCY_MISMATCH')
    assert.equal(error.details.method, 'POST')
    assert.equal(error.details.path, '/v1/projects')
    assert.ok(!projects().some((p) => p.name === 'idem-three'))
  })

  test('the same key on a different path is IDEMPOTENCY_MISMATCH', async () => {
    const created = await post(
      '/v1/projects',
      {
        name: 'idem-path',
      },
      {
        'idempotency-key': 'path-key',
      },
    )
    const reply = await post(
      `/v1/projects/${created.body.id}/environments`,
      {
        name: 'qa',
      },
      {
        'idempotency-key': 'path-key',
      },
    )
    assertEnvelope(reply, 'IDEMPOTENCY_MISMATCH')
  })

  test('body key order does not change the request fingerprint', async () => {
    const first = await post(
      '/v1/projects',
      {
        name: 'idem-order',
        default_environment_name: 'live',
      },
      {
        'idempotency-key': 'order-key',
      },
    )
    const second = await post(
      '/v1/projects',
      {
        default_environment_name: 'live',
        name: 'idem-order',
      },
      {
        'idempotency-key': 'order-key',
      },
    )
    assert.equal(first.status, 201)
    assert.equal(second.status, 201)
    assert.equal(second.headers.get('idempotent-replayed'), 'true')
  })

  test('a key outside visible ASCII is VALIDATION_FAILED', async () => {
    const reply = await post(
      '/v1/projects',
      {
        name: 'idem-bad',
      },
      {
        'idempotency-key': 'has space',
      },
    )
    const error = assertEnvelope(reply, 'VALIDATION_FAILED')
    assert.deepEqual(error.details.issues, [
      {
        path: 'header:idempotency-key',
        message: 'invalid',
      },
    ])
    assert.ok(!projects().some((p) => p.name === 'idem-bad'))
  })

  test('a key of 256 characters is refused and 255 is accepted', async () => {
    assert.equal(
      (
        await post(
          '/v1/projects',
          {
            name: 'idem-long',
          },
          {
            'idempotency-key': 'k'.repeat(256),
          },
        )
      ).status,
      400,
    )
    assert.equal(
      (
        await post(
          '/v1/projects',
          {
            name: 'idem-max',
          },
          {
            'idempotency-key': 'k'.repeat(255),
          },
        )
      ).status,
      201,
    )
  })

  test('a failed request releases its key so the retry runs', async () => {
    await post('/v1/projects', {
      name: 'idem-taken',
    })
    const failed = await post(
      '/v1/projects',
      {
        name: 'idem-taken',
      },
      {
        'idempotency-key': 'retry-key',
      },
    )
    assertEnvelope(failed, 'NAME_TAKEN')
    const taken = projects().find((p) => p.name === 'idem-taken')!
    assert.equal(
      (
        await h.call('DELETE', `/v1/projects/${taken.id}`, {
          token: h.admin.token,
        })
      ).status,
      200,
    )
    const retry = await post(
      '/v1/projects',
      {
        name: 'idem-taken',
      },
      {
        'idempotency-key': 'retry-key',
      },
    )
    assert.equal(retry.status, 201)
    assert.equal(retry.headers.get('idempotent-replayed'), null)
  })

  test('a different body after a failure on the same key is not a mismatch', async () => {
    await post('/v1/projects', {
      name: 'idem-taken-two',
    })
    assertEnvelope(
      await post(
        '/v1/projects',
        {
          name: 'idem-taken-two',
        },
        {
          'idempotency-key': 'free-key',
        },
      ),
      'NAME_TAKEN',
    )
    const reply = await post(
      '/v1/projects',
      {
        name: 'idem-free',
      },
      {
        'idempotency-key': 'free-key',
      },
    )
    assert.equal(reply.status, 201)
  })

  test('keys are scoped per actor', async () => {
    const other = await mintToken(
      h,
      [
        {
          project_id: '*',
          environment_id: '*',
          level: 'admin',
        },
      ],
      'other actor',
    )
    const mine = await post(
      '/v1/projects',
      {
        name: 'actor-a',
      },
      {
        'idempotency-key': 'shared-key',
      },
    )
    const theirs = await post(
      '/v1/projects',
      {
        name: 'actor-b',
      },
      {
        'idempotency-key': 'shared-key',
      },
      other,
    )
    assert.equal(mine.status, 201)
    assert.equal(theirs.status, 201)
    assert.equal(theirs.headers.get('idempotent-replayed'), null)
    assert.notEqual(mine.body.id, theirs.body.id)
  })

  test('a replayed delete answers the stored result instead of NOT_FOUND', async () => {
    const created = await post('/v1/projects', {
      name: 'idem-delete',
    })
    const first = await h.call('DELETE', `/v1/projects/${created.body.id}`, {
      token: h.admin.token,
      headers: {
        'idempotency-key': 'delete-key',
      },
    })
    const second = await h.call('DELETE', `/v1/projects/${created.body.id}`, {
      token: h.admin.token,
      headers: {
        'idempotency-key': 'delete-key',
      },
    })
    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    assert.equal(second.headers.get('idempotent-replayed'), 'true')
    assert.deepEqual(second.body, first.body)
  })

  test('reads ignore the header', async () => {
    const reply = await h.call('GET', '/v1/projects', {
      token: h.admin.token,
      headers: {
        'idempotency-key': 'has space',
      },
    })
    assert.equal(reply.status, 200)
  })
})

describe('error envelope', () => {
  test('VALIDATION_FAILED lists issues with path and message', async () => {
    const reply = await post('/v1/projects', {
      name: 'Not A Slug',
      extra: true,
    })
    const error = assertEnvelope(reply, 'VALIDATION_FAILED')
    assert.ok(Array.isArray(error.details.issues))
    assert.ok(error.details.issues.length >= 1)
    for (const issue of error.details.issues) {
      assert.equal(typeof issue.path, 'string')
      assert.equal(typeof issue.message, 'string')
    }
    assert.match(error.explanation, /\//)
  })

  test('an unparseable body is VALIDATION_FAILED', async () => {
    const response = await h.fetch(
      new Request(`${localOrigin}/v1/projects`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${h.admin.token}`,
          'content-type': 'application/json',
        },
        body: '{nope',
      }),
    )
    const body = await response.json()
    assertEnvelope(
      {
        status: response.status,
        body,
        headers: response.headers,
      },
      'VALIDATION_FAILED',
    )
  })

  test('a missing credential is UNAUTHENTICATED with the token fix', async () => {
    const reply = await h.call('GET', '/v1/projects')
    const error = assertEnvelope(reply, 'UNAUTHENTICATED')
    assert.match(error.fix, /Bearer/)
  })

  test('a bogus token is UNAUTHENTICATED', async () => {
    assertEnvelope(
      await h.call('GET', '/v1/projects', {
        token: 'sly_not-a-real-token',
      }),
      'UNAUTHENTICATED',
    )
  })

  test('a read token that mutates is FORBIDDEN_SCOPE and names the required scope', async () => {
    const created = await post('/v1/projects', {
      name: 'scoped-read',
    })
    const key = await mintToken(
      h,
      [
        {
          project_id: created.body.id,
          environment_id: created.body.default_environment_id,
          level: 'read',
        },
      ],
      'reader',
    )
    const reply = await post(
      `/v1/projects/${created.body.id}/environments`,
      {
        name: 'extra',
      },
      {},
      key,
    )
    const error = assertEnvelope(reply, 'FORBIDDEN_SCOPE')
    assert.equal(error.details.required.level, 'deploy')
    assert.equal(error.details.required.project_id, created.body.id)
  })

  test('NOT_FOUND for an unknown entity and for an unknown route', async () => {
    const entity = await h.call('GET', '/v1/services/svc_00000000000000000000000000', {
      token: h.admin.token,
    })
    assertEnvelope(entity, 'NOT_FOUND')
    const route = await h.call('GET', '/v1/definitely-not-a-route', {
      token: h.admin.token,
    })
    const error = assertEnvelope(route, 'NOT_FOUND')
    assert.match(error.fix, /openapi/)
  })

  test('an unknown name in a nested path is NOT_FOUND naming it, and only after authentication', async () => {
    const created = await post('/v1/projects', {
      name: 'nested-missing',
    })
    const path = `/v1/projects/${created.body.name}/environments/nope/services/web`
    const missing = await h.call('GET', path, {
      token: h.admin.token,
    })
    const error = assertEnvelope(missing, 'NOT_FOUND')
    assert.match(error.explanation, /environment nope/)
    const service = await h.call(
      'GET',
      `/v1/projects/${created.body.name}/environments/production/services/nope`,
      {
        token: h.admin.token,
      },
    )
    assert.match(assertEnvelope(service, 'NOT_FOUND').explanation, /service nope/)
    const anonymous = await h.call('GET', path, {
      token: null,
    })
    assertEnvelope(anonymous, 'UNAUTHENTICATED')
  })

  test('NAME_TAKEN is a 409 with the name in details', async () => {
    await post('/v1/projects', {
      name: 'envelope-dup',
    })
    const error = assertEnvelope(
      await post('/v1/projects', {
        name: 'envelope-dup',
      }),
      'NAME_TAKEN',
    )
    assert.deepEqual(error.details, {
      name: 'envelope-dup',
    })
  })

  test('WRONG_HOST for a host that is neither loopback nor a configured surface', async () => {
    const response = await h.fetch(
      new Request('http://evil.example.com/v1/projects', {
        headers: {
          authorization: `Bearer ${h.admin.token}`,
        },
      }),
    )
    const body = await response.json()
    assertEnvelope(
      {
        status: response.status,
        body,
        headers: response.headers,
      },
      'WRONG_HOST',
    )
  })

  test('a sent x-request-id is echoed in the header and the body', async () => {
    const reply = await h.call('GET', '/v1/projects/nope-nothing', {
      token: h.admin.token,
      headers: {
        'x-request-id': 'trace-123.abc',
      },
    })
    assert.equal(reply.headers.get('x-request-id'), 'trace-123.abc')
    assert.equal(reply.body.error.request_id, 'trace-123.abc')
  })

  test('a malformed x-request-id is replaced and a missing one is generated', async () => {
    const bad = await h.call('GET', '/v1/projects', {
      token: h.admin.token,
      headers: {
        'x-request-id': 'bad id with spaces',
      },
    })
    assert.match(bad.headers.get('x-request-id')!, /^req_[0-9a-f]{24}$/)
    const none = await h.call('GET', '/v1/projects', {
      token: h.admin.token,
    })
    assert.match(none.headers.get('x-request-id')!, /^req_[0-9a-f]{24}$/)
    assert.notEqual(none.headers.get('x-request-id'), bad.headers.get('x-request-id'))
  })

  test('every success carries x-request-id and x-stationly-version', async () => {
    const reply = await h.call('GET', '/v1/me', {
      token: h.admin.token,
    })
    assert.equal(reply.status, 200)
    assert.ok(reply.headers.get('x-request-id'))
    assert.equal(reply.headers.get('x-stationly-version'), '0.0.0')
  })

  test('the request id of a mutation lands on its audit event', async () => {
    const created = await post(
      '/v1/projects',
      {
        name: 'audited',
      },
      {
        'x-request-id': 'audit-me-1',
      },
    )
    assert.equal(created.status, 201)
    const audit = await h.call('GET', '/v1/audit?action=project.create', {
      token: h.admin.token,
    })
    assert.ok(
      audit.body.items.some(
        (e: any) => e.request_id === 'audit-me-1' && e.target.id === created.body.id,
      ),
    )
  })

  test('repeated unauthenticated requests from one address end in RATE_LIMITED with Retry-After', async () => {
    const headers = {
      'x-forwarded-for': '203.0.113.77',
    }
    const send = () =>
      h.call('GET', '/v1/projects', {
        headers,
      })
    let last = await send()
    for (let i = 1; i < 40 && last.status !== 429; i++) last = await send()
    const error = assertEnvelope(last, 'RATE_LIMITED')
    assert.ok(Number(last.headers.get('retry-after')) >= 1)
    assert.ok(error.details.retry_after_s >= 1)
  })
})

describe(
  'error catalog',
  {
    skip: docsSkip,
  },
  () => {
    const documented = () => {
      const text = readDoc('13-api.md')
      return [...text.matchAll(/^\| `([A-Z_]+)` \| (\d{3}|none) \|/gm)].map(
        (m) => [m[1]!, m[2] === 'none' ? null : Number(m[2])] as const,
      )
    }

    test('every code in docs/13-api.md has the documented HTTP status in the protocol catalog', () => {
      const rows = documented()
      assert.ok(rows.length > 60)
      for (const [code, http] of rows) {
        const entry = errorCatalog.find((e) => e.code === code)
        assert.ok(entry, `${code} is missing from the catalog`)
        assert.equal(entry.http, http, `${code} status`)
      }
    })

    test('every catalog code with an HTTP status appears in docs/13-api.md', () => {
      const codes = new Set(documented().map(([code]) => code))
      const missing = errorCatalog
        .filter((e) => e.http !== null && !codes.has(e.code))
        .map((e) => e.code)
      assert.deepEqual(missing, [])
    })
  },
)
