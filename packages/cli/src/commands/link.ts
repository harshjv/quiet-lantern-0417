import { action, type Program } from '../command.ts'
import { exitCodes } from '../errors.ts'
import {
  appId,
  connect,
  previewId,
  projectId,
  projectRef,
  writeContext,
  type Context,
} from '../kit.ts'
import { human, progress } from '../output.ts'

export const linkCommands = (program: Program) => {
  program
    .command('link')
    .description(
      'Write .stationly/context.json in the working directory: the instance, project, preview and app later commands default to',
    )
    .action(
      action(async (options) => {
        const run = await connect(options)
        const project = await projectId(run, await projectRef(run))
        const scoped = {
          ...run,
          selection: {
            ...run.selection,
            project,
          },
        }
        const context: Context = {
          instance: run.credentials.instance,
          project,
          preview: await previewId(scoped),
        }

        if (run.selection.app) {
          context.app = await appId(scoped)
        }

        const path = await writeContext(context)

        if (options.json) {
          process.stdout.write(
            `${JSON.stringify({
              path,
              context,
            })}\n`,
          )
        } else {
          progress(`linked ${path}`)
          process.stdout.write(`${human(context)}\n`)
        }

        return exitCodes.ok
      }),
    )
}
