import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import type { CommandUnknownOpts } from '@commander-js/extra-typings'

import { clients } from '../../../packages/cli/src/commands/mcp.ts'
import { buildProgram } from '../../../packages/cli/src/program.ts'
import { startDispatch, type Dispatch } from '../../dispatch/test/helpers/dispatch.ts'
import { agentHints } from '../src/lib/agent-hints.ts'
import { commands, placeholders, tools } from '../src/lib/commands.ts'
import { mcpClients } from '../src/lib/labels.ts'

const scope = {
  project: 'shop',
  environment: 'production',
}

const service = {
  ...scope,
  service: 'web',
}

const built: Record<keyof typeof commands, string[]> = {
  login: [commands.login(), commands.login('https://api.example.com')],
  mcpInstall: [
    commands.mcpInstall({
      client: 'claude-code',
      project: 'shop',
      environment: null,
      level: 'deploy',
      ttl: '30d',
    }),
    commands.mcpInstall({
      client: 'cursor',
      project: '*',
      environment: null,
      level: 'read',
      ttl: '7d',
    }),
    commands.mcpInstall({
      client: 'generic',
      project: 'shop',
      environment: 'production',
      level: 'admin',
      ttl: '1d',
    }),
  ],
  createToken: [
    commands.createToken(
      {
        project: 'prj_01',
        environment: '*',
        level: 'deploy',
      },
      '30d',
    ),
  ],
  listServices: [commands.listServices(scope)],
  createProject: [commands.createProject()],
  createEnvironment: [commands.createEnvironment('shop')],
  createService: [commands.createService(scope)],
  deploy: [commands.deploy(service)],
  startService: [commands.startService(service)],
  rollback: [commands.rollback(service, 'dep_01')],
  setMemory: [commands.setMemory(service, 1073741824)],
  logs: [commands.logs(service, 'dep_01', null), commands.logs(service, 'dep_01', 'bld_01')],
  probe: [commands.probe(service, 'db.internal', 5432), commands.probe(service, 'db', null)],
  setServiceVariable: [commands.setServiceVariable(service)],
  setProjectVariable: [commands.setProjectVariable(scope)],
  addDomain: [commands.addDomain('spt_01'), commands.addDomain(null)],
  exposeTcp: [commands.exposeTcp('spt_01'), commands.exposeTcp(null)],
  setPublicAddress: [commands.setPublicAddress('home')],
  startSandbox: [commands.startSandbox(scope, 'web-sbx')],
  createSandbox: [commands.createSandbox(scope)],
  snapshotSandbox: [commands.snapshotSandbox(scope, 'web-sbx')],
  setSandboxVariable: [commands.setSandboxVariable('sbx_01')],
  forward: [commands.forward('sbx_01', 3000)],
}

const samples: Record<string, string> = {
  ipv4: '203.0.113.5',
  port: '5432',
}

const argv = (command: string) =>
  command
    .replace(/<([^<>]+)>/g, (_, name: string) => samples[name] ?? 'sample')
    .split(' ')
    .slice(1)

const takesValue = (option: CommandUnknownOpts['options'][number]) =>
  option.required || option.optional

const problems = (program: CommandUnknownOpts, args: string[]) => {
  const found: string[] = []
  const seen = new Set<string>()
  const operands: string[] = []
  let command = program
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('-')) {
      const name = arg.split('=')[0]
      const option = [command, program]
        .flatMap((c) => c.options)
        .find((o) => o.long === name || o.short === name)
      if (!option) {
        found.push(`${command.name()} has no option ${name}`)
        continue
      }
      seen.add(option.attributeName())
      if (takesValue(option) && !arg.includes('=')) i += 1
      continue
    }
    const sub = operands.length
      ? undefined
      : command.commands.find((c) => c.name() === arg || c.aliases().includes(arg))
    if (sub) command = sub
    else operands.push(arg)
  }
  if (command.commands.length > 0) found.push(`${command.name()} needs a subcommand`)
  const params = command.registeredArguments
  const required = params.filter((a) => a.required).length
  if (operands.length < required) found.push(`${command.name()} needs ${required} arguments`)
  if (!params.some((a) => a.variadic) && operands.length > params.length)
    found.push(`${command.name()} takes ${params.length} arguments, got ${operands.length}`)
  for (const option of command.options)
    if (option.mandatory && !seen.has(option.attributeName()))
      found.push(`${command.name()} needs ${option.long}`)
  return found
}

test('every command builder is covered by this test', () => {
  assert.deepEqual(Object.keys(built).sort(), Object.keys(commands).sort())
})

test('every command the dashboard shows parses with the sly program', () => {
  const program = buildProgram() as unknown as CommandUnknownOpts
  for (const list of Object.values(built))
    for (const command of list) {
      assert.ok(command.startsWith('sly '), command)
      assert.deepEqual(problems(program, argv(command)), [], command)
    }
})

test('the agent page offers exactly the clients sly mcp install accepts', () => {
  assert.deepEqual([...mcpClients].sort(), [...clients].sort())
})

test('the install command leaves out the defaults and fills the rest', () => {
  assert.equal(
    commands.mcpInstall({
      client: 'claude-code',
      project: 'shop',
      environment: null,
      level: 'deploy',
      ttl: '30d',
    }),
    'sly mcp install claude-code --project shop',
  )
  assert.equal(
    commands.mcpInstall({
      client: 'codex',
      project: '*',
      environment: 'production',
      level: 'read',
      ttl: '7d',
    }),
    "sly mcp install codex --project '*' --environment production --level read --ttl 7d",
  )
})

test('placeholders are the angle-bracket segments', () => {
  assert.deepEqual(placeholders(commands.setPublicAddress('home')), ['ipv4'])
  assert.deepEqual(placeholders(commands.deploy(service)), [])
})

let h: Dispatch

before(async () => {
  h = await startDispatch()
})

after(async () => {
  await h.close()
})

test('every agent tool the dashboard names is an OpenAPI operationId', async () => {
  const reply = await h.call('GET', '/openapi/json', {
    token: h.admin.token,
  })
  const doc = reply.body as { paths: Record<string, Record<string, { operationId?: string }>> }
  const ids = new Set(
    Object.values(doc.paths).flatMap((item) =>
      Object.values(item).flatMap((operation) =>
        operation.operationId ? [operation.operationId] : [],
      ),
    ),
  )
  const hinted = Object.values(agentHints).flatMap((hint) => hint.tools)
  assert.deepEqual(
    [...tools, ...hinted].filter((tool) => !ids.has(tool)),
    [],
  )
})
