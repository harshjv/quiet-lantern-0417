import { recoveryKeyPrefix, tokenPrefix } from './primitives.ts'

const unreserved = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'

export const redaction = {
  minLength: 8,
  excludedPattern: '^[0-9]+$',
  tokenPattern: `${tokenPrefix}[A-Za-z0-9_-]{8,}|${recoveryKeyPrefix}[A-Za-z2-7]{8,}`,
  tokenReplacement: '[redacted]',
  keyedReplacementPrefix: '[redacted:',
  keyedReplacementSuffix: ']',
} as const

export const base64Encodings = ['base64', 'base64url'] as const

export type Base64Encoding = (typeof base64Encodings)[number]

export type UrlEncoding = { readonly unescaped: string; readonly space: string }

export const urlEncodings: readonly UrlEncoding[] = [
  {
    unescaped: unreserved,
    space: '%20',
  },
  {
    unescaped: unreserved,
    space: '+',
  },
  {
    unescaped: `${unreserved}!'()*`,
    space: '%20',
  },
]
