import { and, desc, eq, isNull } from 'drizzle-orm'

import type { Db } from '../db/client.ts'
import { key, secret_value } from '../db/schema.ts'

import { SecretsError } from './errors.ts'
import type { Keyring } from './keyring.ts'

export type SecretValueRow = typeof secret_value.$inferSelect

export type Reentry = 'refuse' | 'unset'

export type KeyOwner = { scope: 'app' | 'project' | 'machine'; id: string } | { scope: 'global' }

const ownerColumn = {
  app: key.app_id,
  project: key.project_id,
  machine: key.machine_id,
}

export const keysOf = (db: Pick<Db, 'select'>, owner: KeyOwner) =>
  db
    .select()
    .from(key)
    .where(
      owner.scope === 'global'
        ? eq(key.scope, 'global')
        : and(eq(key.scope, owner.scope), eq(ownerColumn[owner.scope], owner.id)),
    )

export type ValueTarget = SecretValueRow['target']

const refuseReentry = (row: SecretValueRow) => {
  if (row.needs_reentry) {
    throw new SecretsError(
      'SECRETS_NEED_REENTRY',
      `secret_value ${row.id} must be re-entered after a restore`,
      {
        secret_value_id: row.id,
      },
    )
  }

  return row
}

export const headValue = (
  db: Db,
  keyId: string,
  target: ValueTarget,
  reentry: Reentry = 'refuse',
) => {
  const row = db
    .select()
    .from(secret_value)
    .where(
      and(
        eq(secret_value.key_id, keyId),
        eq(secret_value.target, target),
        isNull(secret_value.revoked_at),
      ),
    )
    .orderBy(desc(secret_value.version))
    .limit(1)
    .get()

  if (!row) {
    return undefined
  }

  if (reentry === 'unset' && row.needs_reentry) {
    return undefined
  }

  return refuseReentry(row)
}

export const nextValueVersion = (db: Db, keyId: string, target: ValueTarget) =>
  (db
    .select({
      version: secret_value.version,
    })
    .from(secret_value)
    .where(and(eq(secret_value.key_id, keyId), eq(secret_value.target, target)))
    .orderBy(desc(secret_value.version))
    .limit(1)
    .get()?.version ?? 0) + 1

export const decryptValue = (keyring: Keyring, row: SecretValueRow) =>
  keyring.decrypt(refuseReentry(row).id, row.data_key_id, row.ciphertext)
