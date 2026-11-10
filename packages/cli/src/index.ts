#!/usr/bin/env node
import { CommanderError, type CommandUnknownOpts } from '@commander-js/extra-typings'

import { exitCodes } from './errors.ts'
import { buildProgram } from './program.ts'

process.stdout.on('error', (error) => {
  if ((error as NodeJS.ErrnoException).code === 'EPIPE') process.exit(exitCodes.brokenPipe)
  throw error
})

const program = buildProgram()

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
