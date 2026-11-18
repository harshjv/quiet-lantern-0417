import { randomBytes } from 'node:crypto'

import {
  credentialPlaceholder,
  proxiedCredentials,
  tokenPrefix,
  workspaceRelayHost,
} from '@stationly/protocol'

export type RelayCredential = { key: string; value: string; token_id: string; expires_at: Date }

export type RelayValue = {
  key: string
  value: string
  placeholder: string
  hosts: string[]
  expires_at: string
}

export const relayHosts = [workspaceRelayHost]

export const newPlaceholder = (prefix = '') =>
  prefix +
  tokenPrefix +
  [...randomBytes(credentialPlaceholder.length)]
    .map((byte) => credentialPlaceholder.alphabet[byte % credentialPlaceholder.alphabet.length])
    .join('')

export const proxiedKeyNames = Object.keys(proxiedCredentials)

export const isProxied = (key: string) => Object.hasOwn(proxiedCredentials, key)

export const newKeyPlaceholders = () =>
  Object.fromEntries(
    Object.entries(proxiedCredentials).map(([key, credential]) => [
      key,
      newPlaceholder(credential.prefix),
    ]),
  )

export const credentialExpiry = (tokenExpires: Date, seconds: number, now = new Date()) =>
  new Date(Math.min(tokenExpires.getTime(), now.getTime() + seconds * 1000))
