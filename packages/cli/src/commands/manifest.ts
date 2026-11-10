import { readFile, writeFile } from 'node:fs/promises'

import type { Command } from '@commander-js/extra-typings'

import { validateSchema, type Issue } from '@stationly/manifest-schema'

import { action, group, type Program, type ProgramOptions } from '../command.ts'
import { exitCodes, usage } from '../errors.ts'
import { connect, document, send, type Globals } from '../kit.ts'
import { json, print, progress } from '../output.ts'
import { renderPlan } from '../renderers/manifest.ts'

const readManifest = async (file: string) => {
  try {
    return await readFile(file, 'utf8')
  } catch {
    throw usage(
      `${file} cannot be read.`,
      'Pass the Manifest with -f <file>, or run sly in the directory that holds stationly.yaml.',
    )
  }
}

const projectOf = (text: string) => {
  const parsed = validateSchema(text)
  return parsed.value?.project ?? /^project:\s*["']?([a-z0-9-]+)/m.exec(text)?.[1]
}

const renderIssues = (issues: Issue[]) =>
  issues
    .map(
      (i) =>
        `${i.line !== undefined ? `${i.line}:${i.column} ` : ''}${i.path || '/'} ${i.code}: ${i.message}`,
    )
    .join('\n')

const apply = async (
  options: Globals & { file: string; plan?: true; prune?: true; allowUnresolved: boolean },
) => {
  const text = await readManifest(options.file)
  const run = await connect(options)
  const project = run.selection.project ?? projectOf(text)
  if (!project)
    throw usage(
      'No project is selected and the Manifest names none.',
      'Pass --project, or set project in the Manifest.',
    )
  const sent = await send(
    run.api.v1
      .projects({
        project,
      })
      .manifest.apply.post({
        manifest: text,
        environment: run.selection.environment,
        plan: Boolean(options.plan),
        prune: Boolean(options.prune),
        allow_unresolved: options.allowUnresolved,
      }),
  )
  return print(options, sent, renderPlan)
}

const applyOptions = (command: Command<[], {}, ProgramOptions>) =>
  command
    .option('-f, --file <file>', 'the Manifest', 'stationly.yaml')
    .option('--plan', 'show the diff and write nothing')
    .option('--prune', 'remove entities that a managed collection does not list')
    .option('--no-allow-unresolved', 'fail on references whose target does not exist yet')
    .action(action(apply))

export const manifestCommands = (program: Program) => {
  applyOptions(
    program.command('apply').description('Plan or apply a Manifest (alias of sly manifest apply)'),
  )
  const manifest = group(program, 'manifest')
  applyOptions(
    manifest.command('apply').description('Plan or apply a Manifest against one environment'),
  )
  manifest
    .command('export')
    .description('Write the current configuration as a canonical Manifest')
    .option('-o, --output <file>', 'write to a file instead of stdout')
    .action(
      action(async (options) => {
        const run = await connect(options)
        const project =
          run.selection.project ??
          (await readFile('stationly.yaml', 'utf8').then(projectOf, () => undefined))
        if (!project) throw usage('No project is selected.', 'Pass --project <id or name>.')
        if (options.json)
          return print(
            options,
            await send(
              run.api.v1
                .projects({
                  project,
                })
                .manifest.get({
                  query: {
                    environment: run.selection.environment,
                  },
                  headers: {
                    accept: 'application/json',
                  },
                }),
            ),
          )
        const text = await document(
          run.api.v1
            .projects({
              project: encodeURIComponent(project),
            })
            .manifest.get({
              query: {
                environment: run.selection.environment,
              },
              headers: {
                accept: 'text/yaml',
              },
            }),
        )
        if (options.output) {
          await writeFile(options.output, text)
          progress(`wrote ${options.output}`)
        } else process.stdout.write(text)
        return exitCodes.ok
      }),
    )
  manifest
    .command('validate')
    .description('Check a Manifest: the bundled schema, then the instance for the semantic pass')
    .option('-f, --file <file>', 'the Manifest', 'stationly.yaml')
    .option('--offline', 'run only the schema pass')
    .action(
      action(async (options) => {
        const text = await readManifest(options.file)
        const local = validateSchema(text)
        if (local.issues.length || options.offline) {
          if (options.json)
            json({
              valid: local.issues.length === 0,
              issues: local.issues,
              warnings: [],
            })
          else
            process.stdout.write(
              local.issues.length
                ? `${renderIssues(local.issues)}\n${local.issues.length} problems\n`
                : 'valid (schema pass)\n',
            )
          return local.issues.length ? exitCodes.api : exitCodes.ok
        }
        const run = await connect(options)
        const result = (
          await send(
            run.api.v1.manifest.validate.post({
              manifest: text,
              environment: run.selection.environment,
            }),
          )
        ).data
        if (options.json) json(result)
        else {
          if (result.issues.length) process.stdout.write(`${renderIssues(result.issues)}\n`)
          for (const w of result.warnings)
            process.stdout.write(`warning ${w.code}: ${w.explanation}\n`)
          process.stdout.write(result.valid ? 'valid\n' : `${result.issues.length} problems\n`)
        }
        return result.valid ? exitCodes.ok : exitCodes.api
      }),
    )
}
