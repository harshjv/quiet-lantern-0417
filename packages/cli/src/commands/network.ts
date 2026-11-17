import { Option } from '@commander-js/extra-typings'

import { action, group, integer, type Program } from '../command.ts'
import { exitCodes, usage } from '../errors.ts'
import { targetId } from '../generated.ts'
import { appId, connect, previewId, projectRef, send, type Run } from '../kit.ts'
import { json, print, waiting } from '../output.ts'
import { explanationText, probeText } from '../renderers/network.ts'

type Origin = {
  from: string
  project: string
  preview: string | undefined
  kind: 'app' | 'machine' | 'internet'
}

const originOf = async (run: Run, fromInternet: boolean): Promise<Origin> => {
  if (fromInternet) {
    return {
      from: 'internet',
      project: await projectRef(run),
      preview: await previewId(run),
      kind: 'internet',
    }
  }

  if (run.selection.machine) {
    const machine = await targetId(run, 'machine')
    const box = (
      await send(
        run.api.v1
          .machines({
            machine,
          })
          .get(),
      )
    ).data

    return {
      from: machine,
      project: box.project_id,
      preview: box.preview_id ?? undefined,
      kind: 'machine',
    }
  }

  return {
    from: await appId(run),
    project: await projectRef(run),
    preview: await previewId(run),
    kind: 'app',
  }
}

const probe = async (run: Run, origin: Origin, to: string, port: number | undefined) =>
  origin.kind === 'machine'
    ? send(
        run.api.v1
          .machines({
            machine: origin.from,
          })
          .network.probe.post({
            to,
            port,
          }),
      )
    : send(
        run.api.v1
          .apps({
            app: origin.from,
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
      'Why the selected app or machine can or cannot reach a target (or, with --from-internet, why the internet can or cannot reach a domain or TCP exposure), hop by hop with fixes. --probe makes two calls, the explanation and then the probe, and prints both; with --json it prints { explanation, probe }.',
    )
    .option('--from-internet', 'explain the inbound path from the internet')
    .requiredOption(
      '--to <target>',
      'an app, app:port, a .internal name or host:port; with --from-internet a domain hostname or public address:port',
    )
    .option('--port <port>', "port; defaults to the target's only declared port", integer)
    .option('--udp', 'judge UDP instead of TCP')
    .addOption(
      new Option('--probe', 'then send the probe from the app or machine').conflicts(
        'fromInternet',
      ),
    )
    .action(
      action(async (options) => {
        const fromInternet = Boolean(options.fromInternet)

        if (fromInternet && (options.app || options.machine)) {
          throw usage(
            'Give --app, --machine or --from-internet, not two of them.',
            'sly network explain --from-internet --to web.example.com',
          )
        }

        const run = await connect(options)
        const origin = await originOf(run, fromInternet)
        const explained = await send(
          run.api.v1
            .projects({
              project: origin.project,
            })
            .network.explain.get({
              query: {
                preview: origin.preview,
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

        return probed.status === 202 ? waiting(probed, 'sent') : exitCodes.ok
      }),
    )
}
