import { and, desc, eq, isNull } from 'drizzle-orm'
import type { Db } from '../db/client.ts'
import { secret_value } from '../db/schema.ts'
import { SecretsError } from './errors.ts'
import type { Keyring } from './keyring.ts'

export type SecretValueRow = typeof secret_value.$inferSelect

export type Reentry = 'refuse' | 'unset'

export const inEnvironment = (environmentId: string | null) =>
  environmentId === null ? isNull(secret_value.environment_id) : eq(secret_value.environment_id, environmentId)

const refuseReentry = (row: SecretValueRow) => {
  if (row.needs_reentry) throw new SecretsError('SECRETS_NEED_REENTRY', `secret_value ${row.id} must be re-entered after a restore`, { secret_value_id: row.id })
  return row
}

export const headValue = (db: Db, variableId: string, environmentId: string | null, reentry: Reentry = 'refuse') => {
  const row = db
    .select()
    .from(secret_value)
    .where(and(eq(secret_value.variable_id, variableId), inEnvironment(environmentId), isNull(secret_value.revoked_at)))
    .orderBy(desc(secret_value.version))
    .limit(1)
    .get()
  if (!row) return undefined
  if (reentry === 'unset' && row.needs_reentry) return undefined
  return refuseReentry(row)
}

export const nextValueVersion = (db: Db, variableId: string, environmentId: string | null) =>
  (db
    .select({ version: secret_value.version })
    .from(secret_value)
    .where(and(eq(secret_value.variable_id, variableId), inEnvironment(environmentId)))
    .orderBy(desc(secret_value.version))
    .limit(1)
    .get()?.version ?? 0) + 1

export const decryptValue = (keyring: Keyring, row: SecretValueRow) => keyring.decrypt(refuseReentry(row).id, row.data_key_id, row.ciphertext)
