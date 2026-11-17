import { action, collect, group, integer, seconds, type Program } from '../command.ts'
import { exitCodes, usage } from '../errors.ts'
import { targetId } from '../generated.ts'
import { connect, send, withMachine, type Globals } from '../kit.ts'
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
  options.machine === undefined
    ? {
        machine: words[0],
        rest: words.slice(1),
      }
    : {
        machine: undefined,
        rest: words,
      }

const machineArgument = 'the machine, then what follows; with --machine, only what follows'

export const machineCommands = (program: Program) => {
  const machines = group(program, 'machines')

  machines
    .command('exec')
    .description(
      'Run a command in a running machine and stream its output: sly machines exec <machine> -- <command>',
    )
    .usage('[options] <machine> [--] <command...>')
    .argument('<words...>', machineArgument)
    .option('--user <user>')
    .option('--cwd <dir>')
    .option('--env <pair>', 'KEY=VALUE for this command only; repeatable', collect)
    .option('--timeout <duration>', 'kill the command after this long', seconds)
    .option('--detach', 'create the exec and print the run without streaming')
    .action(
      action(async (options, words) => {
        const { machine, rest: command } = named(options, words)

        if (!command.length) {
          throw usage(
            'There is no command to run.',
            'Name the machine, then the command: sly machines exec my-machine -- ls',
          )
        }

        const run = withMachine(await connect(options), machine)
        const id = await targetId(run, 'machine')
        const detach = Boolean(options.detach)
        const created = await send(
          run.api.v1
            .machines({
              machine: id,
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

  machines
    .command('shell')
    .description(
      'Interactive shell in a running machine: sly machines shell <machine>; needs a terminal and a human actor in production',
    )
    .usage('[options] [machine] [command...]')
    .argument('[words...]', machineArgument)
    .option('--user <user>')
    .option('--cwd <dir>')
    .action(
      action(async (options, words) => {
        const { machine, rest: command } = named(options, words)

        if (!process.stdin.isTTY) {
          throw usage(
            'sly machines shell needs a terminal.',
            'Run it from an interactive terminal; agents use sly machines exec.',
          )
        }

        const run = withMachine(await connect(options), machine)
        const id = await targetId(run, 'machine')
        const created = (
          await send(
            run.api.v1
              .machines({
                machine: id,
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

  machines
    .command('forward')
    .description('Listen on 127.0.0.1 and forward to a port of a running machine')
    .argument('<port>', 'port inside the machine', integer)
    .argument('[machine]', 'the machine, id or name')
    .option('--local-port <port>', 'local port (default: the machine port when free)', integer)
    .action(
      action(async (options, remote, machine) => {
        if (machine !== undefined && options.machine !== undefined) {
          throw usage(
            'The machine is given twice, as an argument and as --machine.',
            'Give it once: sly machines forward <port> <machine>, or --machine.',
          )
        }

        const run = withMachine(await connect(options), machine)
        const id = await targetId(run, 'machine')
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
