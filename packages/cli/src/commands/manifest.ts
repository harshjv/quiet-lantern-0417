import { readFile, writeFile } from 'node:fs/promises'
import { validateSchema, type Issue } from '@stationly/manifest-schema'
import type { Command } from 'commander'
import { action, type Options } from '../command.ts'
import { apiFailure, exitCodes, usage } from '../errors.ts'
import { body, connect, send, type Run } from '../kit.ts'
import { print, progress } from '../output.ts'

type Change = { op: 'add' | 'update' | 'remove'; entity: string; id?: string; ref?: string; parent?: string | null; path?: string; before?: unknown; after?: unknown }
type Plan = {
  id: string | null
  status: string
  changes: Change[]
  unmanaged?: { entity: string; id: string; name?: string; key?: string; service?: string; hostname?: string; port?: number; mount_path?: string }[]
  warnings?: { code: string; explanation: string; path?: string }[]
  deployments?: unknown[]
}

const readManifest = async (file: string) => {
  try {
    return await readFile(file, 'utf8')
  } catch {
    throw usage(`${file} cannot be read.`, 'Pass the Manifest with -f <file>, or run sly in the directory that holds stationly.yaml.')
  }
}

const projectOf = (text: string) => {
  const parsed = validateSchema(text)
  return (parsed.value?.project ?? /^project:\s*["']?([a-z0-9-]+)/m.exec(text)?.[1]) as string | undefined
}

const short = (value: unknown) => {
  const text = JSON.stringify(value)
  return text === undefined ? 'null' : text.length > 80 ? `${text.slice(0, 77)}...` : text
}

const label = (change: Change) => {
  const after = (change.after ?? change.before ?? {}) as Record<string, unknown>
  const name = after.name ?? after.key ?? after.hostname ?? after.mount_path ?? (after.port !== undefined ? `port ${after.port}` : undefined) ?? (after.host_port !== undefined ? `host port ${after.host_port}` : undefined)
  return `${change.entity}${name !== undefined ? ` ${name}` : ''}`
}

export const renderPlan = (data: unknown) => {
  const plan = data as Plan
  const lines: string[] = []
  const names = new Map<string, string>()
  for (const change of plan.changes) if (change.op === 'add' && change.ref) names.set(change.ref, label(change))
  for (const change of plan.changes) {
    if (change.op === 'add' && change.entity === 'deployment') {
      const after = change.after as { trigger: { type: string }; reason?: string }
      lines.push(`+ deployment of ${names.get(change.parent ?? '') ?? change.parent} (${after.trigger.type}${after.reason ? `: ${after.reason}` : ''})`)
    } else if (change.op === 'add') lines.push(`+ ${label(change)}${change.parent && names.has(change.parent) ? ` in ${names.get(change.parent)}` : ''}`)
    else if (change.op === 'remove') lines.push(`- ${label(change)} ${change.id}`)
    else lines.push(`~ ${names.get(change.id ?? '') ?? `${change.entity} ${change.id}`} ${change.path || ''}: ${change.entity === 'variable' ? 'value or settings change' : `${short(change.before)} -> ${short(change.after)}`}`)
  }
  const summary = {
    add: plan.changes.filter(c => c.op === 'add' && c.entity !== 'deployment').length,
    update: plan.changes.filter(c => c.op === 'update').length,
    remove: plan.changes.filter(c => c.op === 'remove').length,
    deployments: plan.changes.filter(c => c.op === 'add' && c.entity === 'deployment').length
  }
  const out = [lines.length ? lines.join('\n') : 'no changes', '', `${plan.status}: ${summary.add} to add, ${summary.update} to change, ${summary.remove} to remove, ${summary.deployments} deployments${plan.id ? ` (${plan.id})` : ''}`]
  if (plan.unmanaged?.length) out.push('', `unmanaged (left in place; --prune removes them):`, ...plan.unmanaged.map(u => `  ${u.entity} ${u.name ?? u.key ?? u.hostname ?? u.mount_path ?? u.port ?? ''}${u.service ? ` of ${u.service}` : ''} ${u.id}`))
  if (plan.warnings?.length) out.push('', 'warnings:', ...plan.warnings.map(w => `  ${w.code}${w.path ? ` ${w.path}` : ''}: ${w.explanation}`))
  return out.join('\n')
}

const renderIssues = (issues: Issue[]) => issues.map(i => `${i.line !== undefined ? `${i.line}:${i.column} ` : ''}${i.path || '/'} ${i.code}: ${i.message}`).join('\n')

const apply = async (options: Options) => {
  const file = (options.file as string | undefined) ?? 'stationly.yaml'
  const text = await readManifest(file)
  const run = await connect(options)
  const project = run.selection.project ?? projectOf(text)
  if (!project) throw usage('No project is selected and the Manifest names none.', 'Pass --project, or set project in the Manifest.')
  const sent = await send(
    run.api.v1.projects({ project }).manifest.apply.post({
      manifest: text,
      environment: run.selection.environment,
      plan: Boolean(options.plan),
      prune: Boolean(options.prune),
      allow_unresolved: options.allowUnresolved as boolean | undefined
    })
  )
  return print(options, sent, renderPlan)
}

const applyOptions = (command: Command) =>
  command
    .option('-f, --file <file>', 'the Manifest', 'stationly.yaml')
    .option('--plan', 'show the diff and write nothing')
    .option('--prune', 'remove entities that a managed collection does not list')
    .option('--no-allow-unresolved', 'fail on references whose target does not exist yet')
    .action(action(apply))

const exportManifest = async (run: Run, project: string, environment: string | undefined) => {
  const response = await run.raw(`/v1/projects/${encodeURIComponent(project)}/manifest${environment ? `?environment=${encodeURIComponent(environment)}` : ''}`, { headers: { accept: 'text/yaml' } })
  const text = await response.text()
  if (!response.ok) throw apiFailure(response.status, JSON.parse(text))
  return text
}

export const manifestCommands = (program: Command) => {
  applyOptions(program.command('apply').description('Plan or apply a Manifest (alias of sly manifest apply)'))
  const manifest = program.command('manifest').description('The Manifest: stationly.yaml')
  applyOptions(manifest.command('apply').description('Plan or apply a Manifest against one environment'))
  manifest
    .command('export')
    .description('Write the current configuration as a canonical Manifest')
    .option('-o, --output <file>', 'write to a file instead of stdout')
    .action(
      action(async options => {
        const run = await connect(options)
        const project = run.selection.project ?? (await readFile('stationly.yaml', 'utf8').then(projectOf, () => undefined))
        if (!project) throw usage('No project is selected.', 'Pass --project <id or name>.')
        if (options.json) return print(options, await send(run.api.v1.projects({ project }).manifest.get({ query: { environment: run.selection.environment }, headers: { accept: 'application/json' } })))
        const text = await exportManifest(run, project, run.selection.environment)
        if (options.output) {
          await writeFile(options.output as string, text)
          progress(`wrote ${options.output}`)
        } else process.stdout.write(text)
        return exitCodes.ok
      })
    )
  manifest
    .command('validate')
    .description('Check a Manifest: the bundled schema, then the instance for the semantic pass')
    .option('-f, --file <file>', 'the Manifest', 'stationly.yaml')
    .option('--offline', 'run only the schema pass')
    .action(
      action(async options => {
        const text = await readManifest(options.file as string)
        const local = validateSchema(text)
        if (local.issues.length || options.offline) {
          if (options.json) process.stdout.write(`${JSON.stringify({ valid: local.issues.length === 0, issues: local.issues, warnings: [] }, null, 2)}\n`)
          else process.stdout.write(local.issues.length ? `${renderIssues(local.issues)}\n${local.issues.length} problems\n` : 'valid (schema pass)\n')
          return local.issues.length ? exitCodes.api : exitCodes.ok
        }
        const run = await connect(options)
        const result = await body<{ valid: boolean; issues: Issue[]; warnings: { code: string; explanation: string }[] }>(run.api.v1.manifest.validate.post({ manifest: text, environment: run.selection.environment }))
        if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
        else {
          if (result.issues.length) process.stdout.write(`${renderIssues(result.issues)}\n`)
          for (const w of result.warnings) process.stdout.write(`warning ${w.code}: ${w.explanation}\n`)
          process.stdout.write(result.valid ? 'valid\n' : `${result.issues.length} problems\n`)
        }
        return result.valid ? exitCodes.ok : exitCodes.api
      })
    )

  const github = program.command('github').description('The GitHub App connection')
  github
    .command('status')
    .description('Connected Apps and installations, with the links a human opens to connect or install')
    .option('--refresh', 'read every installation from GitHub first')
    .action(
      action(async options => {
        const run = await connect(options)
        if (options.refresh) await send(run.api.v1.github.installations.sync.post())
        return print(options, await send(run.api.v1.github.get()))
      })
    )
}
