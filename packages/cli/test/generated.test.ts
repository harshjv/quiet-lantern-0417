import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { CommandUnknownOpts } from '@commander-js/extra-typings'

import { endpoints } from '@stationly/mcp'

import { docsSkip, readDoc } from '../../../apps/dispatch/test/helpers/docs.ts'
import {
  derivedPath,
  generatedCommands,
  registerGenerated,
  renderOf,
  summaryColumns,
} from '../src/generated.ts'
import { openApiDocument } from '../src/openapi.gen.ts'
import { buildProgram, handWrittenProgram } from '../src/program.ts'
import { renderer, rendererNames } from '../src/renderers/index.ts'

const handWrittenOverlaps = [
  'add_domain',
  'add_notification',
  'adopt_volume',
  'apply_manifest',
  'backup_volume',
  'cancel_deployment',
  'cancel_run',
  'create_environment',
  'create_project',
  'create_service',
  'create_token',
  'delete_environment',
  'delete_project',
  'delete_service',
  'deploy',
  'describe_service',
  'explain_network',
  'export_manifest',
  'get_audit_events',
  'get_events',
  'get_logs',
  'get_metrics',
  'get_settings',
  'grant_variable',
  'list_deployments',
  'list_domains',
  'list_environments',
  'list_notifications',
  'list_projects',
  'list_runs',
  'list_services',
  'list_stations',
  'list_tokens',
  'list_volumes',
  'platform_check',
  'platform_doctor',
  'platform_inventory',
  'platform_upgrade',
  'probe_network',
  'redeploy',
  'remove_domain',
  'remove_notification',
  'remove_station',
  'renew_token',
  'restart_service',
  'restore_volume',
  'revoke_token',
  'rollback',
  'start_service',
  'stop_service',
  'stream_metrics',
  'test_notification',
  'update_environment',
  'update_project',
  'update_service',
  'update_station',
  'validate_manifest',
  'whoami',
]

const find = (program: CommandUnknownOpts, path: string[]) =>
  path.reduce<CommandUnknownOpts | undefined>(
    (command, word) => command?.commands.find((c) => c.name() === word),
    program,
  )

test('command paths derive from the tag and the operationId', () => {
  assert.deepEqual(derivedPath('list_services', 'services'), ['services', 'list'])
  assert.deepEqual(derivedPath('add_volume', 'volumes'), ['volumes', 'add'])
  assert.deepEqual(derivedPath('deploy', 'deployments'), ['deploy'])
  assert.deepEqual(derivedPath('sandbox_exec', 'sandboxes'), ['sandboxes', 'exec'])
  assert.deepEqual(derivedPath('accept_staged_change', 'staged-changes'), [
    'staged-changes',
    'accept',
  ])
  assert.deepEqual(derivedPath('list_service_volumes', 'volumes'), ['volumes', 'list-service'])
})

test('every operation without cli: false resolves to one command path, and no two collide', () => {
  const generated = generatedCommands()
  assert.ok(generated.length >= 100, `only ${generated.length} operations have a command`)
  const owners = new Map<string, string>()
  for (const { endpoint, path } of generated) {
    assert.ok(
      path.length > 0 && path.every((word) => /^[a-z][a-z0-9-]*$/.test(word)),
      `${endpoint.name} derives ${JSON.stringify(path)}`,
    )
    const key = path.join(' ')
    assert.equal(
      owners.get(key),
      undefined,
      `${endpoint.name} and ${owners.get(key)} derive ${key}`,
    )
    owners.set(key, endpoint.name)
  }
})

test('hand-written commands win, and only the listed operations overlap them', () => {
  assert.deepEqual(registerGenerated(handWrittenProgram()).sort(), handWrittenOverlaps)
  const program = buildProgram()
  for (const { endpoint, path } of generatedCommands()) {
    if (handWrittenOverlaps.includes(endpoint.name)) continue
    assert.ok(find(program, path), `sly ${path.join(' ')} (${endpoint.name}) is not registered`)
  }
})

test('the commands that had no hand-written form exist', () => {
  const program = buildProgram()
  for (const path of [
    ['volumes', 'add'],
    ['volumes', 'remove'],
  ])
    assert.ok(find(program, path), `sly ${path.join(' ')} is missing`)
})

test('--help of a generated command shows flags typed from the schema', () => {
  const program = buildProgram()
  const volumes = find(program, ['volumes', 'add'])!.helpInformation()
  assert.match(volumes, /--mount-path <string>/)
  assert.match(volumes, /--body <json>/)
  assert.match(volumes, /Target: --service <id or name>/)
  const ports = find(program, ['ports', 'add'])!.helpInformation()
  assert.match(ports, /--port <integer>/)
  assert.match(ports, /--protocol <choice>.*\(choices: "http", "tcp"\)/)
  assert.match(ports, /--grpc\b/)
  assert.match(ports, /--no-grpc\b/)
  const remove = find(program, ['volumes', 'remove'])!.helpInformation()
  assert.match(remove, /sly volumes remove \[options\] <id>/)
  assert.match(remove, /--destroy-now/)
})

const endpoint = (name: string) => endpoints(openApiDocument).find((e) => e.name === name)!

test('every render a route names is a registered renderer, and the command uses it', () => {
  const named = endpoints(openApiDocument).filter((e) => e.meta.cli && e.meta.cli.render)
  assert.ok(named.length >= 7, `only ${named.length} routes name a renderer`)
  for (const e of named) {
    const name = (e.meta.cli as { render: string }).render
    assert.ok(
      rendererNames.includes(name),
      `${e.name} renders with ${name}, which is not registered`,
    )
    assert.equal(renderOf(e), renderer(name))
  }
  assert.throws(
    () =>
      renderOf({
        ...endpoint('get_connections'),
        meta: {
          level: 'read',
          cli: {
            render: 'nowhere',
          },
        },
      }),
    /nowhere, which is not registered/,
  )
})

test('a page renders the scalar summary fields of its item schema as columns', () => {
  assert.deepEqual(summaryColumns(endpoint('list_service_volumes')), [
    'id',
    'owner',
    'service_id',
    'station_id',
    'mount_path',
    'size_bytes',
    'status',
    'retain_until',
  ])
  const projects = summaryColumns(endpoint('list_projects'))!
  assert.ok(projects.includes('name'))
  assert.ok(!projects.includes('status_counts'))
  assert.equal(summaryColumns(endpoint('describe_service')), undefined)
})

test('polled operations take --wait and --timeout instead of their wait parameter; streams take -f', () => {
  const program = buildProgram()
  for (const path of [
    ['runs', 'wait-for'],
    ['deployments', 'wait-for'],
  ]) {
    const help = find(program, path)!.helpInformation()
    assert.match(help, /--wait\b/)
    assert.match(help, /--timeout <duration>/)
    assert.doesNotMatch(help, /--wait-s|--timeout-s/)
  }
  const live = find(program, ['network', 'stream-connections'])!.helpInformation()
  assert.match(live, /-f, --follow/)
  assert.doesNotMatch(find(program, ['volumes', 'add'])!.helpInformation(), /--follow|--wait/)
})

test(
  'cli: false operations have no command and a row in Operations without a sly command',
  {
    skip: docsSkip,
  },
  () => {
    const hidden = endpoints(openApiDocument).filter((e) => e.meta.cli === false)
    assert.deepEqual(hidden.map((e) => e.name).sort(), [
      'open_sandbox_shell',
      'open_shell',
      'upload_blob',
    ])
    const doc = readDoc('22-rest-endpoints.md')
    const section = doc.slice(doc.indexOf('## Operations without a sly command'))
    const rows = section.slice(0, section.indexOf('\n## ', 1))
    for (const e of hidden) {
      assert.ok(!generatedCommands().some((g) => g.endpoint.name === e.name))
      assert.ok(rows.includes(`${e.method} ${e.path}`), `${e.method} ${e.path} has no row`)
    }
  },
)
