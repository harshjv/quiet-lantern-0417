#!/usr/bin/env node
import { CommanderError } from '@commander-js/extra-typings'

import { version } from './env.ts'
import { exitCodes, usage } from './errors.ts'
import { json } from './output.ts'
import { buildProgram } from './program.ts'

process.stdout.on('error', (error) => {
  if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
    process.exit(exitCodes.brokenPipe)
  }

  throw error
})

if (process.argv[2] === '--version') {
  process.stdout.write(`sly ${version}\n`)
  process.exit(exitCodes.ok)
}

const program = buildProgram()

try {
  await program.parseAsync()
} catch (error) {
  if (error instanceof CommanderError) {
    const shown =
      error.code === 'commander.helpDisplayed' ||
      error.code === 'commander.help' ||
      error.code === 'commander.version'

    if (!shown && (program.opts().json || process.argv.includes('--json'))) {
      json(
        usage(
          error.message.replace(/^error: /i, ''),
          'Run the command with --help to see its arguments and options.',
        ).envelope,
      )
    }

    if (!shown) {
      process.stderr.write('USAGE\n')
    }

    process.exitCode = shown ? exitCodes.ok : exitCodes.usage
  } else {
    throw error
  }
}
