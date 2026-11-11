import { action, group, seconds, type Program } from '../command.ts'
import { exitCodes, usage } from '../errors.ts'
import { connect, pollUntil, send } from '../kit.ts'
import { print } from '../output.ts'

export const volumeCommands = (program: Program) => {
  group(program, 'volumes')
    .command('backup')
    .description(
      'Back up a volume to the volume_backup.target setting or a station directory; --wait polls its backups until this one ends',
    )
    .argument('<id>', 'volume id')
    .option(
      '--to <path>',
      'a directory under the station backup root (default: the volume_backup.target setting, which may be an S3 bucket)',
    )
    .option(
      '--live',
      'copy while the service runs (quiesce false); the archive is marked consistent false',
    )
    .option('--wait', 'wait until the backup is complete or failed')
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

        if ('warnings' in snapshot) {
          for (const w of snapshot.warnings ?? []) {
            if (!options.json) {
              process.stderr.write(`warning ${w.code}: ${w.explanation}\n`)
            }
          }
        }

        if (!options.wait || sent.status === 202) {
          return print(options, sent)
        }

        const finished = (items: { id: string; status: string }[]) =>
          items.find((i) => i.id === snapshot.id && i.status !== 'running')
        const deadline = Date.now() + (options.timeout ?? 600) * 1000
        const list = await pollUntil(
          async () =>
            (
              await send(
                run
                  .waiting(deadline)
                  .api.v1.volumes({
                    id: volume,
                  })
                  .backups.get(),
              )
            ).data,
          ({ items }) => finished(items) !== undefined,
          deadline,
          1000,
        )
        const row = finished(list.items)

        if (!row) {
          throw usage(
            `backup ${snapshot.id} is still running`,
            `sly volumes list-backups ${volume}`,
          )
        }

        print(options, {
          ...sent,
          data: row,
        })

        return row.status === 'complete' ? exitCodes.ok : exitCodes.api
      }),
    )
}
