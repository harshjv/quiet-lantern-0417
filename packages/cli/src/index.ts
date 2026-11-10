#!/usr/bin/env node
import { CommanderError, type CommandUnknownOpts } from '@commander-js/extra-typings'

import { createProgram } from './command.ts'
import { adminCommands } from './commands/admin.ts'
import { authCommands } from './commands/auth.ts'
import { adminHostCommands, hostCommands } from './commands/host.ts'
import { linkCommands } from './commands/link.ts'
import { manifestCommands } from './commands/manifest.ts'
import { mcpCommands } from './commands/mcp.ts'
import { networkCommands } from './commands/network.ts'
import { operationCommands } from './commands/operations.ts'
import { resourceCommands } from './commands/resources.ts'
import { sandboxCommands } from './commands/sandbox.ts'
import { variableCommands } from './commands/variables.ts'
import { version } from './env.ts'
import { exitCodes } from './errors.ts'

process.stdout.on('error', (error) => {
  if ((error as NodeJS.ErrnoException).code === 'EPIPE') process.exit(exitCodes.brokenPipe)
  throw error
})

const program = createProgram()

authCommands(program)
linkCommands(program)
resourceCommands(program)
variableCommands(program)
networkCommands(program)
adminCommands(program)
operationCommands(program)
manifestCommands(program)
mcpCommands(program)
hostCommands(program)
adminHostCommands(program)
sandboxCommands(program)

program
  .command('version')
  .description('Print the sly version')
  .action(() => {
    process.stdout.write(
      program.opts().json
        ? `${JSON.stringify({
            version,
          })}\n`
        : `sly ${version}\n`,
    )
  })

const lockExits = (command: CommandUnknownOpts) => {
  command.exitOverride()
  command.commands.forEach(lockExits)
}
lockExits(program)

try {
  await program.parseAsync()
} catch (error) {
  if (error instanceof CommanderError) {
    const shown =
      error.code === 'commander.helpDisplayed' ||
      error.code === 'commander.help' ||
      error.code === 'commander.version'
    if (!shown) process.stderr.write('USAGE\n')
    process.exitCode = shown ? exitCodes.ok : exitCodes.usage
  } else throw error
}
