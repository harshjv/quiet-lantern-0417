#!/usr/bin/env node
import { Command, CommanderError } from 'commander'
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
import { exitCodes } from './errors.ts'
import { version } from './version.ts'

process.stdout.on('error', error => {
  if ((error as NodeJS.ErrnoException).code === 'EPIPE') process.exit(exitCodes.brokenPipe)
  throw error
})

const program = new Command('sly')
  .description('Stationly CLI: a thin client over the Dispatch API')
  .option('--json', 'print the API response unmodified as one JSON document')
  .option('--dry-run', 'print the request a mutating command would send, and send nothing')
  .option('--instance <url>', 'instance to use instead of the current one')
  .option('--project <project>', 'project id or name (default from .stationly/context.json)')
  .option('--environment <environment>', 'environment id or name (default: the project default)')
  .option('--service <service>', 'service id or name')
  .exitOverride()
  .configureOutput({ writeErr: text => process.stderr.write(text) })

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
    process.stdout.write(program.opts().json ? `${JSON.stringify({ version })}\n` : `sly ${version}\n`)
  })

for (const command of program.commands) {
  command.exitOverride()
  for (const sub of command.commands) sub.exitOverride()
}

try {
  await program.parseAsync()
} catch (error) {
  if (error instanceof CommanderError) {
    const shown = error.code === 'commander.helpDisplayed' || error.code === 'commander.help' || error.code === 'commander.version'
    if (!shown) process.stderr.write('USAGE\n')
    process.exitCode = shown ? exitCodes.ok : exitCodes.usage
  } else throw error
}
