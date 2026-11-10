import { base64Encodings, redaction, urlEncodings, type UrlEncoding } from '@stationly/protocol'

import type { ActorValue } from '../auth/principal.ts'
import type { Db } from '../db/client.ts'
import { logError } from '../log.ts'
import { redactionKnown } from '../secrets/deploy.ts'
import type { Keyring } from '../secrets/keyring.ts'
import { sandboxEnv, sandboxKnown } from '../secrets/sandbox.ts'

const cacheMs = 60_000
const excluded = new RegExp(redaction.excludedPattern)
const tokenPattern = new RegExp(redaction.tokenPattern, 'g')

export type Redactor = (text: string) => string

const redactable = (value: string) =>
  Array.from(value).length >= redaction.minLength && !excluded.test(value)

const hex = (byte: number) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`

const urlEncode = (bytes: Buffer, { unescaped, space }: UrlEncoding) =>
  Array.from(bytes, (byte) =>
    byte === 0x20
      ? space
      : byte < 0x80 && unescaped.includes(String.fromCharCode(byte))
        ? String.fromCharCode(byte)
        : hex(byte),
  ).join('')

export const encodedForms = (value: string) => {
  const bytes = Buffer.from(value, 'utf8')
  return [
    value,
    ...base64Encodings.map((encoding) => bytes.toString(encoding).replace(/=+$/, '')),
    ...urlEncodings.map((encoding) => urlEncode(bytes, encoding)),
  ]
}

export const buildRedactor = (known: { key: string; value: string }[]): Redactor => {
  const pairs = new Map<string, string>()
  for (const { key, value } of known) {
    if (!redactable(value)) continue
    const candidates = encodedForms(value)
    for (const line of value.split('\n')) {
      const trimmed = line.replace(/\r$/, '')
      if (trimmed !== value && redactable(trimmed)) candidates.push(trimmed)
    }
    for (const form of candidates)
      if (form && !pairs.has(form))
        pairs.set(
          form,
          `${redaction.keyedReplacementPrefix}${key}${redaction.keyedReplacementSuffix}`,
        )
  }
  const ordered = [...pairs.keys()].sort((a, b) => Buffer.byteLength(b) - Buffer.byteLength(a))
  const matcher = ordered.length
    ? new RegExp(ordered.map((form) => RegExp.escape(form)).join('|'), 'g')
    : null
  return (text) =>
    (matcher ? text.replace(matcher, (form) => pairs.get(form)!) : text).replace(
      tokenPattern,
      redaction.tokenReplacement,
    )
}

export const createRedaction = (db: Db, keyring: Keyring) => {
  const cache = new Map<string, { at: number; known: { key: string; value: string }[] }>()
  return (deploymentIds: string[], actor: ActorValue, requestId: string): Redactor => {
    const known: { key: string; value: string }[] = []
    const now = Date.now()
    for (const id of new Set(deploymentIds)) {
      let entry = cache.get(id)
      if (!entry || now - entry.at > cacheMs) {
        let found: { key: string; value: string }[] = []
        try {
          found = redactionKnown(db, keyring, id, actor, requestId)
        } catch (error) {
          logError('redaction.unavailable', {
            deployment_id: id,
            explanation: (error as Error).message,
          })
        }
        entry = {
          at: now,
          known: found,
        }
        cache.set(id, entry)
      }
      known.push(...entry.known)
    }
    return buildRedactor(known)
  }
}

export type Redaction = ReturnType<typeof createRedaction>

export const createSandboxRedaction = (db: Db, keyring: Keyring) => {
  const cache = new Map<string, { digest: string; known: { key: string; value: string }[] }>()
  return (sandboxIds: string[], actor: ActorValue, requestId: string): Redactor => {
    const known: { key: string; value: string }[] = []
    for (const id of new Set(sandboxIds)) {
      let digest: string
      try {
        digest = sandboxEnv(db, id).env_digest
      } catch {
        continue
      }
      let entry = cache.get(id)
      if (!entry || entry.digest !== digest) {
        let found: { key: string; value: string }[] = []
        try {
          found = sandboxKnown(db, keyring, id, actor, requestId)
        } catch (error) {
          logError('redaction.unavailable', {
            sandbox_id: id,
            explanation: (error as Error).message,
          })
        }
        entry = {
          digest,
          known: found,
        }
        cache.set(id, entry)
      }
      known.push(...entry.known)
    }
    return buildRedactor(known)
  }
}

export type SandboxRedaction = ReturnType<typeof createSandboxRedaction>
