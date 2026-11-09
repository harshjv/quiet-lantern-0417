import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { text } from 'node:stream/consumers'
import { parseArgs } from 'node:util'
import { AuthService } from '../auth/auth.ts'
import { SetupError, setupInstance, type SetupInput } from '../auth/bootstrap.ts'
import { createMetadataFetch } from '../auth/metadata-fetch.ts'
import { openDb } from '../db/client.ts'
import { Keyring, masterKeyFromEnv } from '../secrets/keyring.ts'

const { values } = parseArgs({ options: { db: { type: 'string' }, origin: { type: 'string', default: 'http://127.0.0.1:7900' }, release: { type: 'string' } } })

if (!values.db) {
  console.error('usage (local development without a station; on a station run sly setup): pnpm bootstrap --db <sqlite file> [--origin http://127.0.0.1:7900] [--release <dir stationd install wrote>] < {"email","password","name"?,"acme_email"?,"hostnames"?: {"dashboard","api"}}')
  process.exit(2)
}

const db = openDb(values.db)
const masterKey = masterKeyFromEnv()
const keyring = new Keyring(db, masterKey)
const auth = new AuthService(db, masterKey, values.origin!, createMetadataFetch(null))

try {
  const input = JSON.parse(await text(process.stdin)) as SetupInput
  const release = values.release
    ? {
        manifest: readFileSync(join(values.release, 'release-manifest.json'), 'utf8'),
        bundle: readFileSync(join(values.release, 'release-manifest.json.sigstore.json'), 'utf8'),
        source: readFileSync(join(values.release, 'source'), 'utf8').trim()
      }
    : null
  process.stdout.write(`${JSON.stringify(await setupInstance({ db, keyring, auth }, { ...input, release }, { type: 'system', id: null, client: 'pnpm-bootstrap' }), null, 2)}\n`)
} catch (error) {
  if (error instanceof SetupError) {
    process.stdout.write(`${JSON.stringify({ error: { code: error.code, explanation: error.message } })}\n`)
    process.exit(1)
  }
  throw error
}
