import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { mintToken, startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import { FakeRegistry } from './helpers/registry.ts'
import {
  createProject,
  createService,
  seedLockfile,
  waitForActive,
  waitForDeployment,
} from './helpers/seed.ts'

let h: Dispatch
let registry: FakeRegistry
let project: any
let service: any
let readToken: string
let deployToken: string
let adminToken: string
let projectAdminToken: string

const headers = {
  accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-06-18',
}

const methods = ['get', 'put', 'post', 'patch', 'delete']

const rpcAll = async (token: string | null, method: string, params?: unknown, id = 1) => {
  const reply = await h.call('POST', '/mcp', {
    token,
    headers,
    body: {
      jsonrpc: '2.0',
      id,
      method,
      params,
    },
  })
  const data = [...reply.text.matchAll(/^data: (.*)$/gm)].map((match) => JSON.parse(match[1]!))
  return {
    status: reply.status,
    headers: reply.headers,
    messages: data.length ? data : [reply.body],
  }
}

const rpc = async (token: string | null, method: string, params?: unknown, id = 1) => {
  const { status, headers: replied, messages } = await rpcAll(token, method, params, id)
  return {
    status,
    headers: replied,
    message: messages.at(-1),
  }
}

const toolsOf = async (token: string) =>
  (await rpc(token, 'tools/list')).message.result.tools as {
    name: string
    annotations: any
    inputSchema: any
    outputSchema?: any
    _meta?: any
  }[]

const toolNames = async (token: string) => (await toolsOf(token)).map((t) => t.name)

const callTool = async (token: string, name: string, args: Record<string, unknown> = {}) =>
  (
    await rpc(token, 'tools/call', {
      name,
      arguments: args,
    })
  ).message.result

const textOf = (result: any) => JSON.parse(result.content[0].text)

const operations = async () => {
  const doc = (await h.call('GET', '/openapi/json')).body
  return Object.entries<Record<string, any>>(doc.paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method, op]) => methods.includes(method) && op['x-stationly'])
      .map(([method, op]) => ({
        method: method.toUpperCase(),
        path,
        id: op.operationId as string,
        level: op['x-stationly'].level as string,
        mcp: op['x-stationly'].mcp,
      })),
  )
}

before(async () => {
  registry = FakeRegistry.install()
  registry.publish('nginx:1.27')
  h = await startDispatch()
  seedLockfile(h)
  await startFakeStation(h)
  project = await createProject(h, 'alpha')
  service = await createService(h, project.default_environment_id, {
    name: 'web',
    ref: 'nginx:1.27',
    ports: [
      {
        port: 80,
      },
    ],
    deploy: true,
  })
  await waitForDeployment(h, service.deployments[0].id, 'active')
  const all = {
    project_id: '*',
    environment_id: '*',
  }
  readToken = await mintToken(
    h,
    [
      {
        ...all,
        level: 'read',
      },
    ],
    'mcp-read',
  )
  deployToken = await mintToken(
    h,
    [
      {
        ...all,
        level: 'deploy',
      },
    ],
    'mcp-deploy',
  )
  adminToken = await mintToken(
    h,
    [
      {
        ...all,
        level: 'admin',
      },
    ],
    'mcp-admin',
  )
  projectAdminToken = await mintToken(
    h,
    [
      {
        project_id: project.id,
        environment_id: '*',
        level: 'admin',
      },
    ],
    'mcp-project-admin',
  )
})

after(async () => {
  registry.restore()
  await h.close()
})

describe('mcp transport', () => {
  test('initialize answers server info and instructions', async () => {
    const { status, message } = await rpc(readToken, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: {
        name: 'test',
        version: '1',
      },
    })
    assert.equal(status, 200)
    assert.equal(message.result.serverInfo.name, 'stationly')
    assert.match(message.result.instructions, /wait_for_run/)
    assert.ok(message.result.capabilities.tools)
  })

  test('a request without a bearer is a 401 with a resource metadata challenge', async () => {
    const { status, headers: h2 } = await rpc(null, 'tools/list')
    assert.equal(status, 401)
    assert.match(h2.get('www-authenticate') ?? '', /resource_metadata=/)
  })

  test('a sly or dashboard session is never accepted on /mcp', async () => {
    const reply = await h.call('POST', '/mcp', {
      cookie: h.admin.cookie,
      headers,
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
      },
    })
    assert.equal(reply.status, 401)
  })

  test('an unknown host is WRONG_HOST', async () => {
    const reply = await h.fetch(
      new Request('http://unknown.example/mcp', {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': 'application/json',
          authorization: `Bearer ${readToken}`,
        },
        body: '{}',
      }),
    )
    assert.equal(reply.status, 404)
    assert.equal(((await reply.json()) as any).error.code, 'WRONG_HOST')
  })
})

describe('generated catalog', () => {
  test('an instance admin sees one tool per operation not marked mcp false, in OpenAPI order', async () => {
    const expected = (await operations())
      .filter((op) => op.mcp !== false && !op.mcp?.hide)
      .map((op) => op.id)
    assert.deepEqual(await toolNames(adminToken), expected)
  })

  test('the tools visible to an instance admin stay within the 128 a client enables', async () => {
    const names = await toolNames(adminToken)
    assert.ok(names.length <= 128, `an instance admin sees ${names.length} tools`)
  })

  test('annotations, idempotency_key, always_load and the output schema come from the route', async () => {
    const byName = new Map((await toolsOf(adminToken)).map((t) => [t.name, t]))
    for (const op of (await operations()).filter((o) => o.mcp !== false)) {
      const tool = byName.get(op.id)!
      assert.equal(tool.annotations.openWorldHint, false, op.id)
      assert.equal(tool.annotations.readOnlyHint, op.method === 'GET', op.id)
      assert.equal('idempotency_key' in tool.inputSchema.properties, op.method !== 'GET', op.id)
      if (op.method !== 'GET')
        assert.equal(
          tool.annotations.destructiveHint,
          op.method === 'DELETE' || op.mcp?.destructive === true,
          op.id,
        )
      assert.equal(
        tool._meta?.['anthropic/alwaysLoad'] === true,
        op.mcp?.always_load === true,
        op.id,
      )
      assert.ok(tool.outputSchema, op.id)
    }
    for (const name of [
      'whoami',
      'describe_environment',
      'deploy',
      'wait_for_deployment',
      'get_deployment_diagnosis',
    ])
      assert.equal(byName.get(name)!._meta?.['anthropic/alwaysLoad'], true, name)
  })

  test('a polled tool takes timeout_s in place of the per-call wait', async () => {
    const byName = new Map((await toolsOf(readToken)).map((t) => [t.name, t]))
    for (const name of ['wait_for_deployment', 'wait_for_run']) {
      const input = byName.get(name)!.inputSchema
      assert.deepEqual(
        [input.properties.timeout_s.default, input.properties.timeout_s.maximum],
        [600, 3600],
        name,
      )
      assert.ok(!('wait_s' in input.properties), name)
    }
  })

  test('a body schema reached through $ref is kept with its components under $defs', async () => {
    const tool = (await toolsOf(adminToken)).find((t) => t.name === 'describe_service')!
    assert.match(JSON.stringify(tool.outputSchema), /"\$ref":"#\/\$defs\/Service"/)
    assert.ok(tool.outputSchema.$defs.Service)
    assert.ok(!JSON.stringify(tool.outputSchema).includes('#/components/'))
  })
})

describe('tools per access level', () => {
  test('read sees only read tools', async () => {
    const names = await toolNames(readToken)
    assert.ok(
      names.includes('whoami') &&
        names.includes('list_projects') &&
        names.includes('describe_service'),
    )
    for (const hidden of [
      'create_service',
      'deploy',
      'restart_service',
      'create_project',
      'list_stations',
    ])
      assert.ok(!names.includes(hidden), hidden)
  })

  test('deploy adds deploy tools but not admin tools', async () => {
    const names = await toolNames(deployToken)
    assert.ok(names.includes('restart_service') && names.includes('deploy'))
    for (const hidden of [
      'create_service',
      'create_project',
      'delete_service',
      'set_project_variables',
    ])
      assert.ok(!names.includes(hidden), hidden)
  })

  test('admin sees admin tools and each level is a strict superset of the one below', async () => {
    const read = await toolNames(readToken)
    const deploy = await toolNames(deployToken)
    const admin = await toolNames(adminToken)
    assert.ok(
      admin.includes('create_service') &&
        admin.includes('create_project') &&
        admin.includes('create_token'),
    )
    assert.ok(read.every((n) => deploy.includes(n)) && deploy.length > read.length)
    assert.ok(deploy.every((n) => admin.includes(n)) && admin.length > deploy.length)
  })

  test('instance tools need admin on every project', async () => {
    const instance = await toolNames(adminToken)
    const scoped = await toolNames(projectAdminToken)
    assert.ok(instance.includes('grant_variable') && instance.includes('list_stations'))
    assert.ok(!scoped.includes('grant_variable') && !scoped.includes('list_stations'))
    assert.ok(scoped.includes('create_service'))
  })
})

describe('tool calls', () => {
  test('whoami matches /v1/me', async () => {
    const via = textOf(await callTool(readToken, 'whoami'))
    const rest = await h.call('GET', '/v1/me', {
      token: readToken,
    })
    assert.deepEqual(via, rest.body)
  })

  test('list_projects returns the same data as REST', async () => {
    const result = await callTool(readToken, 'list_projects')
    const rest = await h.call('GET', '/v1/projects', {
      token: readToken,
    })
    assert.equal(result.isError, undefined)
    assert.deepEqual(result.structuredContent, rest.body)
    assert.equal(result.structuredContent.items[0].name, 'alpha')
  })

  test('describe_service by id matches REST, with and without fields', async () => {
    const plain = await callTool(readToken, 'describe_service', {
      service: service.id,
    })
    assert.deepEqual(
      plain.structuredContent,
      (
        await h.call('GET', `/v1/services/${service.id}`, {
          token: readToken,
        })
      ).body,
    )
    const fields = 'ports,volumes,domains,port_allocations,current_deployment,variables'
    const full = await callTool(readToken, 'describe_service', {
      service: service.id,
      fields,
    })
    assert.deepEqual(
      full.structuredContent,
      (
        await h.call('GET', `/v1/services/${service.id}?fields=${fields}`, {
          token: readToken,
        })
      ).body,
    )
  })

  test('an entity parameter takes a slug path, which the API resolves through the nested path', async () => {
    const svc = await callTool(readToken, 'describe_service', {
      service: 'alpha/production/web',
    })
    assert.equal(svc.structuredContent.id, service.id)
    const env = await callTool(readToken, 'list_services', {
      environment: 'alpha/production',
    })
    assert.deepEqual(
      env.structuredContent.items.map((s: any) => s.id),
      [service.id],
    )
    const missing = await callTool(readToken, 'describe_service', {
      service: 'alpha/production/nope',
    })
    assert.equal(textOf(missing).error.code, 'NOT_FOUND')
  })

  test('a deploy-level write goes through', async () => {
    const result = await callTool(deployToken, 'stop_service', {
      service: service.id,
    })
    assert.equal(result.isError, undefined, JSON.stringify(result))
    assert.equal(result.structuredContent.desired_state, 'stopped')
    const rest = await h.call('GET', `/v1/services/${service.id}?fields=desired_state`, {
      token: h.admin.token,
    })
    assert.equal(rest.body.desired_state, 'stopped')
    const started = await callTool(deployToken, 'start_service', {
      service: service.id,
    })
    assert.equal(started.isError, undefined, JSON.stringify(started))
  })

  test('a repeated idempotency_key creates one project', async () => {
    const first = await callTool(adminToken, 'create_project', {
      name: 'once',
      idempotency_key: 'mcp-key-1',
    })
    const second = await callTool(adminToken, 'create_project', {
      name: 'once',
      idempotency_key: 'mcp-key-1',
    })
    assert.equal(first.isError, undefined, JSON.stringify(first))
    assert.equal(second.isError, undefined)
    assert.equal(second.structuredContent.id, first.structuredContent.id)
    const projects = await h.call('GET', '/v1/projects?name=once', {
      token: h.admin.token,
    })
    assert.equal(projects.body.items.length, 1)
  })

  test('a hidden tool cannot be called', async () => {
    const reply = await rpc(readToken, 'tools/call', {
      name: 'create_project',
      arguments: {
        name: 'nope',
      },
    })
    const refused = reply.message.error ?? reply.message.result
    assert.ok(reply.message.error || refused.isError)
    const projects = await h.call('GET', '/v1/projects', {
      token: h.admin.token,
    })
    assert.ok(!projects.body.items.some((p: any) => p.name === 'nope'))
  })

  test('an API refusal comes back as an error result carrying the envelope', async () => {
    const result = await callTool(readToken, 'describe_service', {
      service: 'svc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    })
    assert.equal(result.isError, true)
    assert.equal(textOf(result).error.code, 'NOT_FOUND')
  })

  test('a scoped token cannot reach a project outside its scope through a visible tool', async () => {
    const other = await createProject(h, 'beta')
    const result = await callTool(projectAdminToken, 'create_service', {
      environment: 'beta/production',
      name: 'sneak',
      kind: 'worker',
      source: {
        type: 'image',
        ref: 'nginx:1.27',
      },
      deploy_on_create: false,
    })
    assert.equal(result.isError, true)
    const envelope = textOf(result).error
    assert.ok(['FORBIDDEN_SCOPE', 'NOT_FOUND'].includes(envelope.code))
    const services = await h.call(
      'GET',
      `/v1/environments/${other.default_environment_id}/services`,
      {
        token: h.admin.token,
      },
    )
    assert.deepEqual(services.body.items, [])
  })

  test('get_logs returns its lines inside untrusted, as REST does', async () => {
    const result = await callTool(readToken, 'get_logs', {
      service: service.id,
    })
    assert.equal(result.isError, undefined, JSON.stringify(result))
    assert.equal(result.structuredContent.untrusted.source, 'runtime log')
    assert.ok(Array.isArray(result.structuredContent.untrusted.lines))
  })
})

describe('polled tools', () => {
  test('wait_for_deployment repeats the wait until done and sends a first and a last progress notification', async () => {
    const created = await callTool(deployToken, 'deploy', {
      service: service.id,
      idempotency_key: 'mcp-poll-1',
    })
    assert.equal(created.isError, undefined, JSON.stringify(created))
    const id = created.structuredContent.id
    const { messages } = await rpcAll(readToken, 'tools/call', {
      name: 'wait_for_deployment',
      arguments: {
        id,
        timeout_s: 30,
      },
      _meta: {
        progressToken: 'p1',
      },
    })
    const progress = messages
      .filter((m) => m.method === 'notifications/progress')
      .map((m) => m.params)
    const result = messages.at(-1).result
    assert.equal(result.isError, undefined, JSON.stringify(result))
    assert.equal(result.structuredContent.done, true)
    assert.equal(result.structuredContent.id, id)
    assert.ok(progress.length >= 2, JSON.stringify(progress))
    assert.ok(progress.every((p) => p.progressToken === 'p1'))
    assert.match(progress[0].message, /waiting up to 30 s/)
    assert.match(progress.at(-1).message, /done/)
    await waitForActive(h, service.id)
  })

  test('timeout_s 0 makes one call and returns done as the route reports it', async () => {
    const latest = (
      await h.call('GET', `/v1/services/${service.id}/deployments?limit=1`, {
        token: readToken,
      })
    ).body.items[0]
    const result = await callTool(readToken, 'wait_for_deployment', {
      id: latest.id,
      timeout_s: 0,
    })
    assert.equal(result.structuredContent.id, latest.id)
    assert.equal(typeof result.structuredContent.done, 'boolean')
  })

  test('run_command returns the run and wait_for_run follows it to done', async () => {
    const created = await callTool(deployToken, 'run_command', {
      service: service.id,
      command: ['true'],
      wait_s: 0,
    })
    assert.equal(created.isError, undefined, JSON.stringify(created))
    const waited = await callTool(readToken, 'wait_for_run', {
      id: created.structuredContent.id,
      timeout_s: 20,
    })
    assert.equal(waited.isError, undefined, JSON.stringify(waited))
    assert.equal(waited.structuredContent.id, created.structuredContent.id)
    assert.equal(
      waited.structuredContent.done,
      ['succeeded', 'failed', 'skipped', 'cancelled'].includes(waited.structuredContent.status),
    )
  })
})

describe('update_station', () => {
  test('takes every field PATCH /v1/stations accepts and returns the station', async () => {
    const tool = (await toolsOf(adminToken)).find((t) => t.name === 'update_station')!
    for (const field of [
      'station',
      'public_address',
      'concurrency_cap',
      'draining',
      'intermittent',
    ])
      assert.ok(field in tool.inputSchema.properties, field)
    const result = await callTool(adminToken, 'update_station', {
      station: 'station-1',
      concurrency_cap: 4,
      intermittent: true,
      public_address: '203.0.113.7',
    })
    assert.equal(result.isError, undefined, JSON.stringify(result))
    assert.equal(result.structuredContent.concurrency_cap, 4)
    assert.equal(result.structuredContent.intermittent, true)
    assert.equal(result.structuredContent.public_address, '203.0.113.7')
    const rest = await h.call('GET', '/v1/stations/station-1?fields=*', {
      token: adminToken,
    })
    assert.deepEqual(
      [rest.body.concurrency_cap, rest.body.intermittent, rest.body.public_address],
      [4, true, '203.0.113.7'],
    )
  })

  test('draining flows through and an empty call is a validation error', async () => {
    const drained = await callTool(adminToken, 'update_station', {
      station: 'station-1',
      draining: true,
    })
    assert.deepEqual(
      [drained.structuredContent.status, drained.structuredContent.draining],
      ['online', true],
    )
    const ended = await callTool(adminToken, 'update_station', {
      station: 'station-1',
      draining: false,
    })
    assert.deepEqual(
      [ended.structuredContent.status, ended.structuredContent.draining],
      ['online', false],
    )
    const empty = await callTool(adminToken, 'update_station', {
      station: 'station-1',
    })
    assert.equal(empty.isError, true)
    assert.equal(textOf(empty).error.code, 'VALIDATION_FAILED')
  })
})
