import { Command, CommanderError } from 'commander'

import { bootstrapCommand } from './scripts/bootstrap.ts'
import { handshakeVectorsCommand } from './scripts/handshake-vectors.ts'
import { migrateCommand } from './scripts/migrate.ts'
import { openapiCommand } from './scripts/openapi.ts'
import { secretsCommand } from './scripts/secrets.ts'

const program = new Command('dispatch')
  .description('Stationly Dispatch: the instance API, dashboard and station server')
  .exitOverride()

program
  .command('serve', {
    isDefault: true,
  })
  .description('Run Dispatch (the default)')
  .action(async () => {
    await import('./main.ts')
  })

migrateCommand(program)
bootstrapCommand(program)
secretsCommand(program)
handshakeVectorsCommand(program)
openapiCommand(program)

try {
  await program.parseAsync()
} catch (error) {
  if (!(error instanceof CommanderError)) throw error
  process.exit(error.exitCode === 0 ? 0 : 2)
}
