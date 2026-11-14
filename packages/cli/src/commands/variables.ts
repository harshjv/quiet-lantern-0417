import { readFile } from 'node:fs/promises'
import { parseEnv } from 'node:util'

import { Option } from '@commander-js/extra-typings'

import { call, group, type Program } from '../command.ts'
import { inputRequired, usage } from '../errors.ts'
import { targetId } from '../generated.ts'
import { isId, projectRef, serviceId, type Api, type Run } from '../kit.ts'
import { interactive, need, readStdin } from '../prompt.ts'

const scopes = ['service', 'project', 'global', 'sandbox'] as const

type Scope = (typeof scopes)[number]

const scopeOf = (run: Run, chosen: Scope | undefined): Scope => {
  if (chosen) {
    return chosen
  }

  if (run.selection.sandbox) {
    return 'sandbox'
  }

  return run.selection.service ? 'service' : 'project'
}

const projectEnvironment = (run: Run) => {
  const environment = run.selection.environment

  if (!environment || environment === 'default') {
    return 'default'
  }

  if (isId('environment', environment)) {
    throw usage(
      'Project variables take an environment name, not an id.',
      'Pass --environment <name> or --environment default.',
    )
  }

  return environment
}

export const assignmentOf = (assignment: string) => {
  const at = assignment.indexOf('=')

  return at > 0 ? ([assignment.slice(0, at), assignment.slice(at + 1)] as const) : null
}

const dotenv = (text: string) => {
  const parsed = parseEnv(text)
  const values = Object.values(parsed).join('\n')
  const bare = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith('#') && !line.includes('=') && !values.includes(line))

  if (bare) {
    throw usage(`${bare} in the file has no value.`, 'Write KEY=VALUE lines.')
  }

  return Object.entries(parsed) as [string, string][]
}

const pairs = async (options: { file?: string; sealed?: true }, assignments: string[]) => {
  const result: (readonly [string, string])[] = []

  if (options.file) {
    result.push(
      ...dotenv(options.file === '-' ? await readStdin() : await readFile(options.file, 'utf8')),
    )
  }

  for (const assignment of assignments) {
    const pair = assignmentOf(assignment)

    if (pair) {
      result.push(pair)
    } else if (options.sealed) {
      if (!interactive()) {
        throw inputRequired(
          `The sealed value of ${assignment}`,
          `--file <path> or --file - with ${assignment}=<value> on stdin`,
        )
      }

      result.push([
        assignment,
        await need(undefined, {
          what: `Value of ${assignment} (hidden)`,
          flag: '--file',
          secret: true,
        }),
      ])
    } else {
      throw usage(
        `${assignment} has no value.`,
        `Write ${assignment}=<value>, or add --sealed to type a hidden value.`,
      )
    }
  }

  if (result.length === 0) {
    throw inputRequired('At least one KEY=VALUE', 'KEY=VALUE arguments or --file')
  }

  return result
}

const toSet = (
  options: { sealed?: true; build?: true; copyToClones?: boolean },
  [key, value]: readonly [string, string],
) => {
  const build = {
    ...(options.build
      ? {
          build: true,
        }
      : {}),
    ...(options.copyToClones === undefined
      ? {}
      : {
          copy_to_clones: options.copyToClones,
        }),
  }

  if (options.sealed) {
    return {
      key,
      kind: 'sealed' as const,
      value,
      ...build,
    }
  }

  if (value.includes('${{')) {
    return {
      key,
      kind: 'reference' as const,
      reference: value,
      ...build,
    }
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
  if (scope === 'global') {
    return run.api.v1['global-variables'].patch(body)
  }

  if (scope === 'sandbox') {
    return run.api.v1
      .sandboxes({
        sandbox: await targetId(run, 'sandbox'),
      })
      .variables.patch(body)
  }

  if (scope === 'project') {
    return run.api.v1
      .projects({
        project: await projectRef(run),
      })
      .variables.patch({
        environment: projectEnvironment(run),
        ...body,
      })
  }

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
    .addOption(
      new Option(
        '--scope <scope>',
        'default sandbox when --sandbox is selected, service when --service is, else project',
      ).choices(scopes),
    )
    .option('--sealed', 'store as sealed: write-only, never returned')
    .option('--file <path>', 'read KEY=VALUE lines from a file, or - for stdin')
    .option('--build', 'also pass to the build')
    .option(
      '--copy-to-clones',
      'sealed only: copy the value into clones of this environment; a bare KEY changes only this flag',
    )
    .option('--no-copy-to-clones', 'sealed only: keep the value out of clones, the default')
    .option('--apply', 'redeploy stale dependents')
    .option('--allow-unresolved', 'accept references whose target does not exist yet')
    .action(
      call(async (run, options, assignments) => {
        const scope = scopeOf(run, options.scope)
        const flagOnly = options.copyToClones !== undefined && !options.file
        const bare = flagOnly ? assignments.filter((assignment) => !assignmentOf(assignment)) : []
        const given = flagOnly
          ? assignments.filter((assignment) => assignmentOf(assignment))
          : assignments
        const set = [
          ...bare.map((key) => ({
            key,
            kind: 'sealed' as const,
            copy_to_clones: options.copyToClones,
          })),
          ...(given.length || options.file || !bare.length ? await pairs(options, given) : []).map(
            (pair) => toSet(options, pair),
          ),
        ]

        return patch(run, scope, {
          set,
          apply: scope === 'sandbox' ? undefined : options.apply,
          allow_unresolved: options.allowUnresolved,
        })
      }),
    )
}
