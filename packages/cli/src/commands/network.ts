import { Option } from '@commander-js/extra-typings'

import { action, group, integer, type Program } from '../command.ts'
import { exitCodes, usage } from '../errors.ts'
import { targetId } from '../generated.ts'
import { connect, environmentId, send, serviceId, type Run } from '../kit.ts'
import { json, print, staged } from '../output.ts'
import { explanationText, probeText } from '../renderers/network.ts'

type Origin = { from: string; environment: string; kind: 'service' | 'sandbox' | 'internet' }

const originOf = async (run: Run, fromInternet: boolean): Promise<Origin> => {
  if (fromInternet) {
    return {
      from: 'internet',
      environment: await environmentId(run),
      kind: 'internet',
    }
  }

  if (run.selection.sandbox) {
    const sandbox = await targetId(run, 'sandbox')
    const box = (
      await send(
        run.api.v1
          .sandboxes({
            sandbox,
          })
          .get(),
      )
    ).data

    return {
      from: sandbox,
      environment: box.environment_id,
      kind: 'sandbox',
    }
  }

  return {
    from: await serviceId(run),
    environment: await environmentId(run),
    kind: 'service',
  }
}

const probe = async (run: Run, origin: Origin, to: string, port: number | undefined) =>
  origin.kind === 'sandbox'
    ? send(
        run.api.v1
          .sandboxes({
            sandbox: origin.from,
          })
          .network.probe.post({
            to,
            port,
          }),
      )
    : send(
        run.api.v1
          .services({
            service: origin.from,
          })
          .network.probe.post({
            to,
            port,
          }),
      )

export const networkCommands = (program: Program) => {
  group(program, 'network')
    .command('explain')
    .description(
      'Why the selected service or sandbox can or cannot reach a target (or, with --from-internet, why the internet can or cannot reach a domain or TCP exposure), hop by hop with fixes. --probe makes two calls, the explanation and then the probe, and prints both; with --json it prints { explanation, probe }.',
    )
    .option('--from-internet', 'explain the inbound path from the internet')
    .requiredOption(
      '--to <target>',
      'a service, service:port, a .internal name or host:port; with --from-internet a domain hostname or public address:port',
    )
    .option('--port <port>', "port; defaults to the target's only declared port", integer)
    .option('--udp', 'judge UDP instead of TCP')
    .addOption(
      new Option('--probe', 'then send the probe from the service or sandbox').conflicts(
        'fromInternet',
      ),
    )
    .action(
      action(async (options) => {
        const fromInternet = Boolean(options.fromInternet)

        if (fromInternet && (options.service || options.sandbox)) {
          throw usage(
            'Give --service, --sandbox or --from-internet, not two of them.',
            'sly network explain --from-internet --to web.example.com',
          )
        }

        const run = await connect(options)
        const origin = await originOf(run, fromInternet)
        const explained = await send(
          run.api.v1
            .environments({
              environment: origin.environment,
            })
            .network.explain.get({
              query: {
                from: origin.from,
                to: options.to,
                port: options.port,
                protocol: options.udp ? 'udp' : 'tcp',
              },
            }),
        )

        if (!options.probe) {
          return print(options, explained, explanationText)
        }

        const probed = await probe(run, origin, options.to, options.port)

        if (options.json) {
          json({
            explanation: explained.data,
            probe: probed.data,
          })
        } else {
          process.stdout.write(`${explanationText(explained.data)}\n\n${probeText(probed.data)}\n`)
        }

        return probed.status === 202 ? staged(probed, 'sent') : exitCodes.ok
      }),
    )
}
