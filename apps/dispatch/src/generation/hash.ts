import { createHash } from 'node:crypto'

import canonicalize from 'canonicalize'

export const canonical = (value: unknown) => {
  const text = canonicalize(value)
  if (text === undefined) throw new Error('value has no JSON encoding')
  return text
}

export const sha256Digest = (value: unknown) =>
  `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`

export const hashed = <T extends object>(object: T): T & { hash: string } => ({
  hash: sha256Digest(object),
  ...object,
})
