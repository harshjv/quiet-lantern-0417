import { isatty } from 'node:tty'

import { action, collect, type Program } from '../command.ts'
import { Exit, exitCodes } from '../errors.ts'
import { endpointNamed, runOperation, waitOptions, type Flow } from '../generated.ts'
import { connect, send, serviceId } from '../kit.ts'
import { streamLogs } from '../logs.ts'
import { print, progress } from '../output.ts'
import { uploadSource } from '../push.ts'
import { reportRun, waitRun } from '../runs.ts'
import { attachRun, shellExit } from '../sockets.ts'

const deploy = endpointNamed('deploy')

export const serviceCommands = (program: Program) => {
  program
    .command('run')
    .description(
      "Run a one-off command in the service's image and variables, streaming its output; put the command after --",
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

  const push = program
    .command('push')
    .description(
      'Upload a local directory (honoring .dockerignore) as the service source and deploy it',
    )
    .argument('[path]', 'directory to push', '.')
    .option('--via <transport>', 'ssh lands the tarball on the station directly')
  waitOptions(push, deploy)
  push.action(
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
      return runOperation(
        options,
        run,
        deploy,
        {
          service,
          blob_id: blob.blob_id,
        },
        options as Flow,
      )
    }),
  )
}
