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

export const sandboxEntries = (db: Db, sandboxId: string): Entry[] => {
  const resolver = Resolver.forSandbox(db, sandboxId)
  const entries: Entry[] = []
  for (const v of resolver.sandboxVariables()) {
    try {
      entries.push({
        key: v.key,
        node: resolver.resolveSandbox(v),
      })
    } catch (error) {
      if (!(error instanceof SecretsError)) throw error
    }
  }
  return entries
}

export const sandboxEnv = (db: Db, sandboxId: string) => {
  const entries = sandboxEntries(db, sandboxId)
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

export const sandboxDeliver = (
  db: Db,
  keyring: Keyring,
  sandboxId: string,
  actor: ActorValue,
): SecretsDeliver => {
  const { entries, env_digest } = sandboxEnv(db, sandboxId)
  return renderedDelivery(
    db,
    keyring,
    entries.map((entry) => ({
      ...entry,
      injection: 'env' as const,
    })),
    {
      target: {
        sandbox_id: sandboxId,
      },
      subject: {
        entity: 'sandbox',
        id: sandboxId,
      },
      env_digest,
      purpose: 'sandbox',
      actor,
    },
  )
}

export const sandboxKnown = (
  db: Db,
  keyring: Keyring,
  sandboxId: string,
  actor: ActorValue,
  requestId: string,
) =>
  knownRedaction(
    db,
    keyring,
    sandboxEntries(db, sandboxId),
    {
      entity: 'sandbox',
      id: sandboxId,
    },
    actor,
    requestId,
  )
