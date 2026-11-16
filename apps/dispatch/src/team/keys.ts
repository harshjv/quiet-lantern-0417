import { and, eq } from 'drizzle-orm'

import { workspaceAgents, workspaceAgentValues, type WorkspaceAgent } from '@stationly/protocol'

import type { AuthService } from '../auth/auth.ts'
import type { Db } from '../db/client.ts'
import { account, machine_user, member_key } from '../db/schema.ts'
import { projectSecret } from '../sandboxes/repository-access.ts'
import type { Keyring } from '../secrets/keyring.ts'

export const memberKeyNames = workspaceAgentValues.flatMap((agent) => workspaceAgents[agent].keys)

const aad = (userId: string, name: string) => `member_key:${userId}:${name}`

export const listKeys = (db: Db, userId: string) => {
  const rows = db.select().from(member_key).where(eq(member_key.user_id, userId)).all()

  return memberKeyNames.map((name) => {
    const row = rows.find((entry) => entry.name === name)

    return {
      name,
      set: !!row,
      updated_at: row?.updated_at.toISOString() ?? null,
    }
  })
}

export const setKey = (db: Db, keyring: Keyring, userId: string, name: string, value: string) => {
  const sealed = keyring.encrypt(aad(userId, name), value)
  const now = new Date()

  db.insert(member_key)
    .values({
      user_id: userId,
      name,
      ciphertext: sealed.ciphertext,
      data_key_id: sealed.data_key_id,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [member_key.user_id, member_key.name],
      set: {
        ciphertext: sealed.ciphertext,
        data_key_id: sealed.data_key_id,
        updated_at: now,
      },
    })
    .run()
}

export const deleteKey = (db: Db, userId: string, name: string) =>
  db
    .delete(member_key)
    .where(and(eq(member_key.user_id, userId), eq(member_key.name, name)))
    .run().changes

export const keyEnvFor = (
  db: Db,
  keyring: Keyring,
  userId: string | null,
  agent: WorkspaceAgent,
): [string, string][] => {
  if (!userId) {
    return []
  }

  const names = workspaceAgents[agent].keys
  const rows = db
    .select()
    .from(member_key)
    .where(eq(member_key.user_id, userId))
    .all()
    .filter((row) => names.includes(row.name))

  if (!rows.length) {
    return []
  }

  db.update(member_key)
    .set({
      last_used_at: new Date(),
    })
    .where(eq(member_key.user_id, userId))
    .run()

  return names.map((name) => {
    const row = rows.find((entry) => entry.name === name)

    return [name, row ? keyring.decrypt(aad(userId, name), row.data_key_id, row.ciphertext) : '']
  })
}

export const githubAccountOf = (db: Db, userId: string) =>
  db
    .select({
      id: account.id,
    })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, 'github')))
    .get()

export const githubTokenOf = async (auth: AuthService, db: Db, userId: string | null) => {
  const linked = userId ? githubAccountOf(db, userId) : undefined

  if (!userId || !linked) {
    return null
  }

  return auth.current.api
    .getAccessToken({
      body: {
        accountId: linked.id,
        userId,
      },
    })
    .then((reply) => (reply as { accessToken?: string }).accessToken ?? null)
    .catch(() => null)
}

export const memberSecrets = (db: Db, keyring: Keyring, sandboxId: string) => {
  const members = db.select().from(machine_user).where(eq(machine_user.sandbox_id, sandboxId)).all()
  const found: { key: string; value: string }[] = []

  for (const member of members) {
    if (member.token_key && member.data_key_id) {
      found.push({
        key: 'STATIONLY_TOKEN',
        value: keyring.decrypt(
          `machine_user:${member.sandbox_id}:${member.user_id}`,
          member.data_key_id,
          member.token_key,
        ),
      })
    }

    for (const row of db
      .select()
      .from(member_key)
      .where(eq(member_key.user_id, member.user_id))
      .all()) {
      found.push({
        key: row.name,
        value: keyring.decrypt(aad(row.user_id, row.name), row.data_key_id, row.ciphertext),
      })
    }
  }

  return found
}

type Scope = { project: string; environment: string }

export const projectKeyEnv = (
  db: Db,
  keyring: Keyring,
  scope: Scope,
  agent: WorkspaceAgent,
): [string, string][] =>
  workspaceAgents[agent].keys.flatMap((name) => {
    const value = projectSecret(db, keyring, scope, name)

    return value ? [[name, value] as [string, string]] : []
  })

export const runKeyEnv = (
  db: Db,
  keyring: Keyring,
  userId: string | null,
  agent: WorkspaceAgent,
  shared: Scope | null,
) => {
  const own = keyEnvFor(db, keyring, userId, agent)

  return own.length || !shared ? own : projectKeyEnv(db, keyring, shared, agent)
}

export const runGitHubToken = async (
  auth: AuthService,
  db: Db,
  keyring: Keyring,
  userId: string | null,
  shared: Scope | null,
) =>
  (await githubTokenOf(auth, db, userId)) ??
  (shared ? projectSecret(db, keyring, shared, 'GH_TOKEN') : null)
