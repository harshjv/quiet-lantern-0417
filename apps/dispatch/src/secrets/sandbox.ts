import type { Static } from '@sinclair/typebox'

import { EnvEntry, type Actor, type MessageBody } from '@stationly/protocol'

import type { Db } from '../db/client.ts'

import { knownRedaction, refsOf, renderedDelivery } from './deliver.ts'
import { envDigest } from './deploy.ts'
import { SecretsError } from './errors.ts'
import type { Keyring } from './keyring.ts'
import { Resolver, type SourceNode } from './resolve.ts'

type ActorValue = Static<typeof Actor>
type EnvEntryValue = Static<typeof EnvEntry>
type SecretsDeliver = MessageBody<'secrets.deliver'>

type Entry = { key: string; node: SourceNode }

export const machineEntries = (db: Db, machineId: string): Entry[] => {
  const resolver = Resolver.forMachine(db, machineId)
  const entries: Entry[] = []

  for (const v of resolver.machineKeys()) {
    try {
      entries.push({
        key: v.name,
        node: resolver.resolveMachine(v),
      })
    } catch (error) {
      if (!(error instanceof SecretsError)) {
        throw error
      }
    }
  }

  return entries
}

export const machineEnv = (db: Db, machineId: string) => {
  const entries = machineEntries(db, machineId)
  const env: EnvEntryValue[] = entries.map((entry) => ({
    key: entry.key,
    injection: 'env',
    refs: refsOf(entry.node),
    platform: false,
  }))

  return {
    entries,
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
  const { entries, env_digest } = machineEnv(db, machineId)

  return renderedDelivery(
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
