import { readFileSync } from 'node:fs'
import type { Command } from 'commander'
import { action, collect, integer, parseJson, seconds, type Options } from '../command.ts'
import { exitCodes, usage } from '../errors.ts'
import { connect, environmentId, projectRef, send, serviceId, type Run, type Sent } from '../kit.ts'
import { acrossOutage } from '../outage.ts'
import { human, print, progress } from '../output.ts'
import { need } from '../prompt.ts'

const list = (command: Command) =>
  command
    .option('--limit <n>', 'page size (max 200)', integer)
    .option('--cursor <cursor>', 'next_cursor from the previous page')
    .option('--fields <fields>', 'fields beyond the summary, or *')

const page = (options: Options) => ({ limit: options.limit as number | undefined, cursor: options.cursor as string | undefined, fields: options.fields as string | undefined })

const tri = (options: Options, key: string) => (options[key] === undefined ? undefined : Boolean(options[key]))

type ServiceBody = Record<string, unknown>

const serviceFlags = (command: Command) =>
  command
    .option('--image <ref>', 'image source')
    .option('--repo <repo>', 'repository source, for example github.com/acme/api')
    .option('--branch <branch>', 'repository branch', 'main')
    .option('--builder <builder>', 'railpack or dockerfile for repository sources', 'railpack')
    .option('--port <port[/protocol]>', 'port, repeatable; the full set of ports. protocol http or tcp: a new port defaults to http, an existing port keeps its protocol unless one is given', collect)
    .option('--volume <mount path>', 'volume mount path, repeatable', collect)
    .option('--memory <bytes>', 'memory limit in bytes', integer)
    .option('--cpu <millis>', 'CPU limit in millicores', integer)
    .option('--station <station id>', 'station to place the service on')
    .option('--command <arg>', 'command argument, repeatable', collect)
    .option('--body <json>', 'extra fields of the request body as a JSON object, or @file')

const serviceBody = (options: Options): ServiceBody => {
  const body: ServiceBody = {}
  if (options.image) body.source = { type: 'image', ref: options.image }
  if (options.repo) body.source = { type: options.builder, repo: options.repo, branch: options.branch }
  if (options.port)
    body.ports = (options.port as string[]).map(spec => {
      const [port, protocol] = spec.split('/')
      return { port: integer(port!), ...(protocol ? { protocol } : {}) }
    })
  if (options.volume) body.volumes = (options.volume as string[]).map(mount_path => ({ mount_path }))
  if (options.memory !== undefined || options.cpu !== undefined) body.limits = { ...(options.memory !== undefined ? { memory_bytes: options.memory } : {}), ...(options.cpu !== undefined ? { cpu_millis: options.cpu } : {}) }
  if (options.station) body.station_id = options.station
  if (options.command) body.command = options.command
  const extra = options.body as string | undefined
  return { ...body, ...(extra ? parseJson(extra.startsWith('@') ? readFileSync(extra.slice(1), 'utf8') : extra, '--body') : {}) }
}

type StaleReason = { code: string; explanation: string; keys: string[] }
type ServiceSummary = { id: string; name: string; kind: string; status: string; desired_state: string; stale?: boolean; stale_reasons?: StaleReason[] }

const staleCell = (reasons: StaleReason[] | undefined) =>
  reasons?.length ? reasons.map(r => `${r.code === 'VARIABLES_CHANGED' ? 'variables' : 'config'} ${r.keys.join(',')}`.trim()).join('; ') : '-'

const serviceList = (data: unknown) => {
  const { items, next_cursor } = data as { items: ServiceSummary[]; next_cursor?: string | null }
  return human({ items: items.map(s => ({ name: s.name, kind: s.kind, status: s.status, desired: s.desired_state, stale: staleCell(s.stale_reasons), id: s.id })), next_cursor })
}

const serviceDetail = (data: unknown) => {
  const reasons = (data as ServiceSummary).stale_reasons ?? []
  return [human(data), ...(reasons.length ? ['', ...reasons.map(r => `stale: ${r.explanation}`)] : [])].join('\n')
}

type Deployment = { id: string; status: string; done?: boolean; failure?: { code?: string; summary?: string } | null }

export const follow = async (run: Run, sent: Sent, timeoutS: number) => {
  if (sent.status === 202) return print(run.globals, sent)
  const id = (sent.data as Deployment).id
  for (const w of (sent.data as { warnings?: { code: string; explanation: string }[] }).warnings ?? []) progress(`warning ${w.code}: ${w.explanation}`)
  const deadline = Date.now() + timeoutS * 1000
  const started = Date.now()
  let last = ''
  let current = sent
  for (;;) {
    current = await acrossOutage(() => {
      const remaining = Math.max(0, Math.min(10, Math.ceil((deadline - Date.now()) / 1000)))
      return send(run.api.v1.deployments({ id }).wait.get({ query: { timeout_s: remaining, fields: 'failure' } }))
    }, deadline)
    const deployment = current.data as Deployment
    if (deployment.status !== last) progress(`${id}: ${(last = deployment.status)} (+${((Date.now() - started) / 1000).toFixed(1)} s)`)
    if (deployment.done || Date.now() >= deadline) break
  }
  const { done, ...deployment } = current.data as Deployment
  const code = print(run.globals, { ...current, data: deployment })
  if (deployment.status === 'failed' || deployment.status === 'cancelled') {
    progress(`deployment ${deployment.status}${deployment.failure?.summary ? `: ${deployment.failure.summary}` : ''}`)
    if (deployment.status === 'failed') {
      const diagnosis = await run.raw(`/v1/deployments/${id}/diagnosis`)
      if (diagnosis.ok) process.stderr.write(`diagnosis:\n${JSON.stringify(await diagnosis.json(), null, 2)}\n`)
    }
    process.stderr.write(`${deployment.failure?.code ?? deployment.status.toUpperCase()}\n`)
    return exitCodes.deployFailed
  }
  if (!done) progress(`still ${deployment.status} after ${timeoutS} s`)
  return code
}

export const resourceCommands = (program: Command) => {
  const projects = program.command('projects').description('Projects')
  list(projects.command('list').option('--name <name>', 'filter by name')).action(
    action(async options => {
      const run = await connect(options)
      return print(options, await send(run.api.v1.projects.get({ query: { ...page(options), name: options.name as string | undefined } })))
    })
  )
  projects
    .command('create')
    .argument('[name]')
    .option('--default-environment <name>', 'name of the default environment (production)')
    .action(
      action(async (options, name) => {
        const run = await connect(options)
        const project = await need(name, { what: 'Project name', flag: 'the name argument' })
        return print(options, await send(run.api.v1.projects.post({ name: project, default_environment_name: options.defaultEnvironment as string | undefined })))
      })
    )
  projects
    .command('update')
    .option('--default-environment-id <id>')
    .option('--manifest-path <path>')
    .option('--build-cache-bytes <bytes>', 'build cache size', integer)
    .option('--image-retention <n>', 'images kept per service', integer)
    .option('--base-image-auto-rebuild')
    .option('--no-base-image-auto-rebuild')
    .action(
      action(async options => {
        const run = await connect(options)
        const project = await projectRef(run)
        return print(
          options,
          await send(
            run.api.v1.projects({ project }).patch({
              default_environment_id: options.defaultEnvironmentId as string | undefined,
              manifest_path: options.manifestPath as string | undefined,
              build_cache_bytes: options.buildCacheBytes as number | undefined,
              image_retention_count: options.imageRetention as number | undefined,
              base_image_auto_rebuild: tri(options, 'baseImageAutoRebuild')
            })
          )
        )
      })
    )
  projects.command('delete').action(
    action(async options => {
      const run = await connect(options)
      return print(options, await send(run.api.v1.projects({ project: await projectRef(run) }).delete()))
    })
  )

  const environments = program.command('environments').description('Environments of a project')
  list(environments.command('list')).action(
    action(async options => {
      const run = await connect(options)
      return print(options, await send(run.api.v1.projects({ project: await projectRef(run) }).environments.get({ query: page(options) })))
    })
  )
  const createEnvironment = async (options: Options, name: string | undefined, source: string | undefined) => {
    const run = await connect(options)
    const project = await projectRef(run)
    const environment = await need(name, { what: 'Environment name', flag: 'the name argument' })
    if (options.ephemeral && options.ttl === undefined) throw usage('An ephemeral environment needs a TTL.', 'Pass --ttl, for example --ttl 24h.')
    return print(
      options,
      await send(
        run.api.v1.projects({ project }).environments.post({
          name: environment,
          source_environment_id: source ? await environmentId(run, source) : undefined,
          ephemeral: options.ephemeral as boolean | undefined,
          ttl_seconds: options.ttl as number | undefined,
          deploy_on_create: options.deploy as boolean | undefined,
          protected: options.protected as boolean | undefined
        })
      )
    )
  }
  environments
    .command('create')
    .argument('[name]')
    .option('--clone-from <environment>', 'clone this environment')
    .option('--ephemeral', 'ephemeral environment; needs --ttl')
    .option('--ttl <duration>', 'time to live, such as 24h', seconds)
    .option('--protected', 'stage every change for a human (human actor only)')
    .option('--no-deploy', 'do not deploy cloned services')
    .action(action(async (options, name) => createEnvironment(options, name, options.cloneFrom as string | undefined)))
  environments
    .command('clone')
    .argument('<source>')
    .argument('[name]')
    .option('--ephemeral')
    .option('--ttl <duration>', 'time to live, such as 24h', seconds)
    .option('--no-deploy', 'do not deploy cloned services')
    .action(action(async (options, source, name) => createEnvironment(options, name, source)))
  environments
    .command('update')
    .option('--protected', 'protect the environment (human actor only)')
    .option('--no-protected', 'remove protection (human actor only)')
    .option('--ttl <duration>', 'time to live, such as 24h', seconds)
    .action(
      action(async options => {
        const run = await connect(options)
        const environment = await environmentId(run)
        return print(options, await send(run.api.v1.environments({ environment }).patch({ protected: tri(options, 'protected'), ttl_seconds: options.ttl as number | undefined })))
      })
    )
  environments.command('delete').action(
    action(async options => {
      const run = await connect(options)
      return print(options, await send(run.api.v1.environments({ environment: await environmentId(run) }).delete()))
    })
  )

  const services = program.command('services').description('Services of an environment')
  list(services.command('list').option('--status <status>').option('--kind <kind>').option('--stale', 'only services whose running deployment is behind their variables or configuration')).action(
    action(async options => {
      const run = await connect(options)
      const environment = await environmentId(run)
      return print(options, await send(run.api.v1.environments({ environment }).services.get({ query: { ...page(options), status: options.status as string | undefined, kind: options.kind as string | undefined, stale: options.stale ? true : undefined } })), serviceList)
    })
  )
  services
    .command('describe')
    .option('--fields <fields>', 'fields beyond the summary, or *', 'ports,volumes,domains,port_allocations,current_deployment,variables')
    .action(
      action(async options => {
        const run = await connect(options)
        return print(options, await send(run.api.v1.services({ service: await serviceId(run) }).get({ query: { fields: options.fields as string } })), serviceDetail)
      })
    )
  serviceFlags(
    services
      .command('create')
      .argument('[name]')
      .option('--kind <kind>', 'web, worker, cron or one_off', 'web')
      .option('--local', 'source is a local directory uploaded with sly push')
      .option('--dockerfile <path>', 'Dockerfile of a local source; without it Railpack builds the directory')
      .option('--no-deploy', 'create without deploying')
  ).action(
    action(async (options, name) => {
      const run = await connect(options)
      const environment = await environmentId(run)
      const service = await need(name, { what: 'Service name', flag: 'the name argument' })
      if (options.dockerfile && !options.local) throw usage('--dockerfile applies to a local source.', 'Pass --local with --dockerfile.')
      if (options.local && (options.image || options.repo)) throw usage('--local excludes --image and --repo.', 'Pass one source.')
      const body: ServiceBody = { name: service, kind: options.kind, deploy_on_create: options.deploy, ...serviceBody(options) }
      if (options.local) body.source = { type: 'local', ...(options.dockerfile ? { dockerfile: options.dockerfile } : {}) }
      if (!body.source) throw usage('A service needs a source.', 'Pass --image <ref>, --repo <repo> or --local, or source in --body.')
      return print(options, await send(run.api.v1.environments({ environment }).services.post(body as never)))
    })
  )
  serviceFlags(services.command('update').option('--no-deploy', 'store the change and mark the service stale')).action(
    action(async options => {
      const run = await connect(options)
      const service = await serviceId(run)
      const body = { ...(options.deploy === false ? { deploy: false } : {}), ...serviceBody(options) }
      return print(options, await send(run.api.v1.services({ service }).patch(body as never)))
    })
  )
  for (const [name, call] of [
    ['delete', (run: Run, service: string) => run.api.v1.services({ service }).delete()],
    ['restart', (run: Run, service: string) => run.api.v1.services({ service }).restart.post()],
    ['stop', (run: Run, service: string) => run.api.v1.services({ service }).stop.post()],
    ['start', (run: Run, service: string) => run.api.v1.services({ service }).start.post()]
  ] as const) {
    services.command(name).action(
      action(async options => {
        const run = await connect(options)
        return print(options, await send(call(run, await serviceId(run))))
      })
    )
  }

  program
    .command('deploy')
    .description('Deploy the selected service')
    .option('--sha <ref>', 'source sha, branch or tag')
    .option('--image <ref>', 'image reference for image sources')
    .option('--supersede', 'cancel an in-flight deployment that has not reached cutover')
    .option('--wait', 'follow the deployment until it is active or failed')
    .option('--timeout <duration>', 'how long --wait follows', seconds, 600)
    .action(
      action(async options => {
        const run = await connect(options)
        const service = await serviceId(run)
        const sent = await send(run.api.v1.services({ service }).deployments.post({ source_ref: options.sha as string | undefined, image: options.image as string | undefined, supersede: options.supersede as boolean | undefined }))
        return options.wait ? follow(run, sent, options.timeout as number) : print(options, sent)
      })
    )

  const deployments = program.command('deployments').description('Deployments')
  list(deployments.command('list').option('--status <status>').option('--trigger <trigger>')).action(
    action(async options => {
      const run = await connect(options)
      const query = { ...page(options), status: options.status as string | undefined, trigger: options.trigger as string | undefined }
      if (run.selection.service) return print(options, await send(run.api.v1.services({ service: await serviceId(run) }).deployments.get({ query })))
      return print(options, await send(run.api.v1.environments({ environment: await environmentId(run) }).deployments.get({ query })))
    })
  )
  deployments
    .command('describe')
    .argument('<deployment>')
    .option('--fields <fields>', 'fields beyond the summary, or *', 'steps,failure')
    .action(
      action(async (options, id) => {
        const run = await connect(options)
        return print(options, await send(run.api.v1.deployments({ id: id! }).get({ query: { fields: options.fields as string } })))
      })
    )
  deployments
    .command('cancel')
    .argument('<deployment>')
    .action(
      action(async (options, id) => {
        const run = await connect(options)
        return print(options, await send(run.api.v1.deployments({ id: id! }).cancel.post()))
      })
    )
}
