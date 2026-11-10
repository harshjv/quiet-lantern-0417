import type { Command, OptionValues } from '@commander-js/extra-typings'

import { action, call, collect, group, integer, seconds, type Program } from '../command.ts'
import { Exit, exitCodes, usage } from '../errors.ts'
import {
  connect,
  environmentId,
  found,
  isId,
  isOneOf,
  sandboxId,
  send,
  type Api,
  type Data,
  type Run,
} from '../kit.ts'
import { showLine, streamLogs } from '../logs.ts'
import { human, print, progress } from '../output.ts'
import { explanationText, probeText } from '../renderers/network.ts'
import { reportRun, waitRun } from '../runs.ts'
import { attachRun, forwardPort, shellExit } from '../sockets.ts'

import { toSet } from './variables.ts'

const units: Record<string, number> = {
  g: 1024 ** 3,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
}

export const bytesOf = (value: string, flag: string) => {
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(value.trim())
  const unit = match?.[2]?.toLowerCase() ?? ''
  if (!match || (unit !== '' && !(unit in units)))
    throw usage(
      `${value} is not a size for ${flag}.`,
      'Pass bytes, or a number with GiB or MiB such as 8GiB; a bare number below 1000000 means GiB.',
    )
  const amount = Number(match[1])
  const bytes = unit ? amount * units[unit]! : amount < 1_000_000 ? amount * units.gib! : amount
  return Math.round(bytes)
}

export const allowOf = (entry: string) => {
  const [host, portList] = entry.split(':') as [string, string | undefined]
  const wildcard = host.startsWith('*.')
  const domain = wildcard ? host.slice(2) : host
  if (!domain)
    throw usage(
      `${entry} names no domain.`,
      'Write --allow example.com, --allow *.example.com or --allow example.com:443,22.',
    )
  const ports = portList ? portList.split(',').map((p) => integer(p)) : undefined
  return {
    domain,
    wildcard,
    ...(ports
      ? {
          ports,
        }
      : {}),
  }
}

const egressOf = (options: { allow?: string[]; openEgress?: true }) => {
  const { allow } = options
  if (allow?.length && options.openEgress)
    throw usage('--allow and --open-egress contradict each other.', 'Pass one of them.')
  if (allow?.length)
    return {
      mode: 'allowlist' as const,
      domains: allow.map(allowOf),
    }
  if (options.openEgress)
    return {
      mode: 'open' as const,
    }
  return undefined
}

const sizeOf = (options: { cpu?: number; memory?: string; disk?: string }) => {
  const size = {
    ...(options.cpu !== undefined
      ? {
          cpu_millis: options.cpu,
        }
      : {}),
    ...(options.memory !== undefined
      ? {
          memory_bytes: bytesOf(options.memory, '--memory'),
        }
      : {}),
    ...(options.disk !== undefined
      ? {
          disk_bytes: bytesOf(options.disk, '--disk'),
        }
      : {}),
  }
  return Object.keys(size).length ? size : undefined
}

const snapshotId = async (run: Run, ref: string) => {
  if (isId('sandbox_snapshot', ref)) return ref
  const list = await send(
    run.api.v1
      .environments({
        environment: await environmentId(run),
      })
      ['sandbox-snapshots'].get({
        query: {
          limit: 200,
        },
      }),
  )
  return found(
    list.data.items,
    (s) => s.name === ref,
    `The environment has no snapshot named ${ref}.`,
    'Run sly sandbox snapshots.',
  ).id
}

const forkSource = async (run: Run, ref: string) => {
  if (isId('sandbox_snapshot', ref))
    return {
      snapshot: ref,
    }
  if (isId('sandbox', ref))
    return {
      sandbox: ref,
    }
  try {
    return {
      sandbox: await sandboxId(run, ref),
    }
  } catch (error) {
    if (!(error instanceof Exit) || error.envelope?.error.code !== 'NOT_FOUND') throw error
    return {
      snapshot: await snapshotId(run, ref),
    }
  }
}

const renderList = ({ items }: Data<ReturnType<Api['environments']>['sandboxes']['get']>) =>
  human({
    items: items.map((s) => ({
      name: s.name,
      status: s.status,
      image: s.image.ref ?? 'toolchain',
      size: `${s.size.cpu_millis}m ${Math.round(s.size.memory_bytes / 1024 ** 2)}MiB ${Math.round(s.size.disk_bytes / 1024 ** 3)}GiB`,
      network: s.network,
      stop_at: s.stop_at,
      delete_at: s.delete_at,
      id: s.id,
    })),
  })

const pair = (assignment: string) => {
  const at = assignment.indexOf('=')
  if (at < 1)
    throw usage(`${assignment} has no value.`, `Write ${assignment.split('=')[0]}=<value>.`)
  return [assignment.slice(0, at), assignment.slice(at + 1)] as const
}

const networks = ['isolated', 'environment'] as const

const sized = <A extends unknown[], O extends OptionValues, G extends OptionValues>(
  command: Command<A, O, G>,
) =>
  command
    .option('--cpu <millis>', 'CPU in millicores', integer)
    .option('--memory <size>', 'memory in bytes, or MiB and GiB')
    .option('--disk <size>', 'disk limit in bytes, or MiB and GiB')
    .option(
      '--allow <domain>',
      'allow egress to domain[:port,...]; *.example.com allows its subdomains; repeatable',
      collect,
    )
    .option('--ttl <duration>', 'time to live after each start, such as 2h', seconds)

export const sandboxCommands = (program: Program) => {
  const sandbox = program
    .command('sandbox')
    .description('Persistent Linux machines for agents, isolated with gVisor')

  sandbox
    .command('list')
    .description('Sandboxes of the selected environment')
    .option('--status <status>', 'comma list of statuses')
    .action(
      call(
        async (run, options) =>
          run.api.v1
            .environments({
              environment: await environmentId(run),
            })
            .sandboxes.get({
              query: {
                status: options.status,
              },
            }),
        renderList,
      ),
    )

  sandbox
    .command('describe')
    .argument('<sandbox>', 'sandbox id or name')
    .action(
      call(async (run, _options, ref) =>
        run.api.v1
          .sandboxes({
            sandbox: await sandboxId(run, ref),
          })
          .get({
            query: {
              fields: '*',
            },
          }),
      ),
    )

  sized(
    sandbox
      .command('create')
      .description('Create and start a sandbox from the toolchain image or another image')
      .argument('[name]', 'sandbox name; the API names it when omitted')
      .option('--image <ref>', 'image reference; the toolchain image when omitted')
      .option('--station <station>', 'station id or name')
      .option('--network <mode>', 'isolated or environment')
      .option('--docker', 'start dockerd inside the sandbox')
      .option('--no-start', 'create the sandbox stopped'),
  ).action(
    call(async (run, options, name) => {
      const environment = await environmentId(run)
      const { network } = options
      if (network !== undefined && !isOneOf(networks, network))
        throw usage(
          `--network ${network} is not isolated or environment.`,
          'Pass --network isolated or --network environment.',
        )
      return run.api.v1
        .environments({
          environment,
        })
        .sandboxes.post({
          name,
          image: options.image
            ? {
                ref: options.image,
              }
            : undefined,
          station_id: options.station,
          size: sizeOf(options),
          network,
          docker: options.docker,
          egress: egressOf(options),
          ttl_s: options.ttl,
          start: options.start ? undefined : false,
        })
    }),
  )

  sized(
    sandbox
      .command('fork')
      .description('Fork a sandbox or a snapshot into a new sandbox')
      .argument('<source>', 'sandbox or snapshot, by id or name')
      .argument('[name]', 'new sandbox name'),
  ).action(
    call(async (run, options, source, name) => {
      const from = await forkSource(run, source)
      return run.api.v1
        .environments({
          environment: await environmentId(run),
        })
        .sandboxes.post({
          name,
          from,
          size: sizeOf(options),
          egress: egressOf(options),
          ttl_s: options.ttl,
        })
    }),
  )

  sized(
    sandbox
      .command('update')
      .description('Change a sandbox; ttl extends from now')
      .argument('<sandbox>')
      .option('--docker', 'start dockerd inside the sandbox at its next start')
      .option('--no-docker', 'do not start dockerd')
      .option('--open-egress', 'allow every public destination'),
  ).action(
    call(async (run, options, ref) => {
      const body = {
        size: sizeOf(options),
        egress: egressOf(options),
        ttl_s: options.ttl,
        docker: options.docker,
      }
      return run.api.v1
        .sandboxes({
          sandbox: await sandboxId(run, ref),
        })
        .patch(body)
    }),
  )

  sandbox
    .command('start')
    .argument('<sandbox>')
    .option('--ttl <duration>', 'replaces the stored time to live', seconds)
    .action(
      call(async (run, options, ref) =>
        run.api.v1
          .sandboxes({
            sandbox: await sandboxId(run, ref),
          })
          .start.post({
            ttl_s: options.ttl,
          }),
      ),
    )

  sandbox
    .command('stop')
    .argument('<sandbox>')
    .action(
      call(async (run, _options, ref) =>
        run.api.v1
          .sandboxes({
            sandbox: await sandboxId(run, ref),
          })
          .stop.post(),
      ),
    )

  sandbox
    .command('delete')
    .description('Delete a sandbox and its disk; its snapshots stay')
    .argument('<sandbox>')
    .action(
      call(async (run, _options, ref) =>
        run.api.v1
          .sandboxes({
            sandbox: await sandboxId(run, ref),
          })
          .delete(),
      ),
    )

  sandbox
    .command('exec')
    .description('Run a command in a running sandbox and stream it; put the command after --')
    .argument('<sandbox>')
    .argument('<command...>')
    .option('--user <user>')
    .option('--cwd <dir>')
    .option('--env <pair>', 'KEY=VALUE for this command only; repeatable', collect)
    .option('--timeout <duration>', 'kill the command after this long', seconds)
    .option('--detach', 'create the exec and print the run without streaming')
    .action(
      action(async (options, ref, command) => {
        const run = await connect(options)
        const id = await sandboxId(run, ref)
        const detach = Boolean(options.detach)
        const created = await send(
          run.api.v1
            .sandboxes({
              sandbox: id,
            })
            .exec.post({
              command,
              user: options.user,
              cwd: options.cwd,
              env: options.env ? Object.fromEntries(options.env.map(pair)) : undefined,
              timeout_s: options.timeout,
              attach: !detach,
              wait_s: detach ? 0 : undefined,
            }),
        )
        const attach_url = 'attach_url' in created.data ? created.data.attach_url : undefined
        if (detach || !attach_url) return print(options, created)
        const exit = await attachRun(
          run,
          {
            attach_url,
          },
          {
            tty: false,
            stdin: !process.stdin.isTTY,
            json: Boolean(options.json),
          },
        )
        return exit ? reportRun(options, await waitRun(run, created.data.id)) : exitCodes.connection
      }),
    )

  sandbox
    .command('shell')
    .description(
      'Interactive shell in a running sandbox; needs a terminal and a human actor in protected environments',
    )
    .argument('<sandbox>')
    .argument('[command...]')
    .option('--user <user>')
    .option('--cwd <dir>')
    .action(
      action(async (options, ref, command) => {
        if (!process.stdin.isTTY)
          throw usage(
            'sly sandbox shell needs a terminal.',
            'Run it from an interactive terminal; agents use sly sandbox exec.',
          )
        const run = await connect(options)
        const id = await sandboxId(run, ref)
        const created = (
          await send(
            run.api.v1
              .sandboxes({
                sandbox: id,
              })
              .shells.post({
                command: command.length ? command : undefined,
                user: options.user,
                cwd: options.cwd,
              }),
          )
        ).data
        return shellExit(
          created.id,
          await attachRun(run, created, {
            tty: true,
            stdin: true,
            json: false,
          }),
        )
      }),
    )

  sandbox
    .command('snapshot')
    .description(
      "Take a snapshot of a sandbox's disk; files on the disk, credentials included, are copied into every snapshot and fork",
    )
    .argument('<sandbox>')
    .option('--name <name>')
    .action(
      call(async (run, options, ref) =>
        run.api.v1
          .sandboxes({
            sandbox: await sandboxId(run, ref),
          })
          .snapshots.post({
            name: options.name,
          }),
      ),
    )

  sandbox
    .command('snapshots')
    .argument('[sandbox]')
    .action(
      call(async (run, _options, ref) =>
        ref
          ? run.api.v1
              .sandboxes({
                sandbox: await sandboxId(run, ref),
              })
              .snapshots.get()
          : run.api.v1
              .environments({
                environment: await environmentId(run),
              })
              ['sandbox-snapshots'].get(),
      ),
    )

  sandbox
    .command('snapshot-delete')
    .argument('<snapshot>')
    .action(
      call(async (run, _options, ref) =>
        run.api.v1['sandbox-snapshots']({
          id: await snapshotId(run, ref),
        }).delete(),
      ),
    )

  sandbox
    .command('logs')
    .description('Init log of a sandbox, or its runtime log with --runtime')
    .argument('<sandbox>')
    .option('--runtime', 'the runsc log instead of the init log')
    .option('--tail <n>', 'last N lines', integer)
    .option('-f, --follow', 'stream new lines')
    .action(
      action(async (options, ref) => {
        const run = await connect(options)
        const query = {
          sandbox: await sandboxId(run, ref),
          role: options.runtime ? ('runtime' as const) : ('init' as const),
          tail: options.tail || undefined,
        }
        if (options.follow) return streamLogs(run, options, query)
        for (const line of (
          await send(
            run.api.v1.logs.get({
              query,
            }),
          )
        ).data.untrusted.lines)
          showLine(options, line)
        return exitCodes.ok
      }),
    )

  sandbox
    .command('network')
    .description('Live connections, refused attempts and the DNS log of a sandbox')
    .argument('<sandbox>')
    .option('--dns', 'the resolver log')
    .option('--refused', 'only the refused attempts')
    .action(
      action(async (options, ref) => {
        const run = await connect(options)
        const id = await sandboxId(run, ref)
        if (options.dns)
          return print(
            options,
            await send(
              run.api.v1
                .sandboxes({
                  sandbox: id,
                })
                ['dns-log'].get(),
            ),
          )
        const result = await send(
          run.api.v1
            .sandboxes({
              sandbox: id,
            })
            .connections.get(),
        )
        if (!options.refused) return print(options, result)
        const { refused } = result.data
        return print(options, {
          status: result.status,
          data: options.json
            ? refused
            : {
                items: refused,
              },
        })
      }),
    )

  sandbox
    .command('explain')
    .description(
      'Why a sandbox can or cannot reach a target, hop by hop with fixes: its allowlist, its resolver, the sandbox ruleset and, for a joined sandbox, the Switch and the target service. Sends no packet',
    )
    .argument('<sandbox>')
    .requiredOption(
      '--to <target>',
      'a service, service:port, a .internal name, ipv4:port or hostname:port',
    )
    .option('--port <port>', "port; defaults to the target's only declared port", integer)
    .option('--udp', 'judge UDP instead of TCP')
    .action(
      call(async (run, options, ref) => {
        const id = await sandboxId(run, ref)
        const box = (
          await send(
            run.api.v1
              .sandboxes({
                sandbox: id,
              })
              .get(),
          )
        ).data
        return run.api.v1
          .environments({
            environment: box.environment_id,
          })
          .network.explain.get({
            query: {
              from: id,
              to: options.to,
              protocol: options.udp ? 'udp' : 'tcp',
              port: options.port,
            },
          })
      }, explanationText),
    )

  sandbox
    .command('probe')
    .description(
      "Ask the sandbox's resolver as the sandbox, or judge one TCP handshake with the sandbox ruleset and send it from the station when the ruleset accepts the destination",
    )
    .argument('<sandbox>')
    .requiredOption(
      '--to <target>',
      'a service, a .internal name, an ipv4 address or a public hostname; host:port is accepted',
    )
    .option('--port <port>', "port; defaults to the target's only declared port", integer)
    .option('--dns', 'send only the A query to the resolver')
    .option('--timeout <seconds>', 'seconds, 1 to 10 (default 3)', integer)
    .action(
      action(async (options, ref) => {
        const { timeout } = options
        if (timeout !== undefined && (timeout < 1 || timeout > 10))
          throw usage(
            '--timeout is 1 to 10 seconds.',
            'sly sandbox probe dev --to example.com:443 --timeout 5',
          )
        const run = await connect(options)
        const id = await sandboxId(run, ref)
        return print(
          options,
          await send(
            run.api.v1
              .sandboxes({
                sandbox: id,
              })
              .network.probe.post({
                to: options.to,
                port: options.port,
                kind: options.dns ? 'dns' : 'tcp',
                timeout_s: timeout,
              }),
          ),
          probeText,
        )
      }),
    )

  sandbox
    .command('forward')
    .description('Listen on 127.0.0.1 and forward to a port of a running sandbox')
    .argument('<sandbox>')
    .argument('<port>', 'port inside the sandbox', integer)
    .option('--local-port <port>', 'local port (default: the sandbox port when free)', integer)
    .action(
      action(async (options, ref, remote) => {
        const run = await connect(options)
        const id = await sandboxId(run, ref)
        const { address, close } = await forwardPort(run, id, remote, options.localPort, {
          control: progress,
        })
        process.stdout.write(
          options.json
            ? `${JSON.stringify({
                local_address: address,
              })}\n`
            : `${address}\n`,
        )
        progress(`forwarding ${address} to port ${remote} of ${id}; press Ctrl-C to stop`)
        return new Promise<number>((resolve) => {
          const stop = () => void close().then(() => resolve(exitCodes.ok))
          process.once('SIGINT', stop)
          process.once('SIGTERM', stop)
        })
      }),
    )

  const variables = sandbox
    .command('variables')
    .description('Variables of a sandbox; prefer references to project and global variables')
  variables
    .command('list')
    .argument('<sandbox>')
    .option('--resolved', 'the resolved view with sources')
    .action(
      call(async (run, options, ref) => {
        const box = run.api.v1.sandboxes({
          sandbox: await sandboxId(run, ref),
        }).variables
        return options.resolved ? box.resolved.get() : box.get()
      }),
    )
  variables
    .command('set')
    .argument('<sandbox>')
    .argument('<assignments...>', 'KEY=VALUE or KEY=${{project.KEY}}')
    .option('--sealed', 'store the values write-only')
    .option('--allow-unresolved', 'accept references that do not resolve yet')
    .action(
      call(async (run, options, ref, assignments) =>
        run.api.v1
          .sandboxes({
            sandbox: await sandboxId(run, ref),
          })
          .variables.patch({
            set: assignments.map((a) => toSet(options, pair(a))),
            allow_unresolved: options.allowUnresolved,
          }),
      ),
    )
  variables
    .command('unset')
    .argument('<sandbox>')
    .argument('<keys...>')
    .action(
      call(async (run, _options, ref, keys) =>
        run.api.v1
          .sandboxes({
            sandbox: await sandboxId(run, ref),
          })
          .variables.patch({
            unset: keys,
          }),
      ),
    )

  const storage = group(program, 'platform')
    .command('storage')
    .description('The sandbox filesystem of a station')
  storage
    .command('grow')
    .description('Grow the sandbox filesystem to a new total size while sandboxes run')
    .requiredOption('--size <size>', 'new total size in bytes, or GiB')
    .option(
      '--station <station>',
      'station id or name; the only station that reports sandboxes when omitted',
    )
    .action(
      call(async (run, options) => {
        let { station } = options
        if (!station) {
          const capable = (
            await send(
              run.api.v1.stations.get({
                query: {
                  fields: 'capabilities',
                },
              }),
            )
          ).data.items.filter((s) => s.capabilities?.sandboxes)
          if (capable.length !== 1)
            throw usage(
              `${capable.length} stations report the sandbox capability.`,
              'Pass --station <station>.',
            )
          station = capable[0]!.id
        }
        return run.api.v1
          .stations({
            station,
          })
          ['sandbox-storage'].grow.post({
            size_bytes: bytesOf(options.size, '--size'),
          })
      }),
    )
}
