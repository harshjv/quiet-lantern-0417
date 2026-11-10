import { readFile } from 'node:fs/promises'

import { call, group, type Program } from '../command.ts'
import { inputRequired, usage } from '../errors.ts'
import { targetId } from '../generated.ts'
import { isId, isOneOf, projectRef, serviceId, type Api, type Run } from '../kit.ts'
import { interactive, need, readStdin } from '../prompt.ts'

const scopes = ['service', 'project', 'global', 'sandbox'] as const

type Scope = (typeof scopes)[number]

const scopeOf = (run: Run, chosen: string | undefined): Scope => {
  if (chosen !== undefined && isOneOf(scopes, chosen)) return chosen
  if (chosen !== undefined)
    throw usage(
      `--scope ${chosen} is not service, project, global or sandbox.`,
      'Pass --scope service, project, global or sandbox.',
    )
  if (run.selection.sandbox) return 'sandbox'
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

export const assignmentOf = (assignment: string) => {
  const at = assignment.indexOf('=')
  return at > 0 ? ([assignment.slice(0, at), assignment.slice(at + 1)] as const) : null
}

const dotenv = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const pair = assignmentOf(line)
      if (!pair)
        throw usage(`${line.split('=')[0]} in the file has no value.`, 'Write KEY=VALUE lines.')
      const [key, raw] = pair
      const value = raw.trim()
      return [key.trim(), /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value] as const
    })

const pairs = async (options: { file?: string; sealed?: true }, assignments: string[]) => {
  const result: (readonly [string, string])[] = []
  if (options.file)
    result.push(
      ...dotenv(options.file === '-' ? await readStdin() : await readFile(options.file, 'utf8')),
    )
  for (const assignment of assignments) {
    const pair = assignmentOf(assignment)
    if (pair) result.push(pair)
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

const toSet = (
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
  if (scope === 'sandbox')
    return run.api.v1
      .sandboxes({
        sandbox: await targetId(run, 'sandbox'),
      })
      .variables.patch(body)
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

export const variableCommands = (program: Program) => {
  group(program, 'variables')
    .command('set')
    .description(
      'Set variables from KEY=VALUE arguments, a dotenv file or stdin, prompting for a hidden value of a bare KEY with --sealed',
    )
    .argument(
      '[assignments...]',
      'KEY=VALUE pairs; with --sealed, a bare KEY prompts for a hidden value',
    )
    .option(
      '--scope <scope>',
      'sandbox (when --sandbox is selected), service (when --service is), project or global',
    )
    .option('--sealed', 'store as sealed: write-only, never returned')
    .option('--file <path>', 'read KEY=VALUE lines from a file, or - for stdin')
    .option('--build', 'also pass to the build')
    .option('--apply', 'redeploy stale dependents')
    .option('--allow-unresolved', 'accept references whose target does not exist yet')
    .action(
      call(async (run, options, assignments) => {
        const scope = scopeOf(run, options.scope)
        const set = (await pairs(options, assignments)).map((pair) => toSet(options, pair))
        return patch(run, scope, {
          set,
          apply: scope === 'sandbox' ? undefined : options.apply,
          allow_unresolved: options.allowUnresolved,
        })
      }),
    )
}
