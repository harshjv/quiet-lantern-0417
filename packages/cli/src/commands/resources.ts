import { readFileSync } from 'node:fs'

import type { Command, OptionValues } from '@commander-js/extra-typings'

import { action, call, collect, integer, parseJson, seconds, type Program } from '../command.ts'
import { exitCodes, usage } from '../errors.ts'
import {
  connect,
  environmentId,
  projectRef,
  send,
  serviceId,
  settle,
  type Api,
  type Data,
  type Globals,
  type Run,
  type Sent,
} from '../kit.ts'
import { pollUntil } from '../outage.ts'
import { human, print, progress } from '../output.ts'
import { need } from '../prompt.ts'

const list = <A extends unknown[], O extends OptionValues, G extends OptionValues>(
  command: Command<A, O, G>,
) =>
  command
    .option('--limit <n>', 'page size (max 200)', integer)
    .option('--cursor <cursor>', 'next_cursor from the previous page')
    .option('--fields <fields>', 'fields beyond the summary, or *')

const page = ({ limit, cursor, fields }: { limit?: number; cursor?: string; fields?: string }) => ({
  limit,
  cursor,
  fields,
})

type ServiceFields = NonNullable<Parameters<ReturnType<Api['services']>['patch']>[0]>

type ServiceCreate = Parameters<ReturnType<Api['environments']>['services']['post']>[0]

const serviceFlags = <A extends unknown[], O extends OptionValues, G extends OptionValues>(
  command: Command<A, O, G>,
) =>
  command
    .option('--image <ref>', 'image source')
    .option('--repo <repo>', 'repository source, for example github.com/acme/api')
    .option('--branch <branch>', 'repository branch', 'main')
    .option('--builder <builder>', 'railpack or dockerfile for repository sources', 'railpack')
    .option(
      '--port <port[/protocol]>',
      'port, repeatable; the full set of ports. protocol http or tcp: a new port defaults to http, an existing port keeps its protocol unless one is given',
      collect,
    )
    .option('--volume <mount path>', 'volume mount path, repeatable', collect)
    .option('--memory <bytes>', 'memory limit in bytes', integer)
    .option('--cpu <millis>', 'CPU limit in millicores', integer)
    .option('--station <station id>', 'station to place the service on')
    .option('--command <arg>', 'command argument, repeatable', collect)
    .option('--body <json>', 'extra fields of the request body as a JSON object, or @file')

type ServiceFlags = ReturnType<ReturnType<typeof serviceFlags<[], {}, {}>>['opts']>

const serviceBody = (options: ServiceFlags) => {
  const body: Record<string, unknown> = {}
  if (options.image)
    body.source = {
      type: 'image',
      ref: options.image,
    }
  if (options.repo)
    body.source = {
      type: options.builder,
      repo: options.repo,
      branch: options.branch,
    }
  if (options.port)
    body.ports = options.port.map((spec) => {
      const [port, protocol] = spec.split('/')
      return {
        port: integer(port!),
        ...(protocol
          ? {
              protocol,
            }
          : {}),
      }
    })
  if (options.volume)
    body.volumes = options.volume.map((mount_path) => ({
      mount_path,
    }))
  if (options.memory !== undefined || options.cpu !== undefined)
    body.limits = {
      ...(options.memory !== undefined
        ? {
            memory_bytes: options.memory,
          }
        : {}),
      ...(options.cpu !== undefined
        ? {
            cpu_millis: options.cpu,
          }
        : {}),
    }
  if (options.station) body.station_id = options.station
  if (options.command) body.command = options.command
  const extra = options.body
  return {
    ...body,
    ...(extra
      ? parseJson(extra.startsWith('@') ? readFileSync(extra.slice(1), 'utf8') : extra, '--body')
      : {}),
  } as ServiceFields
}

type ServicePage = Data<ReturnType<Api['environments']>['services']['get']>

const staleCell = (reasons: ServicePage['items'][number]['stale_reasons']) =>
  reasons?.length
    ? reasons
        .map((r) =>
          `${r.code === 'VARIABLES_CHANGED' ? 'variables' : 'config'} ${r.keys.join(',')}`.trim(),
        )
        .join('; ')
    : '-'

const serviceList = ({ items, next_cursor }: ServicePage) =>
  human({
    items: items.map((s) => ({
      name: s.name,
      kind: s.kind,
      status: s.status,
      desired: s.desired_state,
      stale: staleCell(s.stale_reasons),
      id: s.id,
    })),
    next_cursor,
  })

const serviceDetail = (data: Data<ReturnType<Api['services']>['get']>) => {
  const reasons = data.stale_reasons ?? []
  return [
    human(data),
    ...(reasons.length ? ['', ...reasons.map((r) => `stale: ${r.explanation}`)] : []),
  ].join('\n')
}

export const followable = <A extends unknown[], O extends OptionValues, G extends OptionValues>(
  command: Command<A, O, G>,
) =>
  command
    .option('--wait', 'follow the deployment until it is active or failed')
    .option('--timeout <duration>', 'how long --wait follows', seconds, 600)

export type Deploying = Data<ReturnType<Api['services']>['deployments']['post']>

type Created = Sent<Deploying>

const follow = async (run: Run, sent: Created, timeoutS: number) => {
  if (sent.status === 202) return print(run.globals, sent)
  const { id } = sent.data
  if ('warnings' in sent.data)
    for (const w of sent.data.warnings ?? []) progress(`warning ${w.code}: ${w.explanation}`)
  const deadline = Date.now() + timeoutS * 1000
  const started = Date.now()
  let last = ''
  const current = await pollUntil(
    () =>
      send(
        run.api.v1
          .deployments({
            id,
          })
          .wait.get({
            query: {
              timeout_s: Math.max(0, Math.min(10, Math.ceil((deadline - Date.now()) / 1000))),
              fields: 'failure',
            },
          }),
      ),
    ({ data }) => {
      if (data.status !== last)
        progress(
          `${id}: ${(last = data.status)} (+${((Date.now() - started) / 1000).toFixed(1)} s)`,
        )
      return data.done
    },
    deadline,
  )
  const { done, ...deployment } = current.data
  const code = print(run.globals, {
    ...current,
    data: deployment,
  })
  if (deployment.status === 'failed' || deployment.status === 'cancelled') {
    progress(
      `deployment ${deployment.status}${deployment.failure?.summary ? `: ${deployment.failure.summary}` : ''}`,
    )
    if (deployment.status === 'failed') {
      const diagnosis = await settle(
        run.api.v1
          .deployments({
            id,
          })
          .diagnosis.get(),
      )
      if (diagnosis.data)
        process.stderr.write(`diagnosis:\n${JSON.stringify(diagnosis.data, null, 2)}\n`)
    }
    process.stderr.write(`${deployment.failure?.code ?? deployment.status.toUpperCase()}\n`)
    return exitCodes.deployFailed
  }
  if (!done) progress(`still ${deployment.status} after ${timeoutS} s`)
  return code
}

export const deployed = (
  run: Run,
  options: Globals & { wait?: true; timeout: number },
  sent: Created,
) => (options.wait ? follow(run, sent, options.timeout) : print(options, sent))

export const resourceCommands = (program: Program) => {
  const projects = program.command('projects').description('Projects')
  list(projects.command('list').option('--name <name>', 'filter by name')).action(
    call(async (run, options) =>
      run.api.v1.projects.get({
        query: {
          ...page(options),
          name: options.name,
        },
      }),
    ),
  )
  projects
    .command('create')
    .argument('[name]')
    .option('--default-environment <name>', 'name of the default environment (production)')
    .action(
      call(async (run, options, name) =>
        run.api.v1.projects.post({
          name: await need(name, {
            what: 'Project name',
            flag: 'the name argument',
          }),
          default_environment_name: options.defaultEnvironment,
        }),
      ),
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
      call(async (run, options) =>
        run.api.v1
          .projects({
            project: await projectRef(run),
          })
          .patch({
            default_environment_id: options.defaultEnvironmentId,
            manifest_path: options.manifestPath,
            build_cache_bytes: options.buildCacheBytes,
            image_retention_count: options.imageRetention,
            base_image_auto_rebuild: options.baseImageAutoRebuild,
          }),
      ),
    )
  projects.command('delete').action(
    call(async (run) =>
      run.api.v1
        .projects({
          project: await projectRef(run),
        })
        .delete(),
    ),
  )

  const environments = program.command('environments').description('Environments of a project')
  list(environments.command('list')).action(
    call(async (run, options) =>
      run.api.v1
        .projects({
          project: await projectRef(run),
        })
        .environments.get({
          query: page(options),
        }),
    ),
  )
  const createEnvironment = async (
    run: Run,
    options: { ephemeral?: true; ttl?: number; deploy: boolean; protected?: true },
    name: string | undefined,
    source: string | undefined,
  ) => {
    const project = await projectRef(run)
    const environment = await need(name, {
      what: 'Environment name',
      flag: 'the name argument',
    })
    if (options.ephemeral && options.ttl === undefined)
      throw usage('An ephemeral environment needs a TTL.', 'Pass --ttl, for example --ttl 24h.')
    return run.api.v1
      .projects({
        project,
      })
      .environments.post({
        name: environment,
        source_environment_id: source ? await environmentId(run, source) : undefined,
        ephemeral: options.ephemeral,
        ttl_seconds: options.ttl,
        deploy_on_create: options.deploy,
        protected: options.protected,
      })
  }
  environments
    .command('create')
    .argument('[name]')
    .option('--clone-from <environment>', 'clone this environment')
    .option('--ephemeral', 'ephemeral environment; needs --ttl')
    .option('--ttl <duration>', 'time to live, such as 24h', seconds)
    .option('--protected', 'stage every change for a human (human actor only)')
    .option('--no-deploy', 'do not deploy cloned services')
    .action(
      call(async (run, options, name) => createEnvironment(run, options, name, options.cloneFrom)),
    )
  environments
    .command('clone')
    .argument('<source>')
    .argument('[name]')
    .option('--ephemeral')
    .option('--ttl <duration>', 'time to live, such as 24h', seconds)
    .option('--no-deploy', 'do not deploy cloned services')
    .action(
      call(async (run, options, source, name) => createEnvironment(run, options, name, source)),
    )
  environments
    .command('update')
    .option('--protected', 'protect the environment (human actor only)')
    .option('--no-protected', 'remove protection (human actor only)')
    .option('--ttl <duration>', 'time to live, such as 24h', seconds)
    .action(
      call(async (run, options) =>
        run.api.v1
          .environments({
            environment: await environmentId(run),
          })
          .patch({
            protected: options.protected,
            ttl_seconds: options.ttl,
          }),
      ),
    )
  environments.command('delete').action(
    call(async (run) =>
      run.api.v1
        .environments({
          environment: await environmentId(run),
        })
        .delete(),
    ),
  )

  const services = program.command('services').description('Services of an environment')
  list(
    services
      .command('list')
      .option('--status <status>')
      .option('--kind <kind>')
      .option(
        '--stale',
        'only services whose running deployment is behind their variables or configuration',
      ),
  ).action(
    call(
      async (run, options) =>
        run.api.v1
          .environments({
            environment: await environmentId(run),
          })
          .services.get({
            query: {
              ...page(options),
              status: options.status,
              kind: options.kind,
              stale: options.stale,
            },
          }),
      serviceList,
    ),
  )
  services
    .command('describe')
    .option(
      '--fields <fields>',
      'fields beyond the summary, or *',
      'ports,volumes,domains,port_allocations,current_deployment,variables',
    )
    .action(
      call(
        async (run, options) =>
          run.api.v1
            .services({
              service: await serviceId(run),
            })
            .get({
              query: {
                fields: options.fields,
              },
            }),
        serviceDetail,
      ),
    )
  serviceFlags(
    services
      .command('create')
      .argument('[name]')
      .option('--kind <kind>', 'web, worker, cron or one_off', 'web')
      .option('--local', 'source is a local directory uploaded with sly push')
      .option(
        '--dockerfile <path>',
        'Dockerfile of a local source; without it Railpack builds the directory',
      )
      .option('--no-deploy', 'create without deploying'),
  ).action(
    call(async (run, options, name) => {
      const environment = await environmentId(run)
      const service = await need(name, {
        what: 'Service name',
        flag: 'the name argument',
      })
      if (options.dockerfile && !options.local)
        throw usage('--dockerfile applies to a local source.', 'Pass --local with --dockerfile.')
      if (options.local && (options.image || options.repo))
        throw usage('--local excludes --image and --repo.', 'Pass one source.')
      const body = {
        name: service,
        kind: options.kind,
        deploy_on_create: options.deploy,
        ...serviceBody(options),
      } as ServiceCreate
      if (options.local)
        body.source = {
          type: 'local',
          ...(options.dockerfile
            ? {
                dockerfile: options.dockerfile,
              }
            : {}),
        }
      if (!body.source)
        throw usage(
          'A service needs a source.',
          'Pass --image <ref>, --repo <repo> or --local, or source in --body.',
        )
      return run.api.v1
        .environments({
          environment,
        })
        .services.post(body)
    }),
  )
  serviceFlags(
    services.command('update').option('--no-deploy', 'store the change and mark the service stale'),
  ).action(
    call(async (run, options) =>
      run.api.v1
        .services({
          service: await serviceId(run),
        })
        .patch({
          ...(!options.deploy
            ? {
                deploy: false,
              }
            : {}),
          ...serviceBody(options),
        }),
    ),
  )
  for (const [name, request] of [
    [
      'delete',
      (run: Run, service: string) =>
        run.api.v1
          .services({
            service,
          })
          .delete(),
    ],
    [
      'restart',
      (run: Run, service: string) =>
        run.api.v1
          .services({
            service,
          })
          .restart.post(),
    ],
    [
      'stop',
      (run: Run, service: string) =>
        run.api.v1
          .services({
            service,
          })
          .stop.post(),
    ],
    [
      'start',
      (run: Run, service: string) =>
        run.api.v1
          .services({
            service,
          })
          .start.post(),
    ],
  ] as const) {
    services.command(name).action(call(async (run) => request(run, await serviceId(run))))
  }

  followable(
    program
      .command('deploy')
      .description('Deploy the selected service')
      .option('--sha <ref>', 'source sha, branch or tag')
      .option('--image <ref>', 'image reference for image sources')
      .option('--supersede', 'cancel an in-flight deployment that has not reached cutover'),
  ).action(
    action(async (options) => {
      const run = await connect(options)
      const service = await serviceId(run)
      return deployed(
        run,
        options,
        await send(
          run.api.v1
            .services({
              service,
            })
            .deployments.post({
              source_ref: options.sha,
              image: options.image,
              supersede: options.supersede,
            }),
        ),
      )
    }),
  )

  const deployments = program.command('deployments').description('Deployments')
  list(
    deployments.command('list').option('--status <status>').option('--trigger <trigger>'),
  ).action(
    call(async (run, options) => {
      const query = {
        ...page(options),
        status: options.status,
        trigger: options.trigger,
      }
      if (run.selection.service)
        return run.api.v1
          .services({
            service: await serviceId(run),
          })
          .deployments.get({
            query,
          })
      return run.api.v1
        .environments({
          environment: await environmentId(run),
        })
        .deployments.get({
          query,
        })
    }),
  )
  deployments
    .command('describe')
    .argument('<deployment>')
    .option('--fields <fields>', 'fields beyond the summary, or *', 'steps,failure')
    .action(
      call(async (run, options, id) =>
        run.api.v1
          .deployments({
            id,
          })
          .get({
            query: {
              fields: options.fields,
            },
          }),
      ),
    )
  deployments
    .command('cancel')
    .argument('<deployment>')
    .action(
      call(async (run, _options, id) =>
        run.api.v1
          .deployments({
            id,
          })
          .cancel.post(),
      ),
    )
}
