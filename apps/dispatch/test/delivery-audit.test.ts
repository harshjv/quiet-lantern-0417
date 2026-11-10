import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { recordAudit } from '../src/db/audit.ts'
import { newId } from '../src/db/ids.ts'
import { audit_event } from '../src/db/schema.ts'
import { sha256Digest } from '../src/generation/hash.ts'
import { ephemeralDelivery, renderedDelivery } from '../src/secrets/deliver.ts'

import { startDispatch, type Dispatch } from './helpers/dispatch.ts'

let h: Dispatch

const actor = {
  type: 'system' as const,
  id: 'test',
  client: 'test',
}

const mintedId = /^req_[0-9a-f]{24}$/

const auditsOf = (id: string) =>
  h.db
    .select()
    .from(audit_event)
    .all()
    .filter((row) => (row.target as { id: string }).id === id)

before(async () => {
  h = await startDispatch()
})

after(async () => {
  await h.close()
})

describe('the shared delivery builder', () => {
  const serviceId = newId('service')
  const entries = [
    {
      key: 'API_URL',
      injection: 'env' as const,
      node: {
        kind: 'export' as const,
        from: 'export' as const,
        service_id: serviceId,
        key: 'URL',
        value: 'https://api.internal',
      },
    },
  ]

  test('renders each entry with its refs and audits the decrypt under the subject and purpose', () => {
    const sandboxId = newId('sandbox')
    const body = renderedDelivery(h.db, h.deps.keyring, entries, {
      target: {
        sandbox_id: sandboxId,
      },
      subject: {
        entity: 'sandbox',
        id: sandboxId,
      },
      env_digest: sha256Digest(['API_URL']),
      purpose: 'sandbox',
      actor,
    })
    assert.deepEqual(body, {
      target: {
        sandbox_id: sandboxId,
      },
      env_digest: sha256Digest(['API_URL']),
      purpose: 'sandbox',
      values: [
        {
          key: 'API_URL',
          injection: 'env',
          refs: [
            {
              export: {
                service_id: serviceId,
                key: 'URL',
              },
            },
          ],
          value: Buffer.from('https://api.internal').toString('base64url'),
        },
      ],
      redaction: [],
    })
    const [audit] = auditsOf(sandboxId)
    assert.deepEqual(
      [audit!.action, audit!.purpose, audit!.after],
      [
        'secret.decrypt',
        'sandbox',
        {
          secret_value_ids: [],
        },
      ],
    )
    assert.match(audit!.request_id, mintedId)
  })

  test('refuses a body that does not match secrets.deliver and audits nothing', () => {
    const sandboxId = newId('sandbox')
    assert.throws(
      () =>
        renderedDelivery(h.db, h.deps.keyring, entries, {
          target: {} as never,
          subject: {
            entity: 'sandbox',
            id: sandboxId,
          },
          env_digest: sha256Digest(['API_URL']),
          purpose: 'sandbox',
          actor,
        }),
      {
        code: 'PROTOCOL_INVALID_MESSAGE',
      },
    )
    assert.deepEqual(auditsOf(sandboxId), [])
  })

  test('an ephemeral delivery carries its values without refs or redaction', () => {
    const runId = newId('run')
    assert.deepEqual(
      ephemeralDelivery(
        {
          run_id: runId,
        },
        'run',
        [['TOKEN', 'abc']],
      ),
      {
        target: {
          run_id: runId,
        },
        env_digest: sha256Digest(['TOKEN']),
        purpose: 'run',
        values: [
          {
            key: 'TOKEN',
            injection: 'env',
            refs: [],
            value: Buffer.from('abc').toString('base64url'),
          },
        ],
        redaction: [],
      },
    )
  })
})

describe('audit request ids', () => {
  test('recordAudit keeps a given request id and mints a distinct one otherwise', () => {
    const target = {
      entity: 'project',
      id: newId('project'),
    }
    for (const requestId of ['req_given', undefined, undefined])
      recordAudit(h.db, {
        actor,
        action: 'test.audit',
        target,
        requestId,
      })
    const [given, first, second] = auditsOf(target.id).map((row) => row.request_id)
    assert.equal(given, 'req_given')
    assert.match(first!, mintedId)
    assert.match(second!, mintedId)
    assert.notEqual(first, second)
  })

  test('an API write audits under the request id it answers with, minted when the sent one is malformed', async () => {
    for (const [name, sent] of [
      ['audited-sent', 'req_from-client.1'],
      ['audited-minted', 'not a request id'],
    ] as const) {
      const reply = await h.call('POST', '/v1/projects', {
        token: h.admin.token,
        headers: {
          'x-request-id': sent,
        },
        body: {
          name,
        },
      })
      assert.equal(reply.status, 201, reply.text)
      const answered = reply.headers.get('x-request-id')!
      if (name === 'audited-sent') assert.equal(answered, sent)
      else assert.match(answered, mintedId)
      const [audit] = auditsOf(reply.body.id).filter((row) => row.action === 'project.create')
      assert.equal(audit!.request_id, answered)
    }
  })
})
