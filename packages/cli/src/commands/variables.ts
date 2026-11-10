import { readFile } from 'node:fs/promises'

import type { Command, OptionValues } from '@commander-js/extra-typings'

import { action, call, integer, type Program } from '../command.ts'
import { inputRequired, usage } from '../errors.ts'
import {
  connect,
  found,
  isId,
  isOneOf,
  projectId,
  projectRef,
  send,
  serviceId,
  type Api,
  type Data,
  type Run,
} from '../kit.ts'
import { human, print } from '../output.ts'
import { interactive, need, readStdin } from '../prompt.ts'

const scopes = ['service', 'project', 'global'] as const

type Scope = (typeof scopes)[number]

const scopeOf = (run: Run, chosen: string | undefined): Scope => {
  if (chosen !== undefined && isOneOf(scopes, chosen)) return chosen
  if (chosen !== undefined)
    throw usage(
      `--scope ${chosen} is not service, project or global.`,
      'Pass --scope service, project or global.',
    )
  return run.selection.service ? 'service' : 'project'
}

const projectEnvironment = (run: Run) => {
  const environment = run.selection.environment
  if (!environment || environment === 'default') return 'default'
  if (isId('environment', environment))
    throw usage(
      'Project variables take an environment name, not an id.',
      'Pass --environment <name> or --environment default.',
    )
  return environment
}

const dotenv = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const at = line.indexOf('=')
      if (at < 1)
        throw usage(`${line.split('=')[0]} in the file has no value.`, 'Write KEY=VALUE lines.')
      const raw = line.slice(at + 1).trim()
      return [line.slice(0, at).trim(), /^(['"]).*\1$/.test(raw) ? raw.slice(1, -1) : raw] as const
    })

const pairs = async (options: { file?: string; sealed?: true }, assignments: string[]) => {
  const result: (readonly [string, string])[] = []
  if (options.file)
    result.push(
      ...dotenv(options.file === '-' ? await readStdin() : await readFile(options.file, 'utf8')),
    )
  for (const assignment of assignments) {
    const at = assignment.indexOf('=')
    if (at > 0) result.push([assignment.slice(0, at), assignment.slice(at + 1)])
    else if (options.sealed) {
      if (!interactive())
        throw inputRequired(
          `The sealed value of ${assignment}`,
          `--file <path> or --file - with ${assignment}=<value> on stdin`,
        )
      result.push([
        assignment,
        await need(undefined, {
          what: `Value of ${assignment} (hidden)`,
          flag: '--file',
          secret: true,
        }),
      ])
    } else
      throw usage(
        `${assignment} has no value.`,
        `Write ${assignment}=<value>, or add --sealed to type a hidden value.`,
      )
  }
  if (result.length === 0)
    throw inputRequired('At least one KEY=VALUE', 'KEY=VALUE arguments or --file')
  return result
}

export const toSet = (
  options: { sealed?: true; build?: true },
  [key, value]: readonly [string, string],
) => {
  const build = options.build
    ? {
        build: true,
      }
    : {}
  if (options.sealed)
    return {
      key,
      kind: 'sealed' as const,
      value,
      ...build,
    }
  if (value.includes('${{'))
    return {
      key,
      kind: 'reference' as const,
      reference: value,
      ...build,
    }
  return {
    key,
    kind: 'literal' as const,
    value,
    ...build,
  }
}

type Patch = NonNullable<Parameters<Api['global-variables']['patch']>[0]>

const patch = async (run: Run, scope: Scope, body: Patch) => {
  if (scope === 'global') return run.api.v1['global-variables'].patch(body)
  if (scope === 'project')
    return run.api.v1
      .projects({
        project: await projectRef(run),
      })
      .variables.patch({
        environment: projectEnvironment(run),
        ...body,
      })
  return run.api.v1
    .services({
      service: await serviceId(run),
    })
    .variables.patch(body)
}

type Listed = Data<Api['global-variables']['get']>

type Resolved = Data<ReturnType<Api['services']>['variables']['resolved']['get']>

const describe = (
  sealed: boolean,
  version: number | null | undefined,
  bytes: number | null | undefined,
) => {
  if (!version) return 'not set'
  return sealed ? `set, ${bytes ?? '?'} bytes, version ${version}` : `hidden, version ${version}`
}

const renderListed = ({ items, next_cursor }: Listed) => {
  const rows = items.map((v) => ({
    key: v.key,
    kind: v.kind,
    value:
      v.kind === 'reference' ? v.reference : describe(v.kind === 'sealed', v.head_version, v.bytes),
    ...('environments' in v && v.environments
      ? {
          environments: v.environments.join(','),
        }
      : {}),
  }))
  return human({
    items: rows,
    next_cursor,
  })
}

const renderResolved = ({ variables, exports }: Resolved) => {
  const rows = variables.map((v) => ({
    key: v.key,
    kind: v.kind,
    value: v.error
      ? `error: ${v.error.code}`
      : v.value !== undefined
        ? v.value
        : v.version !== undefined
          ? describe(v.sealed, v.version, v.bytes)
          : `${v.sealed ? '(sealed) ' : ''}${v.reference}`,
    stale: v.stale,
  }))
  return `${human({
    items: rows,
  })}\n\nexports:\n${human({
    items: exports,
  })}`
}

const variableId = async (run: Run, scope: Scope, key: string) => {
  const listed = await send(
    scope === 'global'
      ? run.api.v1['global-variables'].get()
      : scope === 'project'
        ? run.api.v1
            .projects({
              project: encodeURIComponent(await projectRef(run)),
            })
            .variables.get()
        : run.api.v1
            .services({
              service: await serviceId(run),
            })
            .variables.get(),
  )
  return found(
    listed.data.items,
    (v) => v.key === key,
    `No ${scope} variable ${key} is visible here.`,
    'Run sly variables list to see the keys.',
  ).id
}

const scoped = <A extends unknown[], O extends OptionValues, G extends OptionValues>(
  command: Command<A, O, G>,
) => command.option('--scope <scope>', 'service (when --service is selected), project or global')

export const variableCommands = (program: Program) => {
  const variables = program
    .command('variables')
    .description('Variables and secret values; sealed values are never shown')
  scoped(
    variables
      .command('list')
      .option('--no-resolved', 'list the variables rather than the resolved view'),
  ).action(
    action(async (options) => {
      const run = await connect(options)
      const scope = scopeOf(run, options.scope)
      if (scope === 'global')
        return print(
          options,
          await send(
            run.api.v1['global-variables'].get({
              query: {},
            }),
          ),
          renderListed,
        )
      if (scope === 'project')
        return print(
          options,
          await send(
            run.api.v1
              .projects({
                project: await projectRef(run),
              })
              .variables.get({
                query: {
                  environment: run.selection.environment,
                },
              }),
          ),
          renderListed,
        )
      const service = await serviceId(run)
      if (!options.resolved)
        return print(
          options,
          await send(
            run.api.v1
              .services({
                service,
              })
              .variables.get({
                query: {},
              }),
          ),
          renderListed,
        )
      return print(
        options,
        await send(
          run.api.v1
            .services({
              service,
            })
            .variables.resolved.get(),
        ),
        renderResolved,
      )
    }),
  )
  scoped(
    variables
      .command('set')
      .argument(
        '[assignments...]',
        'KEY=VALUE pairs; with --sealed, a bare KEY prompts for a hidden value',
      )
      .option('--sealed', 'store as sealed: write-only, never returned')
      .option('--file <path>', 'read KEY=VALUE lines from a file, or - for stdin')
      .option('--build', 'also pass to the build')
      .option('--apply', 'redeploy stale dependents')
      .option('--allow-unresolved', 'accept references whose target does not exist yet'),
  ).action(
    call(async (run, options, assignments) => {
      const scope = scopeOf(run, options.scope)
      const set = (await pairs(options, assignments)).map((pair) => toSet(options, pair))
      return patch(run, scope, {
        set,
        apply: options.apply,
        allow_unresolved: options.allowUnresolved,
      })
    }),
  )
  scoped(
    variables.command('unset').argument('<keys...>').option('--apply', 'redeploy stale dependents'),
  ).action(
    call(async (run, options, keys) =>
      patch(run, scopeOf(run, options.scope), {
        unset: keys,
        apply: options.apply,
      }),
    ),
  )
  scoped(variables.command('apply').argument('<key>')).action(
    call(async (run, options, key) =>
      run.api.v1
        .variables({
          id: await variableId(run, scopeOf(run, options.scope), key),
        })
        .apply.post(),
    ),
  )
  scoped(
    variables
      .command('revoke')
      .argument('<key>')
      .requiredOption('--version <n>', 'version to revoke', integer)
      .option('--undo', 'undo a revocation before the sweep')
      .option('--force', 'revoke even when an active deployment pins it'),
  ).action(
    call(async (run, options, key) => {
      const scope = scopeOf(run, options.scope)
      const id = await variableId(run, scope, key)
      const environment = scope === 'project' ? projectEnvironment(run) : undefined
      const versions = await send(
        run.api.v1
          .variables({
            id,
          })
          .versions.get({
            query: {
              environment,
            },
          }),
      )
      const version = found(
        versions.data.items,
        (v) => v.version === options.version,
        `${key} has no version ${options.version}.`,
        'List versions with sly variables list --fields versions.',
      )
      if (options.undo)
        return run.api.v1['secret-values']({
          id: version.id,
        }).restore.post()
      return run.api.v1['secret-values']({
        id: version.id,
      }).revoke.post({
        force: options.force,
      })
    }),
  )
  variables
    .command('grant')
    .argument('<key>', 'global variable key')
    .requiredOption('--to <project>', 'project to grant it to')
    .option('--alias <alias>', 'name the project sees')
    .action(
      call(async (run, options, key) => {
        const id = await variableId(run, 'global', key)
        return run.api.v1
          .variables({
            id,
          })
          .grants.post({
            project_id: await projectId(run, options.to),
            alias: options.alias,
          })
      }),
    )
  variables
    .command('ungrant')
    .argument('<grant>')
    .action(
      call(async (run, _options, grant) =>
        run.api.v1
          .grants({
            id: grant,
          })
          .delete(),
      ),
    )
}
