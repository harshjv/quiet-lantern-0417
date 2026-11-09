import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { mintToken, startDispatch, startFakeStation, type Dispatch } from './helpers/dispatch.ts'
import { FakeRegistry } from './helpers/registry.ts'
import { createProject, createService } from './helpers/seed.ts'

let h: Dispatch
let registry: FakeRegistry
let project: any
let service: any
let readToken: string
let deployToken: string
let adminToken: string
let projectAdminToken: string

const headers = { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }

const rpc = async (token: string | null, method: string, params?: unknown, id = 1) => {
  const reply = await h.call('POST', '/mcp', { token, headers, body: { jsonrpc: '2.0', id, method, params } })
  const data = /^data: (.*)$/m.exec(reply.text)?.[1]
  return { status: reply.status, headers: reply.headers, message: data ? JSON.parse(data) : reply.body }
}

const toolNames = async (token: string) => ((await rpc(token, 'tools/list')).message.result.tools as { name: string }[]).map(t => t.name)

const callTool = async (token: string, name: string, args: Record<string, unknown> = {}) => (await rpc(token, 'tools/call', { name, arguments: args })).message.result

const textOf = (result: any) => JSON.parse(result.content[0].text)

before(async () => {
  registry = FakeRegistry.install()
  registry.publish('nginx:1.27')
  h = await startDispatch()
  await startFakeStation(h)
  project = await createProject(h, 'alpha')
  service = await createService(h, project.default_environment_id, { name: 'web', ref: 'nginx:1.27', ports: [{ port: 80 }] })
  const all = { project_id: '*', environment_id: '*' }
  readToken = await mintToken(h, [{ ...all, level: 'read' }], 'mcp-read')
  deployToken = await mintToken(h, [{ ...all, level: 'deploy' }], 'mcp-deploy')
  adminToken = await mintToken(h, [{ ...all, level: 'admin' }], 'mcp-admin')
  projectAdminToken = await mintToken(h, [{ project_id: project.id, environment_id: '*', level: 'admin' }], 'mcp-project-admin')
})

after(async () => {
  registry.restore()
  await h.close()
})

describe('mcp transport', () => {
  test('initialize answers server info and instructions', async () => {
    const { status, message } = await rpc(readToken, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    assert.equal(status, 200)
    assert.equal(message.result.serverInfo.name, 'stationly')
    assert.equal(typeof message.result.instructions, 'string')
    assert.ok(message.result.capabilities.tools)
  })

  test('a request without a bearer is a 401 with a resource metadata challenge', async () => {
    const { status, headers: h2 } = await rpc(null, 'tools/list')
    assert.equal(status, 401)
    assert.match(h2.get('www-authenticate') ?? '', /resource_metadata=/)
  })

  test('a sly or dashboard session is never accepted on /mcp', async () => {
    const reply = await h.call('POST', '/mcp', { cookie: h.admin.cookie, headers, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })
    assert.equal(reply.status, 401)
  })

  test('an unknown host is WRONG_HOST', async () => {
    const reply = await h.fetch(new Request('http://unknown.example/mcp', { method: 'POST', headers: { ...headers, 'content-type': 'application/json', authorization: `Bearer ${readToken}` }, body: '{}' }))
    assert.equal(reply.status, 404)
    assert.equal(((await reply.json()) as any).error.code, 'WRONG_HOST')
  })
})

describe('tools per access level', () => {
  test('read sees only read tools', async () => {
    const names = await toolNames(readToken)
    assert.ok(names.includes('whoami') && names.includes('list_projects') && names.includes('describe_service'))
    for (const hidden of ['create_service', 'deploy', 'restart_service', 'create_project', 'create_token']) assert.ok(!names.includes(hidden), hidden)
  })

  test('deploy adds deploy tools but not admin tools', async () => {
    const names = await toolNames(deployToken)
    assert.ok(names.includes('restart_service') && names.includes('deploy'))
    for (const hidden of ['create_service', 'create_project', 'delete_service', 'create_token']) assert.ok(!names.includes(hidden), hidden)
  })

  test('admin sees admin tools and each level is a strict superset of the one below', async () => {
    const read = await toolNames(readToken)
    const deploy = await toolNames(deployToken)
    const admin = await toolNames(adminToken)
    assert.ok(admin.includes('create_service') && admin.includes('create_project') && admin.includes('create_token'))
    assert.ok(read.every(n => deploy.includes(n)) && deploy.length > read.length)
    assert.ok(deploy.every(n => admin.includes(n)) && admin.length > deploy.length)
  })

  test('instance tools need admin on every project', async () => {
    const instance = await toolNames(adminToken)
    const scoped = await toolNames(projectAdminToken)
    assert.ok(instance.includes('grant_variable'))
    assert.ok(!scoped.includes('grant_variable'))
    assert.ok(scoped.includes('create_service'))
  })
})

describe('tool calls', () => {
  test('whoami matches /v1/me', async () => {
    const via = textOf(await callTool(readToken, 'whoami'))
    const rest = await h.call('GET', '/v1/me', { token: readToken })
    assert.deepEqual(via, rest.body)
  })

  test('list_projects returns the same data as REST', async () => {
    const result = await callTool(readToken, 'list_projects')
    const rest = await h.call('GET', '/v1/projects', { token: readToken })
    assert.equal(result.isError, undefined)
    assert.deepEqual(result.structuredContent, rest.body)
    assert.equal(result.structuredContent.items[0].name, 'alpha')
  })

  test('describe_service by id matches REST with the default fields', async () => {
    const result = await callTool(readToken, 'describe_service', { service: service.id })
    const rest = await h.call('GET', `/v1/services/${service.id}?fields=ports,volumes,domains,port_allocations,current_deployment,variables`, { token: readToken })
    assert.deepEqual(result.structuredContent, rest.body)
  })

  test('describe_service by project/environment/service names resolves the same service', async () => {
    const result = await callTool(readToken, 'describe_service', { service: 'alpha/production/web' })
    assert.equal(result.structuredContent.id, service.id)
  })

  test('a deploy-level write goes through', async () => {
    const result = await callTool(deployToken, 'stop_service', { service: service.id })
    assert.equal(result.isError, undefined)
    assert.equal(result.structuredContent.desired_state, 'stopped')
    const rest = await h.call('GET', `/v1/services/${service.id}?fields=desired_state`, { token: h.admin.token })
    assert.equal(rest.body.desired_state, 'stopped')
  })

  test('a repeated idempotency_key creates one project', async () => {
    const first = await callTool(adminToken, 'create_project', { name: 'once', idempotency_key: 'mcp-key-1' })
    const second = await callTool(adminToken, 'create_project', { name: 'once', idempotency_key: 'mcp-key-1' })
    assert.equal(first.isError, undefined)
    assert.equal(second.isError, undefined)
    assert.equal(second.structuredContent.id, first.structuredContent.id)
    const projects = await h.call('GET', '/v1/projects?name=once', { token: h.admin.token })
    assert.equal(projects.body.items.length, 1)
  })

  test('a hidden tool cannot be called', async () => {
    const reply = await rpc(readToken, 'tools/call', { name: 'create_project', arguments: { name: 'nope' } })
    const refused = reply.message.error ?? reply.message.result
    assert.ok(reply.message.error || refused.isError)
    const projects = await h.call('GET', '/v1/projects', { token: h.admin.token })
    assert.ok(!projects.body.items.some((p: any) => p.name === 'nope'))
  })

  test('an API refusal comes back as an error result carrying the envelope', async () => {
    const result = await callTool(readToken, 'describe_service', { service: 'svc_01ARZ3NDEKTSV4RRFFQ69G5FAV' })
    assert.equal(result.isError, true)
    assert.equal(textOf(result).error.code, 'NOT_FOUND')
  })

  test('a scoped token cannot reach a project outside its scope through a visible tool', async () => {
    const other = await createProject(h, 'beta')
    const result = await callTool(projectAdminToken, 'create_service', {
      project: 'beta',
      environment: 'production',
      name: 'sneak',
      kind: 'worker',
      source: { type: 'image', ref: 'nginx:1.27' },
      deploy_on_create: false
    })
    assert.equal(result.isError, true)
    const envelope = textOf(result).error
    assert.ok(['FORBIDDEN_SCOPE', 'NOT_FOUND'].includes(envelope.code))
    const services = await h.call('GET', `/v1/environments/${other.default_environment_id}/services`, { token: h.admin.token })
    assert.deepEqual(services.body.items, [])
  })
})

describe('update_station', () => {
  test('takes every field PATCH /v1/stations accepts and returns the station', async () => {
    const tool = ((await rpc(adminToken, 'tools/list')).message.result.tools as { name: string; inputSchema: { properties: Record<string, unknown> } }[]).find(t => t.name === 'update_station')!
    for (const field of ['station', 'public_address', 'concurrency_cap', 'draining', 'intermittent']) assert.ok(field in tool.inputSchema.properties, field)
    assert.ok(!('sleep_schedule' in tool.inputSchema.properties))
    const result = await callTool(adminToken, 'update_station', { station: 'station-1', concurrency_cap: 4, intermittent: true, public_address: '203.0.113.7' })
    assert.equal(result.isError, undefined, JSON.stringify(result))
    assert.equal(result.structuredContent.concurrency_cap, 4)
    assert.equal(result.structuredContent.intermittent, true)
    assert.equal(result.structuredContent.public_address, '203.0.113.7')
    const rest = await h.call('GET', '/v1/stations/station-1?fields=*', { token: adminToken })
    assert.deepEqual([rest.body.concurrency_cap, rest.body.intermittent, rest.body.public_address], [4, true, '203.0.113.7'])
  })

  test('draining flows through and an empty call is a validation error', async () => {
    const drained = await callTool(adminToken, 'update_station', { station: 'station-1', draining: true })
    assert.deepEqual([drained.structuredContent.status, drained.structuredContent.draining], ['online', true])
    const ended = await callTool(adminToken, 'update_station', { station: 'station-1', draining: false })
    assert.deepEqual([ended.structuredContent.status, ended.structuredContent.draining], ['online', false])
    const empty = await callTool(adminToken, 'update_station', { station: 'station-1' })
    assert.equal(empty.isError, true)
    assert.equal(textOf(empty).error.code, 'VALIDATION_FAILED')
  })
})
