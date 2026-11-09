import { randomBytes } from 'node:crypto'
import { EnvEntry, messages, type Actor, type MessageBody } from '@stationly/protocol'
import type { Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import type { Db } from '../db/client.ts'
import { audit_event } from '../db/schema.ts'
import { envDigest, refsOf, renderEntries } from './deploy.ts'
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
      entries.push({ key: v.key, node: resolver.resolveSandbox(v) })
    } catch (error) {
      if (!(error instanceof SecretsError)) throw error
    }
  }
  return entries
}

export const sandboxEnv = (db: Db, sandboxId: string) => {
  const entries = sandboxEntries(db, sandboxId)
  const env: EnvEntryValue[] = entries.map(entry => ({ key: entry.key, injection: 'env', refs: refsOf(entry.node), platform: false }))
  return { entries, env, env_digest: envDigest(env) }
}

const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64url')

export const sandboxDeliver = (db: Db, keyring: Keyring, sandboxId: string, actor: ActorValue): SecretsDeliver => {
  const { entries, env_digest } = sandboxEnv(db, sandboxId)
  const { rendered, redaction: known, decryptedIds } = renderEntries(db, keyring, entries)
  const values = entries.map((entry, i) => ({ key: entry.key, injection: 'env' as const, refs: refsOf(entry.node), value: b64(rendered[i]!.value) }))
  const redaction = known.map(p => ({ key: p.key, value: b64(p.value) }))
  const body: SecretsDeliver = { target: { sandbox_id: sandboxId }, env_digest, purpose: 'sandbox', values, redaction }
  if (!Value.Check(messages['secrets.deliver'].body, body)) {
    const issue = Value.Errors(messages['secrets.deliver'].body, body).First()
    throw new SecretsError('PROTOCOL_INVALID_MESSAGE', `secrets.deliver body does not match its schema at ${issue?.path}: ${issue?.message}`)
  }
  db.insert(audit_event)
    .values({
      actor,
      action: 'secret.decrypt',
      target: { entity: 'sandbox', id: sandboxId },
      request_id: `req_${randomBytes(8).toString('hex')}`,
      purpose: 'sandbox',
      after: { secret_value_ids: decryptedIds }
    })
    .run()
  return body
}

export const sandboxKnown = (db: Db, keyring: Keyring, sandboxId: string, actor: ActorValue, requestId: string) => {
  const { redaction, decryptedIds } = renderEntries(db, keyring, sandboxEntries(db, sandboxId))
  if (decryptedIds.length) {
    db.insert(audit_event)
      .values({ actor, action: 'secret.decrypt', target: { entity: 'sandbox', id: sandboxId }, request_id: requestId, purpose: 'redaction', after: { secret_value_ids: decryptedIds } })
      .run()
  }
  return redaction
}
