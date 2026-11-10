import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { text } from 'node:stream/consumers'

import type { Command } from 'commander'

import { dispatchAddress } from '@stationly/protocol'

import { AuthService } from '../auth/auth.ts'
import { SetupError, setupInstance, type SetupInput } from '../auth/bootstrap.ts'
import { createMetadataFetch } from '../auth/metadata-fetch.ts'
import { openDb } from '../db/client.ts'
import { Keyring, masterKeyFromEnv } from '../secrets/keyring.ts'

const localOrigin = `http://${dispatchAddress}`

type BootstrapOptions = { db: string; origin: string; release?: string }

const bootstrap = async (options: BootstrapOptions) => {
  const db = openDb(options.db)
  const masterKey = masterKeyFromEnv()
  const keyring = new Keyring(db, masterKey)
  const auth = new AuthService(db, masterKey, options.origin, createMetadataFetch(null))
  try {
    const input = JSON.parse(await text(process.stdin)) as SetupInput
    const release = options.release
      ? {
          manifest: readFileSync(join(options.release, 'release-manifest.json'), 'utf8'),
          bundle: readFileSync(
            join(options.release, 'release-manifest.json.sigstore.json'),
            'utf8',
          ),
          source: readFileSync(join(options.release, 'source'), 'utf8').trim(),
        }
      : null
    process.stdout.write(
      `${JSON.stringify(
        await setupInstance(
          {
            db,
            keyring,
            auth,
          },
          {
            ...input,
            release,
          },
          {
            type: 'system',
            id: null,
            client: 'pnpm-bootstrap',
          },
        ),
        null,
        2,
      )}\n`,
    )
  } catch (error) {
    if (error instanceof SetupError) {
      process.stdout.write(
        `${JSON.stringify({
          error: {
            code: error.code,
            explanation: error.message,
          },
        })}\n`,
      )
      process.exit(1)
    }
    throw error
  }
}

export const bootstrapCommand = (program: Command) =>
  program
    .command('bootstrap')
    .description(
      'Seed a local Dispatch without a station (on a station run sly setup instead); reads {"email","password","name"?,"acme_email"?,"hostnames"?: {"dashboard","api"}} on stdin',
    )
    .requiredOption('--db <file>', 'SQLite file Dispatch owns')
    .option('--origin <url>', 'origin Dispatch serves', localOrigin)
    .option('--release <dir>', 'release directory stationd install wrote')
    .action((options: BootstrapOptions) => bootstrap(options))
