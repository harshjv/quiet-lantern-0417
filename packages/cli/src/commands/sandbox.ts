import { action, collect, group, integer, seconds, type Program } from '../command.ts'
import { exitCodes, usage } from '../errors.ts'
import { targetId } from '../generated.ts'
import { connect, send } from '../kit.ts'
import { print, progress } from '../output.ts'
import { reportRun, waitRun } from '../runs.ts'
import { attachRun, forwardPort, shellExit } from '../sockets.ts'

import { assignmentOf } from './variables.ts'

const pair = (assignment: string) => {
  const found = assignmentOf(assignment)
  if (!found)
    throw usage(`${assignment} has no value.`, `Write ${assignment.split('=')[0]}=<value>.`)
  return found
}

export const sandboxCommands = (program: Program) => {
  const sandboxes = group(program, 'sandboxes')

  sandboxes
    .command('exec')
    .description(
      'Run a command in the running sandbox --sandbox and stream its output; put the command after --',
    )
    .argument('<command...>')
    .option('--user <user>')
    .option('--cwd <dir>')
    .option('--env <pair>', 'KEY=VALUE for this command only; repeatable', collect)
    .option('--timeout <duration>', 'kill the command after this long', seconds)
    .option('--detach', 'create the exec and print the run without streaming')
    .action(
      action(async (options, command) => {
        const run = await connect(options)
        const id = await targetId(run, 'sandbox')
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

  sandboxes
    .command('shell')
    .description(
      'Interactive shell in the running sandbox --sandbox; needs a terminal and a human actor in protected environments',
    )
    .argument('[command...]')
    .option('--user <user>')
    .option('--cwd <dir>')
    .action(
      action(async (options, command) => {
        if (!process.stdin.isTTY)
          throw usage(
            'sly sandboxes shell needs a terminal.',
            'Run it from an interactive terminal; agents use sly sandboxes exec.',
          )
        const run = await connect(options)
        const id = await targetId(run, 'sandbox')
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

  sandboxes
    .command('forward')
    .description('Listen on 127.0.0.1 and forward to a port of the running sandbox --sandbox')
    .argument('<port>', 'port inside the sandbox', integer)
    .option('--local-port <port>', 'local port (default: the sandbox port when free)', integer)
    .action(
      action(async (options, remote) => {
        const run = await connect(options)
        const id = await targetId(run, 'sandbox')
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
}
