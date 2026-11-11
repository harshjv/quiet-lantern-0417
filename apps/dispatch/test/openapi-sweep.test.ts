import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { startDispatch, type Dispatch } from './helpers/dispatch.ts'
import { compileResponse } from './helpers/json-schema.ts'
import { FakeRegistry } from './helpers/registry.ts'
import { rows } from './helpers/seed.ts'
import { seedWorld, type World } from './helpers/world.ts'

type Operation = { path: string; schema: unknown }

const skipped: Record<string, string> = {
  '/v1/environments/{environment}/network/live':
    'server-sent events stream with no JSON response schema',
  '/v1/environments/{environment}/metrics':
    'server-sent events stream with no JSON response schema',
  '/v1/github/installations/{id}/repositories':
    'calls api.github.com through an installed GitHub App',
  '/v1/platform/releases': 'reads the release feed over the network',
}

const idQueries: Record<string, string> = {
  project: 'select id from project',
  environment: 'select id from environment',
  service: 'select id from service',
  station: 'select id from station',
  deployment: 'select id from deployment',
  domain: 'select id from domain',
  volume: 'select id from volume',
  build: 'select id from build',
  run: 'select id from run',
  'staged-change': 'select id from staged_change',
  variable: 'select id from variable',
  sandbox: 'select id from sandbox',
  'sandbox-snapshot': 'select id from sandbox_snapshot',
  'notification-channel': 'select id from notification_channel',
}

const segmentKinds: Record<string, string> = {
  projects: 'project',
  environments: 'environment',
  services: 'service',
  stations: 'station',
  deployments: 'deployment',
  domains: 'domain',
  volumes: 'volume',
  builds: 'build',
  runs: 'run',
  'staged-changes': 'staged-change',
  variables: 'variable',
  sandboxes: 'sandbox',
  'sandbox-snapshots': 'sandbox-snapshot',
  'notification-channels': 'notification-channel',
}

const requiredQuery: Record<string, string> = {
  '/v1/environments/{environment}/network/explain': 'from=web&to=db',
  '/v1/logs': 'service=SERVICE',
}

const fixedQuery: Record<string, string> = {
  '/v1/deployments/{id}/wait': 'timeout_s=0',
}

const documented = new Set([400, 404, 409, 422, 503])

const listOperations = async (h: Dispatch) => {
  const doc = (
    await h.call('GET', '/openapi/json', {
      token: h.admin.token,
    })
  ).body
  const operations: Operation[] = []

  for (const [path, methods] of Object.entries<any>(doc.paths)) {
    if (!path.startsWith('/v1') || !methods.get) {
      continue
    }

    const schema = methods.get.responses?.['200']?.content?.['application/json']?.schema

    operations.push({
      path,
      schema,
    })
  }

  return {
    operations,
    components: doc.components.schemas as Record<string, unknown>,
  }
}

const fill = (h: Dispatch, path: string) => {
  const names = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!)
  const segments = path.split('/')
  let combos: Record<string, string>[] = [{}]

  for (const name of names) {
    const kind = segmentKinds[segments[segments.indexOf(`{${name}}`) - 1] ?? ''] ?? name
    const ids =
      kind in idQueries
        ? rows<{ id: string }>(h, idQueries[kind]!)
            .map((r) => r.id)
            .slice(0, 8)
        : []

    combos = combos.flatMap((c) =>
      (ids.length ? ids : ['missing']).map((id) => ({
        ...c,
        [name]: id,
      })),
    )
  }

  return combos.map((c) => path.replace(/\{([^}]+)\}/g, (_, n) => c[n]!))
}

const sweep = (
  label: string,
  boot: () => Promise<{ h: Dispatch; world?: World; cleanup?: () => void }>,
) => {
  describe(label, () => {
    let h: Dispatch
    let operations: Operation[]
    let components: Record<string, unknown>
    let world: World | undefined
    let cleanup: (() => void) | undefined

    before(async () => {
      const booted = await boot()

      cleanup = booted.cleanup
      h = booted.h
      world = booted.world
      ;({ operations, components } = await listOperations(h))
    })

    after(async () => {
      await h.close()
      cleanup?.()
    })

    test('the OpenAPI document lists every GET route and each carries a 200 JSON schema unless skipped by name', () => {
      assert.ok(operations.length >= 40)

      for (const op of operations) {
        assert.ok(op.schema || skipped[op.path], `${op.path} has no 200 JSON response schema`)
      }
    })

    test('every GET route answers its declared schema or a documented 4xx, never a 500', async () => {
      let checked = 0

      for (const op of operations) {
        if (skipped[op.path] || !op.schema) {
          continue
        }

        const compiled = compileResponse(op.schema, components)

        for (const url of fill(h, op.path)) {
          const extra = (requiredQuery[op.path] ?? '').replace(
            'SERVICE',
            world?.services.web ?? 'missing',
          )
          const base = fixedQuery[op.path]
          const queries = base
            ? [`?${base}`, `?${base}&fields=*`]
            : ['', '?fields=*', extra ? `?${extra}` : null]

          for (const query of queries) {
            if (query === null) {
              continue
            }

            const reply = await h.call('GET', `${url}${query}`, {
              token: h.admin.token,
            })
            const where = `${url}${query}`

            assert.notEqual(reply.status, 500, `${where} answered 500: ${reply.text}`)
            assert.notEqual(reply.body?.error?.code, 'INTERNAL_ERROR', where)

            if (reply.status === 200) {
              assert.ok(
                compiled.check(reply.body),
                `${where} does not match its declared schema: ${compiled.errors(reply.body).join('; ')}`,
              )
            } else {
              assert.ok(
                documented.has(reply.status),
                `${where} answered ${reply.status}: ${reply.text}`,
              )
              assert.ok(
                reply.body?.error?.code && reply.body.error.request_id,
                `${where} answered without an error envelope`,
              )
            }

            checked += 1
          }
        }
      }

      assert.ok(checked > 60)
    })
  })
}

sweep('a fresh database', async () => ({
  h: await startDispatch(),
}))

let registry: FakeRegistry

sweep(
  'a seeded database with projects, environments, services, domains, volumes, variables and staged changes',
  async () => {
    registry = FakeRegistry.install()
    const h = await startDispatch()
    const world = await seedWorld(h, registry)

    assert.ok(world.staged, 'the protected environment staged the agent change')

    return {
      h,
      world,
      cleanup: () => registry.restore(),
    }
  },
)
