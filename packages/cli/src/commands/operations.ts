import { isatty } from 'node:tty'

import type { Command } from '@commander-js/extra-typings'

import type { MessageBody } from '@stationly/protocol'

import { action, call, collect, group, integer, type Program } from '../command.ts'
import { Exit, exitCodes, usage } from '../errors.ts'
import {
  connect,
  environmentId,
  found,
  isId,
  isOneOf,
  projectId,
  projectRef,
  send,
  serviceId,
  sseHeaders,
  stream,
  type Api,
  type Data,
  type Globals,
  type Reply,
  type Run,
} from '../kit.ts'
import { showLine, streamLogs, type LogQuery } from '../logs.ts'
import { human, print, progress } from '../output.ts'
import { uploadSource } from '../push.ts'
import { reportRun, waitRun } from '../runs.ts'
import { attachRun, shellExit } from '../sockets.ts'
import { followSse, readSse } from '../sse.ts'

import { deployed, followable, type Deploying } from './resources.ts'

const deploymentId = async (run: Run, ref: string) => {
  if (isId('deployment', ref)) return ref
  if (!/^\d+$/.test(ref))
    throw usage(
      `${ref} is not a deployment id or number.`,
      'Pass dep_... or the deployment number shown by sly deployments list.',
    )
  const list = await send(
    run.api.v1
      .services({
        service: await serviceId(run),
      })
      .deployments.get({
        query: {
          limit: 200,
        },
      }),
  )
  return found(
    list.data.items,
    (d) => d.number === Number(ref),
    `The service has no deployment ${ref} among its last 200.`,
    'Run sly deployments list.',
  ).id
}

const deployWith = <
  A extends unknown[],
  O extends { wait?: true; timeout: number },
  G extends Globals,
>(
  command: Command<A, O, G>,
  request: (
    run: Run,
    service: string,
    options: O & G,
    ...args: A
  ) => Promise<
    Extract<Reply, { data: null }> | (Extract<Reply, { error: null }> & { data: Deploying })
  >,
) =>
  command.action(
    action(async (options, ...args) => {
      const run = await connect(options)
      return deployed(
        run,
        options,
        await send(request(run, await serviceId(run), options, ...args)),
      )
    }),
  )

const roles = ['service', 'coupler', 'guard'] as const

type EventRow = Data<Api['events']['get']>['items'][number]

export const operationCommands = (program: Program) => {
  deployWith(
    followable(
      program
        .command('redeploy')
        .description("Redeploy the current deployment's image with current variables"),
    ).option('--supersede', 'cancel an in-flight deployment before cutover'),
    (run, service, options) =>
      run.api.v1
        .services({
          service,
        })
        .redeploy.post({
          supersede: options.supersede,
        }),
  )

  deployWith(
    followable(
      program
        .command('rollback')
        .description('Roll back to a previous deployment (default: the last superseded one)'),
    )
      .argument('[deployment]', 'dep_... or deployment number')
      .option(
        '--confirm-stale-secrets',
        'roll back even though pinned secret versions are older than the heads',
      ),
    async (run, service, options, ref) =>
      run.api.v1
        .services({
          service,
        })
        .rollback.post({
          deployment_id: ref ? await deploymentId(run, ref) : undefined,
          confirm_stale_secrets: options.confirmStaleSecrets,
        }),
  )

  deployWith(
    followable(
      group(program, 'services')
        .command('rebuild')
        .description('Rebuild from the same source and deploy'),
    ).option('--supersede', 'cancel an in-flight deployment before cutover'),
    (run, service, options) =>
      run.api.v1
        .services({
          service,
        })
        .rebuild.post({
          supersede: options.supersede,
        }),
  )

  group(program, 'deployments')
    .command('diagnosis')
    .argument('<deployment>', 'dep_... or deployment number')
    .description('The diagnosis object of a failed deployment')
    .action(
      call(async (run, _options, ref) =>
        run.api.v1
          .deployments({
            id: await deploymentId(run, ref),
          })
          .diagnosis.get(),
      ),
    )

  const builds = program.command('builds').description('Builds of a service')
  builds
    .command('list')
    .option('--status <status>')
    .option('--limit <n>', 'page size', integer)
    .action(
      call(async (run, options) =>
        run.api.v1
          .services({
            service: await serviceId(run),
          })
          .builds.get({
            query: {
              status: options.status,
              limit: options.limit,
            },
          }),
      ),
    )
  builds
    .command('describe')
    .argument('<build>')
    .action(
      call(async (run, _options, id) =>
        run.api.v1
          .builds({
            id,
          })
          .get({
            query: {
              fields: 'detail,attestations',
            },
          }),
      ),
    )

  program
    .command('logs')
    .description(
      'Logs of the selected service, a deployment, its build, a run, or a platform component',
    )
    .option('--build', 'build logs (of --deployment, or the latest build)')
    .option('--role <role>', 'runtime lines of one container of the set: service, coupler or guard')
    .option(
      '--component <component>',
      'platform component logs: stationd, depot, gateway or buildkit',
    )
    .option(
      '--station <station>',
      'with --component: the station to read (default the one hosting Dispatch)',
    )
    .option('--runtime', 'runtime logs (default)')
    .option('--deployment <n>', 'dep_... or deployment number')
    .option('--run <run>', 'a run id')
    .option('--since <time>', 'RFC 3339 or relative such as 10m or -1h')
    .option('--until <time>', 'RFC 3339 or relative')
    .option('--tail <n>', 'last N lines (default 50, max 5000)', integer)
    .option('--grep <text>', 'case-insensitive substring, or re:<regexp>')
    .option('--level <level>', 'minimum parsed level')
    .option('--cursor <cursor>', 'next_cursor from a previous page')
    .option('-f, --follow', 'stream new lines')
    .action(
      action(async (options) => {
        const run = await connect(options)
        let selector: LogQuery
        const { role } = options
        if (role !== undefined && !isOneOf(roles, role))
          throw usage(`--role ${role} is not service, coupler or guard.`, 'sly logs --role coupler')
        if (role && (options.run || options.build || options.component))
          throw usage(
            '--role narrows runtime logs only.',
            'Pass --role with the selected service or --deployment.',
          )
        if (options.component)
          selector = {
            component: options.component as LogQuery['component'],
            ...(options.station
              ? {
                  station: options.station,
                }
              : {}),
          }
        else if (options.run)
          selector = {
            run: options.run,
          }
        else if (options.build) {
          if (options.deployment) {
            const dep = (
              await send(
                run.api.v1
                  .deployments({
                    id: await deploymentId(run, options.deployment),
                  })
                  .get({
                    query: {
                      fields: 'build',
                    },
                  }),
              )
            ).data
            if (!dep.build)
              throw usage('That deployment has no build.', 'Pick a deployment of a source service.')
            selector = {
              build: dep.build.id,
            }
          } else {
            const latest = (
              await send(
                run.api.v1
                  .services({
                    service: await serviceId(run),
                  })
                  .builds.get({
                    query: {
                      limit: 1,
                    },
                  }),
              )
            ).data.items[0]
            if (!latest) throw usage('The service has no builds.', 'Deploy a source service first.')
            selector = {
              build: latest.id,
            }
          }
        } else if (options.deployment)
          selector = {
            deployment: await deploymentId(run, options.deployment),
            ...(role
              ? {
                  role,
                }
              : {}),
          }
        else
          selector = {
            service: await serviceId(run),
            ...(role
              ? {
                  role,
                }
              : {}),
          }
        const query = {
          ...selector,
          since: options.since,
          until: options.until,
          tail: options.tail,
          grep: options.grep,
          level: options.level,
          cursor: options.cursor,
        }
        if (options.follow) return streamLogs(run, options, query)
        const page = (
          await send(
            run.api.v1.logs.get({
              query,
            }),
          )
        ).data
        for (const line of page.untrusted.lines) showLine(options, line)
        if (!options.json && page.next_cursor) progress(`next: --cursor ${page.next_cursor}`)
        if (page.truncated)
          progress('the cursor pointed at a deleted segment; reading started at the oldest line')
        return exitCodes.ok
      }),
    )

  program
    .command('metrics')
    .description(
      'Live metrics of the selected service, or of every running service in the environment with --watch',
    )
    .option('--watch', 'stream a sample every 5 s')
    .action(
      action(async (options) => {
        const run = await connect(options)
        if (!options.watch)
          return print(
            options,
            await send(
              run.api.v1
                .services({
                  service: await serviceId(run),
                })
                .metrics.get(),
            ),
          )
        const environment = await environmentId(run)
        const only = run.selection.service ? await serviceId(run) : null
        const response = await stream(
          run.api.v1
            .environments({
              environment,
            })
            .metrics.get({
              headers: {
                accept: 'text/event-stream',
              },
            }),
        )
        for await (const event of readSse(response)) {
          if (event.event !== 'metrics') continue
          const sample = JSON.parse(
            event.data,
          ) as MessageBody<'metrics.sample.result'>['samples'][number]
          if (only && sample.service_id !== only) continue
          process.stdout.write(
            options.json
              ? `${event.data}\n`
              : `${sample.at} ${sample.service_id} cpu ${sample.cpu_pct.toFixed(2)}% mem ${sample.memory_bytes}/${sample.memory_limit_bytes} net rx ${sample.net_rx_bps} B/s tx ${sample.net_tx_bps} B/s blk r ${sample.blk_read_bps} w ${sample.blk_write_bps} restarts ${sample.restarts}\n`,
          )
        }
        return exitCodes.ok
      }),
    )

  program
    .command('run')
    .description(
      "Run a one-off command in the service's image and variables; put the command after --",
    )
    .argument('<command...>')
    .option('--detach', 'return once the run is created')
    .action(
      action(async (options, command) => {
        const run = await connect(options)
        const service = await serviceId(run)
        const sent = await send(
          run.api.v1
            .services({
              service,
            })
            .runs.post({
              command,
              wait_s: 0,
            }),
        )
        if (sent.status === 202 || options.detach) return print(options, sent)
        const created = sent.data
        progress(`${created.id}: ${created.status}`)
        await streamLogs(
          run,
          {
            ...options,
            json: false,
          },
          {
            run: created.id,
            tail: 5000,
          },
          options.json ? process.stderr : process.stdout,
        ).catch((error) => {
          progress(`log stream unavailable: ${(error as Error).message}`)
        })
        return reportRun(options, await waitRun(run, created.id))
      }),
    )

  const runs = program.command('runs').description('Runs of a service')
  runs
    .command('list')
    .option('--kind <kind>')
    .option('--status <status>')
    .option('--limit <n>', 'page size', integer)
    .action(
      call(async (run, options) =>
        run.api.v1
          .services({
            service: await serviceId(run),
          })
          .runs.get({
            query: {
              kind: options.kind,
              status: options.status,
              limit: options.limit,
            },
          }),
      ),
    )
  runs
    .command('describe')
    .argument('<run>')
    .action(
      call(async (run, _options, id) =>
        run.api.v1
          .runs({
            id,
          })
          .get({
            query: {
              fields: 'failure',
            },
          }),
      ),
    )
  runs
    .command('cancel')
    .argument('<run>')
    .action(
      call(async (run, _options, id) =>
        run.api.v1
          .runs({
            id,
          })
          .cancel.post(),
      ),
    )

  program
    .command('shell')
    .description(
      'Interactive shell in a fresh run of the service; a human actor is required in protected environments',
    )
    .option('--command <arg>', 'command argument, repeatable (default /bin/sh)', collect)
    .option('--no-tty', 'no terminal, for scripted input')
    .action(
      action(async (options) => {
        const run = await connect(options)
        const service = await serviceId(run)
        const tty = options.tty && isatty(0)
        const created = (
          await send(
            run.api.v1
              .services({
                service,
              })
              .shells.post({
                command: options.command,
                tty,
              }),
          )
        ).data
        return shellExit(
          created.id,
          await attachRun(run, created, {
            tty,
            stdin: true,
            json: false,
          }),
        )
      }),
    )

  followable(
    program
      .command('push')
      .description(
        'Upload a local directory (honoring .dockerignore) as the service source and deploy it',
      )
      .argument('[path]', 'directory to push', '.')
      .option('--via <transport>', 'ssh lands the tarball on the station directly'),
  ).action(
    action(async (options, path) => {
      if (options.via === 'ssh')
        throw new Exit(exitCodes.usage, {
          error: {
            code: 'VALIDATION_FAILED',
            explanation:
              'sly push --via ssh is not available in this release; the HTTPS upload to the API host is the supported transport.',
            fix: 'Run sly push without --via against a directly reachable API host.',
          },
        })
      const run = await connect(options)
      const service = await serviceId(run)
      const blob = (await send(uploadSource(run, service, path, progress))).data
      return deployed(
        run,
        options,
        await send(
          run.api.v1
            .services({
              service,
            })
            .deployments.post({
              blob_id: blob.blob_id,
            }),
        ),
      )
    }),
  )

  program
    .command('events')
    .description('Events visible to you; -f follows the stream and resumes after --since')
    .option('--since <event id>', 'resume after this event id')
    .option('--types <types>', 'comma list, prefixes with *')
    .option('--limit <n>', 'page size', integer)
    .option('--fields <fields>', 'fields beyond the summary, such as delivered')
    .option('-f, --follow', 'stream events')
    .action(
      action(async (options) => {
        const run = await connect(options)
        const filter = {
          since: options.since,
          types: options.types,
          project:
            run.selection.project && !run.selection.service
              ? await projectId(run, await projectRef(run))
              : undefined,
          service: run.selection.service ? await serviceId(run) : undefined,
          limit: options.limit,
          fields: options.fields,
        }
        if (!options.follow) {
          const sent = await send(
            run.api.v1.events.get({
              query: filter,
            }),
          )
          if (options.json) return print(options, sent)
          process.stdout.write(`${human(sent.data)}\n`)
          if (sent.data.next_since) progress(`resume: --since ${sent.data.next_since}`)
          return exitCodes.ok
        }
        const resumeFrom =
          filter.since ??
          (
            await send(
              run.api.v1.events.get({
                query: {
                  limit: 1,
                },
              }),
            )
          ).data.next_since
        let opened = false
        return followSse(
          (lastId) => {
            const headers = sseHeaders(lastId ?? (opened ? resumeFrom : null))
            opened = true
            return stream(
              run.api.v1.events.get({
                query: filter,
                headers,
              }),
            )
          },
          (event) => {
            const row = JSON.parse(event.data) as EventRow
            process.stdout.write(
              options.json
                ? `${event.data}\n`
                : `${row.created_at} ${row.id} ${row.type} ${row.subject.entity}:${row.subject.id} ${JSON.stringify(row.payload)}\n`,
            )
            return undefined
          },
        )
      }),
    )

  const notifications = program
    .command('notifications')
    .description('Notification channels (webhooks in 1a)')
  notifications.command('list').action(
    call(async (run) =>
      run.api.v1['notification-channels'].get({
        query: {
          fields: 'config',
        },
      }),
    ),
  )
  notifications
    .command('add')
    .option('--url <url>', 'webhook URL')
    .option('--secret <secret>', 'HMAC secret (generated and shown once when omitted)')
    .option('--types <types>', 'comma list of event types, prefixes with *')
    .option('--projects <ids>', 'comma list of project ids')
    .option('--channel <channel>', 'update this channel instead of adding one')
    .action(
      call(async (run, options) => {
        const split = (v: string | undefined) =>
          v
            ?.split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        const filter =
          options.types || options.projects
            ? {
                types: split(options.types),
                projects: split(options.projects),
              }
            : undefined
        const config = {
          url: options.url,
          secret: options.secret,
        }
        if (options.channel)
          return run.api.v1['notification-channels']({
            id: options.channel,
          }).patch({
            config,
            filter,
          })
        if (!config.url) throw usage('A webhook needs --url.', 'Pass --url https://...')
        return run.api.v1['notification-channels'].post({
          kind: 'webhook',
          config: {
            url: config.url,
            secret: config.secret,
          },
          filter,
        })
      }),
    )
  notifications
    .command('test')
    .argument('<channel>')
    .action(
      call(async (run, _options, id) =>
        run.api.v1['notification-channels']({
          id,
        }).test.post(),
      ),
    )
  notifications
    .command('remove')
    .argument('<channel>')
    .action(
      call(async (run, _options, id) =>
        run.api.v1['notification-channels']({
          id,
        }).delete(),
      ),
    )

  group(program, 'stations')
    .command('remove')
    .argument('<station>')
    .description(
      'Remove a station with no services; it is told STATION_REVOKED on its next connection',
    )
    .action(
      call(async (run, _options, station) =>
        run.api.v1
          .stations({
            station,
          })
          .delete(),
      ),
    )
}
