import { readFile } from 'node:fs/promises'
import { parseEnv } from 'node:util'

import { Option } from '@commander-js/extra-typings'

import { call, group, type Program } from '../command.ts'
import { inputRequired, usage } from '../errors.ts'
import { targetId } from '../generated.ts'
import { appId, projectRef, type Api, type Run } from '../kit.ts'
import { interactive, need, readStdin } from '../prompt.ts'

const scopes = ['app', 'project', 'global', 'machine'] as const

type Scope = (typeof scopes)[number]

const scopeOf = (run: Run, chosen: Scope | undefined): Scope => {
  if (chosen) {
    return chosen
  }

  if (run.selection.machine) {
    return 'machine'
  }

  return run.selection.app ? 'app' : 'project'
}

const valueTarget = (run: Run) =>
  run.selection.preview ? ('preview' as const) : ('production' as const)

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

const pairs = async (options: { file?: string; secret?: true }, assignments: string[]) => {
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
    } else if (options.secret) {
      if (!interactive()) {
        throw inputRequired(
          `The secret value of ${assignment}`,
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
        `Write ${assignment}=<value>, or add --secret to type a hidden value.`,
      )
    }
  }

  if (result.length === 0) {
    throw inputRequired('At least one KEY=VALUE', 'KEY=VALUE arguments or --file')
  }

  return result
}

const toSet = (
  options: { secret?: true; build?: true },
  [name, value]: readonly [string, string],
) => {
  const build = {
    ...(options.build
      ? {
          build: true,
        }
      : {}),
  }

  if (options.secret) {
    return {
      name,
      kind: 'secret' as const,
      value,
      ...build,
    }
  }

  if (value.includes('${{')) {
    return {
      name,
      kind: 'reference' as const,
      reference: value,
      ...build,
    }
  }

  return {
    name,
    kind: 'literal' as const,
    value,
    ...build,
  }
}

type Patch = NonNullable<Parameters<Api['global-environment-variables']['patch']>[0]>

const patch = async (run: Run, scope: Scope, body: Patch) => {
  if (scope === 'global') {
    return run.api.v1['global-environment-variables'].patch(body)
  }

  if (scope === 'machine') {
    return run.api.v1
      .machines({
        machine: await targetId(run, 'machine'),
      })
      ['environment-variables'].patch(body)
  }

  if (scope === 'project') {
    return run.api.v1
      .projects({
        project: await projectRef(run),
      })
      ['environment-variables'].patch({
        target: valueTarget(run),
        ...body,
      })
  }

  return run.api.v1
    .apps({
      app: await appId(run),
    })
    ['environment-variables'].patch(body)
}

export const variableCommands = (program: Program) => {
  group(program, 'env')
    .command('set')
    .description(
      'Set environment variables from KEY=VALUE arguments, a dotenv file or stdin, prompting for a hidden value of a bare KEY with --secret',
    )
    .argument(
      '[assignments...]',
      'KEY=VALUE pairs; with --secret, a bare KEY prompts for a hidden value',
    )
    .addOption(
      new Option(
        '--scope <scope>',
        'default machine when --machine is selected, app when --app is, else project',
      ).choices(scopes),
    )
    .option('--secret', 'store as secret: write-only, never returned')
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
          apply: scope === 'machine' ? undefined : options.apply,
          allow_unresolved: options.allowUnresolved,
        })
      }),
    )
}
