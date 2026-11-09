import type { ActorValue } from '../auth/principal.ts'
import type { Db } from '../db/client.ts'
import { redactionKnown } from '../secrets/deploy.ts'
import { sandboxEnv, sandboxKnown } from '../secrets/sandbox.ts'
import type { Keyring } from '../secrets/keyring.ts'

const minLength = 8
const cacheMs = 60_000
const tokenPatterns = /sly_[A-Za-z0-9_-]{8,}|sly-rk-[A-Za-z2-7]{8,}/g

export type Redactor = (text: string) => string

const redactable = (value: string) => value.length >= minLength && !/^[0-9]+$/.test(value)

const forms = (value: string) => {
  const bytes = Buffer.from(value, 'utf8')
  return [
    value,
    bytes.toString('base64').replace(/=+$/, ''),
    bytes.toString('base64url'),
    encodeURIComponent(value),
    encodeURIComponent(value).replace(/%20/g, '+')
  ]
}

export const buildRedactor = (known: { key: string; value: string }[]): Redactor => {
  const pairs = new Map<string, string>()
  for (const { key, value } of known) {
    if (!redactable(value)) continue
    const candidates = forms(value)
    for (const line of value.split('\n')) {
      const trimmed = line.replace(/\r$/, '')
      if (trimmed !== value && redactable(trimmed)) candidates.push(trimmed)
    }
    for (const form of candidates) if (form && !pairs.has(form)) pairs.set(form, `[redacted:${key}]`)
  }
  const ordered = [...pairs.entries()].sort((a, b) => b[0].length - a[0].length)
  return text => {
    let out = text
    for (const [from, to] of ordered) if (out.includes(from)) out = out.split(from).join(to)
    return out.replace(tokenPatterns, '[redacted]')
  }
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
          console.error(JSON.stringify({ event: 'redaction.unavailable', deployment_id: id, explanation: (error as Error).message }))
        }
        entry = { at: now, known: found }
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
          console.error(JSON.stringify({ event: 'redaction.unavailable', sandbox_id: id, explanation: (error as Error).message }))
        }
        entry = { digest, known: found }
        cache.set(id, entry)
      }
      known.push(...entry.known)
    }
    return buildRedactor(known)
  }
}

export type SandboxRedaction = ReturnType<typeof createSandboxRedaction>
