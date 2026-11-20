import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { buildRedactor, encodedForms } from '../src/api/redaction.ts'
import { redactionKnown, secretsDeliver } from '../src/secrets/deploy.ts'

import { startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import { FakeRegistry } from './helpers/registry.ts'
import {
  approveWaiting,
  createApp,
  createProject,
  productionId,
  seedLockfile,
  waitForActive,
  waitForDeployment,
} from './helpers/seed.ts'

let h: Dispatch
let registry: FakeRegistry
let deploymentId: string

const secretValue = 'secret value/with+chars 1234'
const literalValue = 'https://app.example.com/base'
const projectSecret = 'project-secret-9876543210'
const projectLiteral = 'plain-project-literal'
const actor = {
  type: 'system',
  id: 'test',
} as never

before(async () => {
  registry = FakeRegistry.install()
  registry.publish('nginx:1.27')
  h = await startDispatch()
  seedLockfile(h)
  await startFakeStation(h)
  const project = await createProject(h, 'redaction')
  const set = await approveWaiting(
    h,
    await h.call('PATCH', `/v1/projects/${project.id}/environment-variables`, {
      token: h.admin.token,
      body: {
        set: [
          {
            name: 'PROJ_SEALED',
            kind: 'secret',
            value: projectSecret,
          },
          {
            name: 'PROJ_LITERAL',
            kind: 'literal',
            value: projectLiteral,
          },
        ],
        apply: false,
      },
    }),
  )

  assert.equal(set.status, 200, set.text)
  const created = await createApp(h, productionId(h, project.id), {
    name: 'web',
    ref: 'nginx:1.27',
    ports: [
      {
        port: 80,
      },
    ],
    deploy: true,
    environment_variables: [
      {
        name: 'BASE_URL',
        kind: 'literal',
        value: literalValue,
      },
      {
        name: 'API_KEY',
        kind: 'secret',
        value: secretValue,
      },
      {
        name: 'SECRET_KEY',
        kind: 'reference',
        reference: '${{secret(32)}}',
      },
      {
        name: 'DB_URL',
        kind: 'reference',
        reference: 'postgres://u:${{project.PROJ_SEALED}}@db/app',
      },
      {
        name: 'SITE',
        kind: 'reference',
        reference: 'https://${{project.PROJ_LITERAL}}/x',
      },
    ],
  })

  deploymentId = (await waitForActive(h, created.id)).current_deployment_id
  await waitForDeployment(h, deploymentId, 'active')
})

after(async () => {
  await h.close()
  registry.restore()
})

const decode = (value: string) => Buffer.from(value, 'base64url').toString('utf8')

describe('log redaction covers secret values and generated secrets only', () => {
  test('secrets.deliver carries the secret value, the generated secret and the entries that embed a secret value', () => {
    const body = secretsDeliver(h.deps.db, h.deps.keyring, deploymentId, 'deploy', actor)
    const redaction = body.redaction.map((r) => ({
      key: r.key,
      value: decode(r.value),
    }))
    const values = redaction.map((r) => r.value)
    const generated = decode(body.values.find((v) => v.key === 'SECRET_KEY')!.value)

    assert.ok(values.includes(secretValue))
    assert.ok(values.includes(generated))
    assert.ok(values.includes(projectSecret))
    assert.ok(values.includes(`postgres://u:${projectSecret}@db/app`))

    for (const literal of [literalValue, projectLiteral, `https://${projectLiteral}/x`]) {
      assert.ok(!values.includes(literal), `${literal} must not be redacted`)
    }

    assert.equal(decode(body.values.find((v) => v.key === 'BASE_URL')!.value), literalValue)
  })

  test('the serve-time redactor replaces a secret value and a generated secret in every encoded form and leaves literals', () => {
    const known = redactionKnown(h.deps.db, h.deps.keyring, deploymentId, actor, 'req_test')
    const generated = known.find((k) => k.key === 'SECRET_KEY')!.value
    const redact = buildRedactor(known)

    for (const [key, value] of [
      ['API_KEY', secretValue],
      ['SECRET_KEY', generated],
    ] as const) {
      for (const form of encodedForms(value)) {
        assert.equal(redact(`before ${form} after`), `before [redacted:${key}] after`)
      }
    }

    const line = `BASE_URL=${literalValue} SITE=https://${projectLiteral}/x`

    assert.equal(redact(line), line)
  })
})
