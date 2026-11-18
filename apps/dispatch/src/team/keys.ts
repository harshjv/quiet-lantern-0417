import { and, asc, eq } from 'drizzle-orm'

import {
  proxiedCredentials,
  workspaceAgents,
  workspaceAgentValues,
  workspaceEnv,
  type WorkspaceAgent,
} from '@stationly/protocol'

import type { AuthService } from '../auth/auth.ts'
import type { Db } from '../db/client.ts'
import { account, machine_user, member_key } from '../db/schema.ts'
import { projectHead, projectSecret } from '../sandboxes/repository-access.ts'
import type { Keyring } from '../secrets/keyring.ts'
import { isProxied } from '../secrets/relay.ts'

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

type MachineUserRow = typeof machine_user.$inferSelect

export const tokenAad = (machineId: string, userId: string) => `machine_user:${machineId}:${userId}`

export const memberToken = (keyring: Keyring, member: MachineUserRow) =>
  member.token_key && member.data_key_id
    ? keyring.decrypt(
        tokenAad(member.machine_id, member.user_id),
        member.data_key_id,
        member.token_key,
      )
    : null

export const membersOf = (db: Db, machineId: string) =>
  db
    .select()
    .from(machine_user)
    .where(eq(machine_user.machine_id, machineId))
    .orderBy(asc(machine_user.uid))
    .all()

export const memberSecrets = (db: Db, keyring: Keyring, machineId: string) => {
  const found: { key: string; value: string }[] = []

  for (const member of membersOf(db, machineId)) {
    const value = memberToken(keyring, member)

    if (value) {
      found.push({
        key: workspaceEnv.token,
        value,
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

type Scope = { project: string; target: string }

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

export type CredentialSource = { key: string; user_id: string } | { key: string; scope: Scope }

const proxiedAgents = workspaceAgentValues.filter((agent) =>
  workspaceAgents[agent].keys.some(isProxied),
)

export const credentialSources = (
  db: Db,
  userId: string | null,
  shared: Scope | null,
): CredentialSource[] =>
  proxiedAgents.flatMap<CredentialSource>((agent) => {
    const names = workspaceAgents[agent].keys
    const own = userId
      ? db
          .select({
            name: member_key.name,
          })
          .from(member_key)
          .where(eq(member_key.user_id, userId))
          .all()
          .map((row) => row.name)
          .filter((name) => names.includes(name))
      : []

    if (own.length) {
      return own.filter(isProxied).map((key) => ({
        key,
        user_id: userId!,
      }))
    }

    return shared
      ? names
          .filter((name) => isProxied(name) && projectHead(db, shared, name))
          .map((key) => ({
            key,
            scope: shared,
          }))
      : []
  })

export const sourceGroups = (key: string) =>
  proxiedAgents.filter((agent) => workspaceAgents[agent].keys.includes(key))

export const credentialValue = (db: Db, keyring: Keyring, source: CredentialSource) =>
  'user_id' in source
    ? memberKeyValue(db, keyring, source.user_id, source.key)
    : projectSecret(db, keyring, source.scope, source.key)

export const memberKeyValue = (db: Db, keyring: Keyring, userId: string, name: string) => {
  const row = db
    .select()
    .from(member_key)
    .where(and(eq(member_key.user_id, userId), eq(member_key.name, name)))
    .get()

  return row ? keyring.decrypt(aad(userId, name), row.data_key_id, row.ciphertext) : null
}

export const credentialHostsOf = (key: string) =>
  isProxied(key) ? proxiedCredentials[key]!.hosts : []

export const touchMemberKey = (db: Db, userId: string, name: string, now = new Date()) =>
  db
    .update(member_key)
    .set({
      last_used_at: now,
    })
    .where(and(eq(member_key.user_id, userId), eq(member_key.name, name)))
    .run()
