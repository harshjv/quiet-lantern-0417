import type { Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

import { messages, type Actor, type MessageBody } from '@stationly/protocol'

import { recordAudit } from '../db/audit.ts'
import type { Db } from '../db/client.ts'
import { sha256Digest } from '../generation/hash.ts'

import { SecretsError } from './errors.ts'
import type { Keyring } from './keyring.ts'
import {
  holdsRedacted,
  isRedacted,
  leaves,
  render,
  type SourceNode,
  type ValueNode,
} from './resolve.ts'
import { decryptLeaf } from './variables.ts'

type ActorValue = Static<typeof Actor>
type SecretsDeliver = MessageBody<'secrets.deliver'>
type Subject = { entity: string; id: string }
type Entry = { key: string; injection: 'env' | 'file'; node: SourceNode }

const base64url = (value: string) => Buffer.from(value, 'utf8').toString('base64url')

export const refsOf = (node: SourceNode) =>
  leaves(node).map((leaf) =>
    leaf.kind === 'value'
      ? {
          secret_value_id: leaf.secret_value_id,
          version: leaf.version,
        }
      : {
          export: {
            service_id: leaf.service_id,
            key: leaf.key,
          },
        },
  )

export const renderEntries = (
  db: Db,
  keyring: Keyring,
  entries: { key: string; node: SourceNode }[],
) => {
  const decrypted = new Map<string, string>()
  const redacted = new Map<string, { key: string; value: string }>()
  const plaintext = (leaf: ValueNode) => {
    const cached = decrypted.get(leaf.secret_value_id)

    if (cached !== undefined) {
      return cached
    }

    const value = decryptLeaf(db, keyring, leaf)

    decrypted.set(leaf.secret_value_id, value)

    if (isRedacted(leaf)) {
      redacted.set(leaf.secret_value_id, {
        key: leaf.key,
        value,
      })
    }

    return value
  }
  const rendered = entries.map((entry) => ({
    key: entry.key,
    value: render(entry.node, plaintext),
    redacted: holdsRedacted(entry.node),
  }))
  const redaction = [
    ...rendered
      .filter((r) => r.redacted)
      .map(({ key, value }) => ({
        key,
        value,
      })),
    ...redacted.values(),
  ]

  return {
    rendered,
    redaction,
    decryptedIds: [...decrypted.keys()],
  }
}

export const renderedDelivery = (
  db: Db,
  keyring: Keyring,
  entries: Entry[],
  delivery: {
    target: SecretsDeliver['target']
    subject: Subject
    env_digest: string
    purpose: SecretsDeliver['purpose']
    actor: ActorValue
  },
): SecretsDeliver => {
  const { rendered, redaction, decryptedIds } = renderEntries(db, keyring, entries)
  const body: SecretsDeliver = {
    target: delivery.target,
    env_digest: delivery.env_digest,
    purpose: delivery.purpose,
    values: entries.map((entry, i) => ({
      key: entry.key,
      injection: entry.injection,
      refs: refsOf(entry.node),
      value: base64url(rendered[i]!.value),
    })),
    redaction: redaction.map((p) => ({
      key: p.key,
      value: base64url(p.value),
    })),
  }

  if (!Value.Check(messages['secrets.deliver'].body, body)) {
    const issue = Value.Errors(messages['secrets.deliver'].body, body).First()

    throw new SecretsError(
      'PROTOCOL_INVALID_MESSAGE',
      `secrets.deliver body does not match its schema at ${issue?.path}: ${issue?.message}`,
    )
  }

  recordAudit(db, {
    actor: delivery.actor,
    action: 'secret.decrypt',
    target: delivery.subject,
    purpose: delivery.purpose,
    after: {
      secret_value_ids: decryptedIds,
    },
  })

  return body
}

export const knownRedaction = (
  db: Db,
  keyring: Keyring,
  entries: { key: string; node: SourceNode }[],
  subject: Subject,
  actor: ActorValue,
  requestId: string,
) => {
  const { redaction, decryptedIds } = renderEntries(db, keyring, entries)

  if (decryptedIds.length) {
    recordAudit(db, {
      actor,
      action: 'secret.decrypt',
      target: subject,
      requestId,
      purpose: 'redaction',
      after: {
        secret_value_ids: decryptedIds,
      },
    })
  }

  return redaction
}

export const ephemeralDelivery = (
  target: SecretsDeliver['target'],
  purpose: SecretsDeliver['purpose'],
  entries: [string, string][],
): SecretsDeliver => ({
  target,
  env_digest: sha256Digest(entries.map(([key]) => key)),
  purpose,
  values: entries.map(([key, value]) => ({
    key,
    injection: 'env' as const,
    refs: [],
    value: base64url(value),
  })),
  redaction: [],
})
