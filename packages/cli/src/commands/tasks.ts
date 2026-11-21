import { action, group, integer, type Program } from '../command.ts'
import { exitCodes, usage } from '../errors.ts'
import { connect, send } from '../kit.ts'
import { progress } from '../output.ts'
import { attachRun, forwardPort, shellExit } from '../sockets.ts'

export const taskCommands = (program: Program) => {
  const tasks = group(program, 'tasks')

  tasks
    .command('shell')
    .description(
      "Interactive shell in a task's worktree, as you, its owner: sly tasks shell <task>; needs a terminal",
    )
    .argument('<task>', 'the task id')
    .action(
      action(async (options, task) => {
        if (!process.stdin.isTTY) {
          throw usage(
            'sly tasks shell needs a terminal.',
            'Run it from an interactive terminal; sly tasks files and sly tasks read show the files.',
          )
        }

        const run = await connect(options)
        const created = (
          await send(
            run.api.v1
              .tasks({
                task,
              })
              .shells.post(),
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

  tasks
    .command('forward')
    .description(
      "Listen on 127.0.0.1 and forward to a port of a task, as its owner: sly tasks forward <task> [port]; the task's port by default",
    )
    .argument('<task>', 'the task id')
    .argument('[port]', "port inside the task; the task's port by default", integer)
    .option('--local <port>', 'local port (default: the same port when free)', integer)
    .action(
      action(async (options, task, port) => {
        const run = await connect(options)
        const remote =
          port ??
          (
            await send(
              run.api.v1
                .tasks({
                  task,
                })
                .get(),
            )
          ).data.port

        if (remote === null) {
          throw usage(
            `Task ${task} has no port of its own.`,
            'Name the port: sly tasks forward <task> <port>.',
          )
        }

        const { address, close } = await forwardPort(run, task, remote, options.local, {
          control: progress,
        })

        process.stdout.write(
          options.json
            ? `${JSON.stringify({
                local_address: address,
              })}\n`
            : `${address}\n`,
        )
        progress(`forwarding ${address} to port ${remote} of task ${task}; press Ctrl-C to stop`)

        return new Promise<number>((resolve) => {
          const stop = () => void close().then(() => resolve(exitCodes.ok))

          process.once('SIGINT', stop)
          process.once('SIGTERM', stop)
        })
      }),
    )
}
