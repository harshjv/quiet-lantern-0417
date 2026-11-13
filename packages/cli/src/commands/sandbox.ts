import { action, collect, group, integer, seconds, type Program } from '../command.ts'
import { exitCodes, usage } from '../errors.ts'
import { targetId } from '../generated.ts'
import { connect, send, withSandbox, type Globals } from '../kit.ts'
import { print, progress } from '../output.ts'
import { reportRun, waitRun } from '../runs.ts'
import { attachRun, forwardPort, shellExit } from '../sockets.ts'

import { assignmentOf } from './variables.ts'

const pair = (assignment: string) => {
  const found = assignmentOf(assignment)

  if (!found) {
    throw usage(`${assignment} has no value.`, `Write ${assignment.split('=')[0]}=<value>.`)
  }

  return found
}

const named = (options: Globals, words: string[]) =>
  options.sandbox === undefined
    ? {
        sandbox: words[0],
        rest: words.slice(1),
      }
    : {
        sandbox: undefined,
        rest: words,
      }

const sandboxArgument = 'the sandbox, then what follows; with --sandbox, only what follows'

export const sandboxCommands = (program: Program) => {
  const sandboxes = group(program, 'sandboxes')

  sandboxes
    .command('exec')
    .description(
      'Run a command in a running sandbox and stream its output: sly sandboxes exec <sandbox> -- <command>',
    )
    .usage('[options] <sandbox> [--] <command...>')
    .argument('<words...>', sandboxArgument)
    .option('--user <user>')
    .option('--cwd <dir>')
    .option('--env <pair>', 'KEY=VALUE for this command only; repeatable', collect)
    .option('--timeout <duration>', 'kill the command after this long', seconds)
    .option('--detach', 'create the exec and print the run without streaming')
    .action(
      action(async (options, words) => {
        const { sandbox, rest: command } = named(options, words)

        if (!command.length) {
          throw usage(
            'There is no command to run.',
            'Name the sandbox, then the command: sly sandboxes exec my-sandbox -- ls',
          )
        }

        const run = withSandbox(await connect(options), sandbox)
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

        if (detach || !attach_url) {
          return print(options, created)
        }

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
      'Interactive shell in a running sandbox: sly sandboxes shell <sandbox>; needs a terminal and a human actor in protected environments',
    )
    .usage('[options] [sandbox] [command...]')
    .argument('[words...]', sandboxArgument)
    .option('--user <user>')
    .option('--cwd <dir>')
    .action(
      action(async (options, words) => {
        const { sandbox, rest: command } = named(options, words)

        if (!process.stdin.isTTY) {
          throw usage(
            'sly sandboxes shell needs a terminal.',
            'Run it from an interactive terminal; agents use sly sandboxes exec.',
          )
        }

        const run = withSandbox(await connect(options), sandbox)
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
    .description('Listen on 127.0.0.1 and forward to a port of a running sandbox')
    .argument('<port>', 'port inside the sandbox', integer)
    .argument('[sandbox]', 'the sandbox, id or name')
    .option('--local-port <port>', 'local port (default: the sandbox port when free)', integer)
    .action(
      action(async (options, remote, sandbox) => {
        if (sandbox !== undefined && options.sandbox !== undefined) {
          throw usage(
            'The sandbox is given twice, as an argument and as --sandbox.',
            'Give it once: sly sandboxes forward <port> <sandbox>, or --sandbox.',
          )
        }

        const run = withSandbox(await connect(options), sandbox)
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
