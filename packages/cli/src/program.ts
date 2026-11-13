import tab from '@bomb.sh/tab/commander'
import type { Command } from 'commander'

import { createProgram } from './command.ts'
import { agentCommands } from './commands/agent.ts'
import { authCommands } from './commands/auth.ts'
import { adminHostCommands, hostCommands } from './commands/host.ts'
import { linkCommands } from './commands/link.ts'
import { manifestCommands } from './commands/manifest.ts'
import { mcpCommands } from './commands/mcp.ts'
import { networkCommands } from './commands/network.ts'
import { platformCommands } from './commands/platform.ts'
import { sandboxCommands } from './commands/sandbox.ts'
import { serviceCommands } from './commands/service.ts'
import { variableCommands } from './commands/variables.ts'
import { volumeCommands } from './commands/volumes.ts'
import { version } from './env.ts'
import { registerGenerated } from './generated.ts'

export const handWrittenProgram = () => {
  const program = createProgram()

  agentCommands(program)
  authCommands(program)
  linkCommands(program)
  serviceCommands(program)
  variableCommands(program)
  networkCommands(program)
  volumeCommands(program)
  platformCommands(program)
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

  return program
}

export const buildProgram = () => {
  const program = handWrittenProgram()

  registerGenerated(program)
  tab(program as unknown as Command, {
    completionCommandName: 'completion',
  })

  return program
}
