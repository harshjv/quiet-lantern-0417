import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
  waitedBy,
} from '../src/generated.ts'
import { helpTree, helpTreePath } from '../src/help-tree.ts'
import { openApiDocument } from '../src/openapi.gen.ts'
import { buildProgram, handWrittenProgram } from '../src/program.ts'
import { renderer, rendererNames } from '../src/renderers/index.ts'

const find = (program: CommandUnknownOpts, path: string[]) =>
  path.reduce<CommandUnknownOpts | undefined>(
    (command, word) => command?.commands.find((c) => c.name() === word),
    program,
  )

const shownHelp = (command: CommandUnknownOpts) => {
  let text = ''

  command.configureOutput({
    writeOut: (chunk) => {
      text += chunk
    },
  })
  command.outputHelp()

  return text
}

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

test('every generated command registers, and a hand-written command with its name fails the build', () => {
  const program = buildProgram()

  for (const { endpoint, path } of generatedCommands()) {
    assert.ok(find(program, path), `sly ${path.join(' ')} (${endpoint.name}) is not registered`)
  }

  const clashing = handWrittenProgram()

  clashing.command('projects').command('list')
  assert.throws(
    () => registerGenerated(clashing),
    /sly projects list \(list_projects\) clash with hand-written commands/,
  )
})

test('the sly help tree matches the golden file pnpm generate writes', () => {
  assert.equal(
    helpTree(),
    readFileSync(helpTreePath, 'utf8'),
    'the command tree changed; run pnpm generate and review test/help-tree.txt',
  )
})

test('the commands that had no hand-written form exist', () => {
  const program = buildProgram()

  for (const path of [
    ['volumes', 'add'],
    ['volumes', 'remove'],
  ]) {
    assert.ok(find(program, path), `sly ${path.join(' ')} is missing`)
  }
})

test('--help of a generated command shows flags typed from the schema', () => {
  const program = buildProgram()
  const volumes = shownHelp(find(program, ['volumes', 'add'])!)

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
    ['runs', 'get'],
    ['deployments', 'wait'],
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

test('every registered renderer is named by a route, and its exit maps the outcome to the exit code', () => {
  const named = new Set(
    endpoints(openApiDocument).flatMap((e) =>
      e.meta.cli && e.meta.cli.render ? [e.meta.cli.render] : [],
    ),
  )

  assert.deepEqual(
    rendererNames.filter((name) => !named.has(name)),
    [],
  )
  const status = (value: string) => ({
    status: value,
  })
  const exits = (name: string, value: string) => renderer(name)!.exit!(status(value))

  assert.equal(exits('doctor', 'fail'), 1)
  assert.equal(exits('doctor', 'warn'), 0)
  assert.equal(exits('deployment', 'failed'), 4)
  assert.equal(exits('deployment', 'active'), 0)
  assert.equal(exits('run', 'failed'), 1)
  assert.equal(exits('run', 'running'), 0)
  const logs = renderer('logs')!
  const line = {
    at: 't',
    stream: 'stdout',
    role: 'service',
    text: 'hi',
  }

  assert.equal(logs.event!(line, 'log'), 't   hi')
  assert.equal(logs.event!(line, 'truncated'), null)
})

test('deploy commands take --wait and follow wait_for_deployment by the id they return', () => {
  const program = buildProgram()

  for (const name of ['deploy', 'redeploy', 'rollback', 'restart_service', 'rebuild_service']) {
    assert.equal(waitedBy(endpoint(name))?.endpoint.name, 'wait_for_deployment', name)
    const path = generatedCommands().find((g) => g.endpoint.name === name)!.path

    assert.match(find(program, path)!.helpInformation(), /--wait\s+then repeat wait_for_deployment/)
  }

  assert.equal(waitedBy(endpoint('stop_service')), null)
})

test('integer fields named *_bytes take sizes, *_s and *_seconds take durations', () => {
  const program = buildProgram()

  assert.match(
    find(program, ['sandboxes', 'grow-storage'])!.helpInformation(),
    /--size-bytes <size>/,
  )
  assert.match(find(program, ['sandboxes', 'create'])!.helpInformation(), /--ttl-s <duration>/)
  assert.match(
    find(program, ['environments', 'create'])!.helpInformation(),
    /--ttl-seconds <duration>/,
  )
})

test(
  'cli: false operations have no generated command and a row in Operations without a generated sly command',
  {
    skip: docsSkip,
  },
  () => {
    const hidden = endpoints(openApiDocument).filter((e) => e.meta.cli === false)

    assert.deepEqual(hidden.map((e) => e.name).sort(), [
      'ack_agent_inbox',
      'apply_manifest',
      'backup_volume',
      'explain_network',
      'export_manifest',
      'get_agent_inbox',
      'open_sandbox_shell',
      'open_shell',
      'platform_upgrade',
      'post_agent_events',
      'run_command',
      'sandbox_exec',
      'upload_blob',
      'validate_manifest',
    ])
    const doc = readDoc('22-rest-endpoints.md')
    const section = doc.slice(doc.indexOf('## Operations without a generated sly command'))
    const rows = section.slice(0, section.indexOf('\n## ', 1))

    for (const e of hidden) {
      assert.ok(!generatedCommands().some((g) => g.endpoint.name === e.name))
      assert.ok(rows.includes(`${e.method} ${e.path}`), `${e.method} ${e.path} has no row`)
    }
  },
)
