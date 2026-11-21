import type { Static } from '@sinclair/typebox'
import { and, eq } from 'drizzle-orm'

import { EnvEntry, workspaceEnv, type Actor, type MessageBody } from '@stationly/protocol'

import type { Db } from '../db/client.ts'
import { machine, task } from '../db/schema.ts'
import {
  credentialHostsOf,
  credentialSources,
  credentialValue,
  membersOf,
  memberToken,
  sourceGroups,
  type CredentialSource,
} from '../team/keys.ts'

import { base64url, knownRedaction, refsOf, renderedDelivery } from './deliver.ts'
import { envDigest } from './deploy.ts'
import { SecretsError } from './errors.ts'
import type { Keyring } from './keyring.ts'
import { isProxied, relayHosts } from './relay.ts'
import { Resolver, type SourceNode } from './resolve.ts'

type ActorValue = Static<typeof Actor>
type EnvEntryValue = Static<typeof EnvEntry>
type SecretsDeliver = MessageBody<'secrets.deliver'>
type MachineRow = typeof machine.$inferSelect

type Entry = { key: string; node: SourceNode; stationly: boolean }

type Proxied = { key: string; placeholder: string; source: CredentialSource }

export const machineEntries = (db: Db, machineId: string): Entry[] => {
  const resolver = Resolver.forMachine(db, machineId)
  const entries: Entry[] = []

  for (const v of resolver.machineVariables()) {
    try {
      entries.push({
        key: v.name,
        node: resolver.resolveMachine(v),
        stationly: v.kind === 'reference' && v.reference === `\${{project.${v.name}}}`,
      })
    } catch (error) {
      if (!(error instanceof SecretsError)) {
        throw error
      }
    }
  }

  return entries
}

const relayedMembers = (db: Db, machineId: string) =>
  membersOf(db, machineId).flatMap((member) =>
    member.token_placeholder && member.token_key && member.data_key_id
      ? [
          {
            member,
            key: `${workspaceEnv.token}_${member.name.toUpperCase()}`,
            placeholder: member.token_placeholder,
          },
        ]
      : [],
  )

const ownerOf = (db: Db, machineId: string) =>
  db
    .select({
      owner: task.owner,
    })
    .from(task)
    .where(and(eq(task.machine_id, machineId), eq(task.isolated, true)))
    .get()?.owner.id ?? null

const memberCredentials = (db: Db, box: MachineRow): Proxied[] =>
  membersOf(db, box.id).flatMap((member) =>
    credentialSources(db, member.user_id, {
      project: box.project_id,
      target: box.target_id,
    }).flatMap((source) => {
      const placeholder = member.key_placeholders?.[source.key]

      return placeholder
        ? [
            {
              key: `${source.key}_${member.name.toUpperCase()}`,
              placeholder,
              source,
            },
          ]
        : []
    }),
  )

const ownCredentials = (db: Db, box: MachineRow, entries: Entry[]) => {
  const placeholders = box.workspace?.credential_placeholders ?? {}
  const owned = credentialSources(db, ownerOf(db, box.id), null).filter(
    (source) => placeholders[source.key],
  )
  const replaced = new Set(owned.flatMap((source) => sourceGroups(source.key)))
  const kept = entries.filter(
    (entry) =>
      !(
        entry.stationly &&
        isProxied(entry.key) &&
        sourceGroups(entry.key).some((agent) => replaced.has(agent))
      ),
  )

  return {
    kept,
    proxied: owned.map((source) => ({
      key: source.key,
      placeholder: placeholders[source.key]!,
      source,
    })),
    placed: new Map(
      kept.flatMap((entry) =>
        entry.stationly && placeholders[entry.key]
          ? [[entry.key, placeholders[entry.key]!] as [string, string]]
          : [],
      ),
    ),
  }
}

const credentialsOf = (db: Db, machineId: string, all: Entry[]) => {
  const box = db.select().from(machine).where(eq(machine.id, machineId)).get()

  if (!box?.workspace) {
    return {
      entries: all,
      proxied: [] as Proxied[],
      placed: new Map<string, string>(),
    }
  }

  if (box.workspace.kind === 'project') {
    return {
      entries: all,
      proxied: memberCredentials(db, box),
      placed: new Map<string, string>(),
    }
  }

  const own = ownCredentials(db, box, all)

  return {
    entries: own.kept,
    proxied: own.proxied,
    placed: own.placed,
  }
}

const listed = (key: string): EnvEntryValue => ({
  key,
  injection: 'env',
  refs: [],
  platform: false,
})

export const machineEnv = (db: Db, machineId: string) => {
  const { entries, proxied, placed } = credentialsOf(db, machineId, machineEntries(db, machineId))
  const members = relayedMembers(db, machineId)
  const env: EnvEntryValue[] = [
    ...entries.map((entry) => ({
      key: entry.key,
      injection: 'env' as const,
      refs: refsOf(entry.node),
      platform: false,
    })),
    ...members.map((relayed) => listed(relayed.key)),
    ...proxied.map((credential) => listed(credential.key)),
  ]

  return {
    entries,
    members,
    proxied,
    placed,
    env,
    env_digest: envDigest(env),
  }
}

export const machineDeliver = (
  db: Db,
  keyring: Keyring,
  machineId: string,
  actor: ActorValue,
): SecretsDeliver => {
  const { entries, members, proxied, placed, env_digest } = machineEnv(db, machineId)
  const box = db.select().from(machine).where(eq(machine.id, machineId)).get()
  const placeholder = box?.workspace?.token_placeholder
  const relayOnly = box?.workspace?.kind === 'project'
  const body = renderedDelivery(
    db,
    keyring,
    entries.map((entry) => ({
      ...entry,
      injection: 'env' as const,
    })),
    {
      target: {
        sandbox_id: machineId,
      },
      subject: {
        entity: 'machine',
        id: machineId,
      },
      env_digest,
      purpose: 'sandbox',
      actor,
    },
  )

  return {
    ...body,
    values: [
      ...body.values.map((value) => {
        if (value.key === workspaceEnv.token && placeholder) {
          return {
            ...value,
            placeholder,
            hosts: relayHosts,
          }
        }

        const placedAs = placed.get(value.key)

        return placedAs
          ? {
              ...value,
              placeholder: placedAs,
              hosts: credentialHostsOf(value.key),
            }
          : value
      }),
      ...members.map((relayed) => ({
        key: relayed.key,
        injection: 'env' as const,
        refs: [],
        value: base64url(memberToken(keyring, relayed.member)!),
        placeholder: relayed.placeholder,
        hosts: relayHosts,
        relay_only: true,
      })),
      ...proxied.map((credential) => ({
        key: credential.key,
        injection: 'env' as const,
        refs: [],
        value: base64url(credentialValue(db, keyring, credential.source) ?? ''),
        placeholder: credential.placeholder,
        hosts: credentialHostsOf(credential.source.key),
        ...(relayOnly
          ? {
              relay_only: true,
            }
          : {}),
      })),
    ],
  }
}

export const machineKnown = (
  db: Db,
  keyring: Keyring,
  machineId: string,
  actor: ActorValue,
  requestId: string,
) =>
  knownRedaction(
    db,
    keyring,
    machineEntries(db, machineId),
    {
      entity: 'machine',
      id: machineId,
    },
    actor,
    requestId,
  )
