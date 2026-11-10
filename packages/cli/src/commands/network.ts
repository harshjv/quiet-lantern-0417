import { action, call, integer, seconds, type Program } from '../command.ts'
import { exitCodes, usage } from '../errors.ts'
import {
  connect,
  environmentId,
  found,
  portId,
  send,
  serviceId,
  sseHeaders,
  stream,
} from '../kit.ts'
import { pollUntil } from '../outage.ts'
import { json, print, staged } from '../output.ts'
import {
  connectionsText,
  dnsText,
  explanationText,
  networkText,
  probeText,
  type LiveTick,
} from '../renderers/network.ts'
import { followSse, streamed } from '../sse.ts'

export const networkCommands = (program: Program) => {
  const network = program
    .command('network')
    .description(
      'The network map of the linked environment: DNS names, virtual IPs, Switch targets, domains, TCP exposures and paths; --service narrows it to one service and its neighbours',
    )
    .option('--fields <fields>', 'paths.rule, subnets.bridge, or * for both')
    .action(
      call(
        async (run, options) =>
          run.api.v1
            .environments({
              environment: await environmentId(run),
            })
            .network.get({
              query: {
                service: options.service,
                fields: options.fields,
              },
            }),
        networkText,
      ),
    )

  network
    .command('connections')
    .description(
      'Live connections of the selected service grouped by peer, and its refused attempts; -f follows the 5 s stream',
    )
    .option('--direction <direction>', 'in or out')
    .option('-f, --follow', 'follow the live stream')
    .action(
      action(async (options) => {
        const { direction } = options
        if (direction !== undefined && direction !== 'in' && direction !== 'out')
          throw usage(
            '--direction is in or out.',
            'sly network connections --service <s> --direction out',
          )
        const run = await connect(options)
        const service = await serviceId(run)
        if (!options.follow)
          return print(
            options,
            await send(
              run.api.v1
                .services({
                  service,
                })
                .connections.get({
                  query: {
                    direction,
                  },
                }),
            ),
            connectionsText,
          )
        const environment = await environmentId(run)
        return followSse(
          (lastId) =>
            stream(
              run.api.v1
                .environments({
                  environment,
                })
                .network.live.get({
                  query: {
                    service,
                    direction,
                  },
                  headers: sseHeaders(lastId),
                }),
            ),
          streamed('live stream', (event) => {
            if (event.event !== 'network') return
            const tick = JSON.parse(event.data) as LiveTick
            for (const sample of tick.samples.filter((s) => s.service.id === service))
              process.stdout.write(
                options.json ? `${JSON.stringify(sample)}\n` : `${connectionsText(sample)}\n\n`,
              )
          }),
        )
      }),
    )

  network
    .command('explain')
    .description(
      'Why the selected service can or cannot reach a target (or, with --from-internet, why the internet can or cannot reach a domain or TCP exposure), hop by hop with fixes. --probe makes two calls, the explanation and then the probe, and prints both; with --json it prints { explanation, probe }. It is the only sly command that combines two operations.',
    )
    .option('--from-internet', 'explain the inbound path from the internet')
    .requiredOption(
      '--to <target>',
      'a service, service:port, a .internal name or host:port; with --from-internet a domain hostname or public address:port',
    )
    .option('--port <port>', "port; defaults to the target's only declared port", integer)
    .option('--udp', 'judge UDP instead of TCP')
    .option('--probe', 'then send the probe from the service (needs --service)')
    .action(
      action(async (options) => {
        const fromInternet = Boolean(options.fromInternet)
        const run = await connect(options)
        if (fromInternet && options.probe)
          throw usage(
            '--probe needs --service; a probe is sent from a service, not from the internet.',
            'sly network explain --service web --to db --probe',
          )
        if (fromInternet && run.selection.service && options.service)
          throw usage(
            'Give --service or --from-internet, not both.',
            'sly network explain --from-internet --to web.example.com',
          )
        const from = fromInternet ? 'internet' : await serviceId(run)
        const environment = await environmentId(run)
        const explained = await send(
          run.api.v1
            .environments({
              environment,
            })
            .network.explain.get({
              query: {
                from,
                to: options.to,
                port: options.port,
                protocol: options.udp ? 'udp' : 'tcp',
              },
            }),
        )
        if (!options.probe) return print(options, explained, explanationText)
        const probed = await send(
          run.api.v1
            .services({
              service: from,
            })
            .network.probe.post({
              to: options.to,
              port: options.port,
            }),
        )
        if (options.json)
          json({
            explanation: explained.data,
            probe: probed.data,
          })
        else
          process.stdout.write(`${explanationText(explained.data)}\n\n${probeText(probed.data)}\n`)
        return probed.status === 202 ? staged(probed, 'sent') : exitCodes.ok
      }),
    )

  network
    .command('probe')
    .description(
      "Send one TCP handshake or one DNS query from inside the selected service's own namespace, under its own rules; staged for a non-human actor in a protected environment",
    )
    .requiredOption(
      '--to <target>',
      'a service, a .internal name, an ipv4 address or a public hostname; host:port is accepted',
    )
    .option('--port <port>', "port; defaults to the service's only declared port", integer)
    .option('--dns', 'send only the A query to the environment resolver')
    .option('--timeout <seconds>', 'seconds, 1 to 10 (default 3)', integer)
    .action(
      action(async (options) => {
        const { timeout } = options
        if (timeout !== undefined && (timeout < 1 || timeout > 10))
          throw usage(
            '--timeout is 1 to 10 seconds.',
            'sly network probe --service web --to db --timeout 5',
          )
        const run = await connect(options)
        const service = await serviceId(run)
        return print(
          options,
          await send(
            run.api.v1
              .services({
                service,
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

  network
    .command('dns')
    .description(
      "The selected service's recent DNS queries from the resolver's ring, newest first; names are untrusted data",
    )
    .option('--tail <n>', 'entries, default 50, max 200', integer)
    .option('--name <substring>', 'case-insensitive substring of the name')
    .option('--rcode <rcode>', 'NOERROR, NXDOMAIN, REFUSED, ...')
    .action(
      call(
        async (run, options) =>
          run.api.v1
            .services({
              service: await serviceId(run),
            })
            ['dns-log'].get({
              query: {
                tail: options.tail,
                name: options.name,
                rcode: options.rcode,
              },
            }),
        dnsText,
      ),
    )

  const domains = program.command('domains').description('Domains of the selected service')
  domains
    .command('list')
    .option('--status <status>')
    .action(
      call(async (run, options) =>
        run.api.v1
          .services({
            service: await serviceId(run),
          })
          .domains.get({
            query: {
              status: options.status,
            },
          }),
      ),
    )
  domains
    .command('generate')
    .requiredOption('--port <port>', 'http port of the service', integer)
    .action(
      call(async (run, options) =>
        run.api.v1
          .ports({
            id: await portId(run, await serviceId(run), options.port),
          })
          .domains.post({
            generated: true,
          }),
      ),
    )
  domains
    .command('add')
    .argument('<hostname>')
    .requiredOption('--port <port>', 'http port of the service', integer)
    .action(
      call(async (run, options, hostname) =>
        run.api.v1
          .ports({
            id: await portId(run, await serviceId(run), options.port),
          })
          .domains.post({
            hostname,
          }),
      ),
    )
  domains
    .command('remove')
    .argument('<domain>', 'domain id')
    .action(
      call(async (run, _options, id) =>
        run.api.v1
          .domains({
            id,
          })
          .delete(),
      ),
    )

  const expose = program.command('expose').description('TCP exposures of the selected service')
  expose
    .command('tcp')
    .argument('<port>', 'tcp port of the service')
    .action(
      call(async (run, _options, port) =>
        run.api.v1
          .ports({
            id: await portId(run, await serviceId(run), integer(port)),
          })
          ['port-allocations'].post(),
      ),
    )
  expose
    .command('remove')
    .argument('<port>', 'tcp port of the service')
    .action(
      call(async (run, _options, port) => {
        const service = await serviceId(run)
        const id = await portId(run, service, integer(port))
        const allocations = await send(
          run.api.v1
            .services({
              service,
            })
            ['port-allocations'].get({
              query: {
                status: 'active',
              },
            }),
        )
        const allocation = found(
          allocations.data.items,
          (a) => a.service_port_id === id,
          `Port ${port} has no active TCP exposure.`,
          'Run sly services describe to see port_allocations.',
        )
        return run.api.v1['port-allocations']({
          id: allocation.id,
        }).delete()
      }),
    )

  const volumes = program.command('volumes').description('Volumes')
  volumes
    .command('list')
    .option('--status <status>')
    .option('--station <station>')
    .option('--owner <owner>')
    .action(
      call(async (run, options) =>
        run.api.v1.volumes.get({
          query: {
            service: run.selection.service ? await serviceId(run) : undefined,
            status: options.status,
            station: options.station,
            owner: options.owner,
          },
        }),
      ),
    )
  volumes
    .command('adopt')
    .argument('<volume>')
    .requiredOption('--mount-path <path>', 'where the selected service mounts it')
    .action(
      call(async (run, options, volume) =>
        run.api.v1
          .volumes({
            id: volume,
          })
          .adopt.post({
            service_id: await serviceId(run),
            mount_path: options.mountPath,
          }),
      ),
    )
  volumes
    .command('backup')
    .argument('<volume>')
    .option(
      '--to <path>',
      'a directory under the station backup root (default: the volume_backup.target setting, which may be an S3 bucket)',
    )
    .option(
      '--live',
      'copy while the service runs (quiesce false); the archive is marked consistent false',
    )
    .option('--wait', 'wait for volume.backup_done')
    .option('--timeout <duration>', 'with --wait, give up after this long (default 10m)', seconds)
    .action(
      action(async (options, volume) => {
        const run = await connect(options)
        const sent = await send(
          run.api.v1
            .volumes({
              id: volume,
            })
            .backups.post({
              target: options.to
                ? {
                    type: 'path',
                    path: options.to,
                  }
                : undefined,
              quiesce: !options.live,
            }),
        )
        const snapshot = sent.data
        if ('warnings' in snapshot)
          for (const w of snapshot.warnings ?? [])
            if (!options.json) process.stderr.write(`warning ${w.code}: ${w.explanation}\n`)
        if (!options.wait) return print(options, sent)
        const finished = (items: { id: string; status: string }[]) =>
          items.find((i) => i.id === snapshot.id && i.status !== 'running')
        const list = await pollUntil(
          async () =>
            (
              await send(
                run.api.v1
                  .volumes({
                    id: volume,
                  })
                  .backups.get(),
              )
            ).data,
          ({ items }) => finished(items) !== undefined,
          Date.now() + (options.timeout ?? 600) * 1000,
          1000,
        )
        const row = finished(list.items)
        if (!row)
          throw usage(`backup ${snapshot.id} is still running`, `sly volumes backups ${volume}`)
        print(options, {
          ...sent,
          data: row,
        })
        return row.status === 'complete' ? exitCodes.ok : exitCodes.api
      }),
    )
  volumes
    .command('backups')
    .argument('<volume>')
    .option('--status <status>', 'running, complete, failed or expired')
    .action(
      call(async (run, options, volume) =>
        run.api.v1
          .volumes({
            id: volume,
          })
          .backups.get({
            query: {
              status: options.status,
            },
          }),
      ),
    )
  volumes
    .command('restore')
    .argument('<volume>', 'the volume the backup was taken of')
    .requiredOption('--backup <snapshot>', 'snp_... of a complete backup')
    .option(
      '--station <station>',
      "restore on this station instead of the volume's own (S3 backups only)",
    )
    .action(
      call(async (run, options, volume) =>
        run.api.v1
          .volumes({
            id: volume,
          })
          .restore.post({
            backup: options.backup,
            station: options.station,
          }),
      ),
    )
}
