import { readFile } from 'node:fs/promises'
import type { Command } from 'commander'
import { action, integer, type Options } from '../command.ts'
import { Exit, exitCodes, inputRequired, usage } from '../errors.ts'
import { connect, projectRef, send, serviceId, type Run } from '../kit.ts'
import { human, print } from '../output.ts'
import { interactive, need, readStdin } from '../prompt.ts'

type Scope = 'service' | 'project' | 'global'

type VariableSet = { key: string; kind: 'literal' | 'reference' | 'sealed'; value?: string; reference?: string; build?: boolean }

const scopeOf = (run: Run, options: Options): Scope => {
  const chosen = options.scope as string | undefined
  if (chosen === 'service' || chosen === 'project' || chosen === 'global') return chosen
  if (chosen !== undefined) throw usage(`--scope ${chosen} is not service, project or global.`, 'Pass --scope service, project or global.')
  return run.selection.service ? 'service' : 'project'
}

const projectEnvironment = (run: Run) => {
  const environment = run.selection.environment
  if (!environment || environment === 'default') return 'default'
  if (environment.startsWith('env_')) throw usage('Project variables take an environment name, not an id.', 'Pass --environment <name> or --environment default.')
  return environment
}

const dotenv = (text: string) =>
  text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const at = line.indexOf('=')
      if (at < 1) throw usage(`${line.split('=')[0]} in the file has no value.`, 'Write KEY=VALUE lines.')
      const raw = line.slice(at + 1).trim()
      return [line.slice(0, at).trim(), /^(['"]).*\1$/.test(raw) ? raw.slice(1, -1) : raw] as const
    })

const pairs = async (options: Options, assignments: string[]) => {
  const result: (readonly [string, string])[] = []
  if (options.file) result.push(...dotenv(options.file === '-' ? await readStdin() : await readFile(options.file as string, 'utf8')))
  for (const assignment of assignments) {
    const at = assignment.indexOf('=')
    if (at > 0) result.push([assignment.slice(0, at), assignment.slice(at + 1)])
    else if (options.sealed) {
      if (!interactive()) throw inputRequired(`The sealed value of ${assignment}`, `--file <path> or --file - with ${assignment}=<value> on stdin`)
      result.push([assignment, await need(undefined, { what: `Value of ${assignment} (hidden)`, flag: '--file', secret: true })])
    } else throw usage(`${assignment} has no value.`, `Write ${assignment}=<value>, or add --sealed to type a hidden value.`)
  }
  if (result.length === 0) throw inputRequired('At least one KEY=VALUE', 'KEY=VALUE arguments or --file')
  return result
}

const toSet = (options: Options, [key, value]: readonly [string, string]): VariableSet => {
  const build = options.build ? { build: true } : {}
  if (options.sealed) return { key, kind: 'sealed', value, ...build }
  if (value.includes('${{')) return { key, kind: 'reference', reference: value, ...build }
  return { key, kind: 'literal', value, ...build }
}

type Patch = { set?: VariableSet[]; unset?: string[]; apply?: boolean; allow_unresolved?: boolean }

const patch = async (run: Run, scope: Scope, body: Patch) => {
  if (scope === 'global') return send(run.api.v1['global-variables'].patch(body))
  if (scope === 'project') return send(run.api.v1.projects({ project: await projectRef(run) }).variables.patch({ environment: projectEnvironment(run), ...body }))
  return send(run.api.v1.services({ service: await serviceId(run) }).variables.patch(body))
}

type Listed = { items: { id: string; key: string }[] }

type Summary = { key: string; kind: string; reference: string | null; head_version: number | null; bytes: number | null; environments?: string[] }

type ResolvedEntry = {
  key: string
  kind: string
  reference: string | null
  sealed: boolean
  stale: boolean
  version?: number
  bytes?: number
  value?: string
  error: { code: string } | null
}

const describe = (sealed: boolean, version: number | null | undefined, bytes: number | null | undefined) => {
  if (!version) return 'not set'
  return sealed ? `set, ${bytes ?? '?'} bytes, version ${version}` : `hidden, version ${version}`
}

const renderListed = (data: unknown) => {
  const { items, next_cursor } = data as { items: Summary[]; next_cursor?: string | null }
  const rows = items.map(v => ({
    key: v.key,
    kind: v.kind,
    value: v.kind === 'reference' ? v.reference : describe(v.kind === 'sealed', v.head_version, v.bytes),
    ...(v.environments ? { environments: v.environments.join(',') } : {})
  }))
  return human({ items: rows, next_cursor })
}

const renderResolved = (data: unknown) => {
  const { variables, exports } = data as { variables: ResolvedEntry[]; exports: { key: string; value: string }[] }
  const rows = variables.map(v => ({
    key: v.key,
    kind: v.kind,
    value: v.error
      ? `error: ${v.error.code}`
      : v.value !== undefined
        ? v.value
        : v.version !== undefined
          ? describe(v.sealed, v.version, v.bytes)
          : `${v.sealed ? '(sealed) ' : ''}${v.reference}`,
    stale: v.stale
  }))
  return `${human({ items: rows })}\n\nexports:\n${human({ items: exports })}`
}

const variableId = async (run: Run, scope: Scope, key: string) => {
  const listed =
    scope === 'global'
      ? await run.get<Listed>('/v1/global-variables')
      : scope === 'project'
        ? await run.get<Listed>(`/v1/projects/${encodeURIComponent(await projectRef(run))}/variables`)
        : await run.get<Listed>(`/v1/services/${await serviceId(run)}/variables`)
  const found = listed.items.find(v => v.key === key)
  if (!found) throw new Exit(exitCodes.api, { error: { code: 'NOT_FOUND', explanation: `No ${scope} variable ${key} is visible here.`, fix: 'Run sly variables list to see the keys.' } })
  return found.id
}

const scoped = (command: Command) => command.option('--scope <scope>', 'service (when --service is selected), project or global')

export const variableCommands = (program: Command) => {
  const variables = program.command('variables').description('Variables and secret values; sealed values are never shown')
  scoped(variables.command('list').option('--no-resolved', 'list the variables rather than the resolved view')).action(
    action(async options => {
      const run = await connect(options)
      const scope = scopeOf(run, options)
      if (scope === 'global') return print(options, await send(run.api.v1['global-variables'].get({ query: {} })), renderListed)
      if (scope === 'project')
        return print(options, await send(run.api.v1.projects({ project: await projectRef(run) }).variables.get({ query: { environment: run.selection.environment } })), renderListed)
      const service = await serviceId(run)
      if (options.resolved === false) return print(options, await send(run.api.v1.services({ service }).variables.get({ query: {} })), renderListed)
      return print(options, await send(run.api.v1.services({ service }).variables.resolved.get()), renderResolved)
    })
  )
  scoped(
    variables
      .command('set')
      .argument('[assignments...]', 'KEY=VALUE pairs; with --sealed, a bare KEY prompts for a hidden value')
      .option('--sealed', 'store as sealed: write-only, never returned')
      .option('--file <path>', 'read KEY=VALUE lines from a file, or - for stdin')
      .option('--build', 'also pass to the build')
      .option('--apply', 'redeploy stale dependents')
      .option('--allow-unresolved', 'accept references whose target does not exist yet')
  ).action(
    action(async (options, ...assignments) => {
      const run = await connect(options)
      const scope = scopeOf(run, options)
      const set = (await pairs(options, assignments)).map(pair => toSet(options, pair))
      return print(options, await patch(run, scope, { set, apply: options.apply as boolean | undefined, allow_unresolved: options.allowUnresolved as boolean | undefined }))
    })
  )
  scoped(variables.command('unset').argument('<keys...>').option('--apply', 'redeploy stale dependents')).action(
    action(async (options, ...keys) => {
      const run = await connect(options)
      return print(options, await patch(run, scopeOf(run, options), { unset: keys, apply: options.apply as boolean | undefined }))
    })
  )
  scoped(variables.command('apply').argument('<key>')).action(
    action(async (options, key) => {
      const run = await connect(options)
      return print(options, await send(run.api.v1.variables({ id: await variableId(run, scopeOf(run, options), key!) }).apply.post()))
    })
  )
  scoped(
    variables
      .command('revoke')
      .argument('<key>')
      .requiredOption('--version <n>', 'version to revoke', integer)
      .option('--undo', 'undo a revocation before the sweep')
      .option('--force', 'revoke even when an active deployment pins it')
  ).action(
    action(async (options, key) => {
      const run = await connect(options)
      const scope = scopeOf(run, options)
      const id = await variableId(run, scope, key!)
      const environment = scope === 'project' ? projectEnvironment(run) : undefined
      const versions = await run.get<{ items: { id: string; version: number }[] }>(`/v1/variables/${id}/versions${environment ? `?environment=${encodeURIComponent(environment)}` : ''}`)
      const found = versions.items.find(v => v.version === options.version)
      if (!found) throw new Exit(exitCodes.api, { error: { code: 'NOT_FOUND', explanation: `${key} has no version ${options.version}.`, fix: 'List versions with sly variables list --fields versions.' } })
      if (options.undo) return print(options, await send(run.api.v1['secret-values']({ id: found.id }).restore.post()))
      return print(options, await send(run.api.v1['secret-values']({ id: found.id }).revoke.post({ force: options.force as boolean | undefined })))
    })
  )
  variables
    .command('grant')
    .argument('<key>', 'global variable key')
    .requiredOption('--to <project>', 'project to grant it to')
    .option('--alias <alias>', 'name the project sees')
    .action(
      action(async (options, key) => {
        const run = await connect(options)
        const id = await variableId(run, 'global', key!)
        const project = await run.get<{ id: string }>(`/v1/projects/${encodeURIComponent(options.to as string)}`)
        return print(options, await send(run.api.v1.variables({ id }).grants.post({ project_id: project.id, alias: options.alias as string | undefined })))
      })
    )
  variables
    .command('ungrant')
    .argument('<grant>')
    .action(
      action(async (options, grant) => {
        const run = await connect(options)
        return print(options, await send(run.api.v1.grants({ id: grant! }).delete()))
      })
    )
}

