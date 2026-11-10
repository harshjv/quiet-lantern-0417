import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto'

import { closeCodes, type ErrorCode, type MessageBody } from '@stationly/protocol'

const helloPrefix = Buffer.from('stationly-station-protocol-v1\x00', 'ascii')
const enrollPrefix = Buffer.from('stationly-station-enroll-v1\x00', 'ascii')
const stationIdPattern = /^stn_[0-9A-HJKMNP-TV-Z]{26}$/
const base64url = /^[A-Za-z0-9_-]*$/

export const nonceTtlMs = 30_000
export const maxSkewMs = 300_000
export const recordSkewMs = 5_000

export type Refusal = {
  code: ErrorCode
  close: number
  explanation: string
  fix: string
  details?: Record<string, unknown>
}

export type Challenge = { nonce: Buffer; issuedAt: number; used: boolean }

export const issueChallenge = (now: number): Challenge => ({
  nonce: randomBytes(32),
  issuedAt: now,
  used: false,
})

export const decodeBase64Url = (value: string, bytes: number) => {
  if (!base64url.test(value)) return undefined
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.length !== bytes || decoded.toString('base64url') !== value) return undefined
  return decoded
}

const timestampBytes = (timestampMs: number) => {
  const out = Buffer.alloc(8)
  out.writeBigUInt64BE(BigInt(timestampMs))
  return out
}

export const helloMessage = (nonce: Buffer, stationId: string, timestampMs: number) => {
  if (!stationIdPattern.test(stationId))
    throw new Error('station id is not stn_ plus 26 Crockford base32 characters')
  return Buffer.concat([
    helloPrefix,
    nonce,
    Buffer.from(stationId, 'ascii'),
    timestampBytes(timestampMs),
  ])
}

export const enrollMessage = (nonce: Buffer, token: string, timestampMs: number) =>
  Buffer.concat([
    enrollPrefix,
    nonce,
    createHash('sha256').update(token, 'utf8').digest(),
    timestampBytes(timestampMs),
  ])

const keyCache = new Map<string, KeyObject>()

export const publicKey = (raw: string) => {
  let key = keyCache.get(raw)
  if (!key) {
    const bytes = decodeBase64Url(raw, 32)
    if (!bytes) throw new Error('identity key is not 32 bytes of base64url')
    key = createPublicKey({
      key: {
        kty: 'OKP',
        crv: 'Ed25519',
        x: raw,
      },
      format: 'jwk',
    })
    keyCache.set(raw, key)
  }
  return key
}

const refuse = (
  code: ErrorCode,
  close: number,
  explanation: string,
  fix: string,
  details?: Record<string, unknown>,
): { ok: false; refusal: Refusal } => ({
  ok: false,
  refusal: {
    code,
    close,
    explanation,
    fix,
    ...(details
      ? {
          details,
        }
      : {}),
  },
})

const consumeChallenge = (challenge: Challenge | undefined, now: number) => {
  if (!challenge)
    return refuse(
      'PROTOCOL_REPLAY',
      closeCodes.authFailed,
      'No challenge was issued on this connection.',
      'Reconnect and answer the challenge.',
      {
        reason: 'unknown',
      },
    )
  if (challenge.used)
    return refuse(
      'PROTOCOL_REPLAY',
      closeCodes.authFailed,
      'The challenge nonce was already used.',
      'Reconnect and answer the new challenge.',
      {
        reason: 'used',
      },
    )
  challenge.used = true
  const age = now - challenge.issuedAt
  if (age >= nonceTtlMs)
    return refuse(
      'PROTOCOL_REPLAY',
      closeCodes.authFailed,
      `The challenge nonce is ${age} ms old; it is valid for ${nonceTtlMs} ms.`,
      'Reconnect and answer the new challenge within 30 s.',
      {
        reason: 'expired',
        age_ms: age,
      },
    )
  return {
    ok: true as const,
    nonce: challenge.nonce,
  }
}

const checkSkew = (timestamp: number, now: number) => {
  const skew = timestamp - now
  if (Math.abs(skew) > maxSkewMs)
    return refuse(
      'PROTOCOL_CLOCK_SKEW',
      closeCodes.authFailed,
      `The station clock is ${Math.round(skew / 1000)} s from Dispatch's clock.`,
      'Fix NTP on the station host.',
      {
        dispatch_time: new Date(now).toISOString(),
        skew_ms: skew,
      },
    )
  return {
    ok: true as const,
    skew,
  }
}

export type HelloVerified = { ok: true; skewMs: number }

export const verifyHello = (
  body: MessageBody<'hello'>,
  station: { identity_key: string | null; revoked_at: Date | null } | undefined,
  challenge: Challenge | undefined,
  now: number,
): HelloVerified | { ok: false; refusal: Refusal } => {
  const signature = decodeBase64Url(body.signature, 64)
  if (!signature)
    return refuse(
      'PROTOCOL_INVALID_MESSAGE',
      closeCodes.authFailed,
      'hello.signature is not 64 bytes of canonical base64url.',
      'Upgrade stationd.',
      {
        issues: ['/signature'],
      },
    )
  if (!station?.identity_key)
    return refuse(
      'PROTOCOL_AUTH_FAILED',
      closeCodes.authFailed,
      'The station is unknown or its signature does not verify.',
      'Check identity/ on the station; enroll it again if the key was lost.',
    )
  const nonce = consumeChallenge(challenge, now)
  if (!nonce.ok) return nonce
  const skew = checkSkew(body.timestamp, now)
  if (!skew.ok) return skew
  const signed = verify(
    null,
    helloMessage(nonce.nonce, body.station_id, body.timestamp),
    publicKey(station.identity_key),
    signature,
  )
  if (!signed)
    return refuse(
      'PROTOCOL_AUTH_FAILED',
      closeCodes.authFailed,
      'The station is unknown or its signature does not verify.',
      'Check identity/ on the station; enroll it again if the key was lost.',
    )
  if (station.revoked_at)
    return refuse(
      'STATION_REVOKED',
      closeCodes.revoked,
      `The station was removed at ${station.revoked_at.toISOString()}.`,
      'Enroll the host again with a new token from sly stations add.',
      {
        revoked_at: station.revoked_at.toISOString(),
      },
    )
  return {
    ok: true,
    skewMs: skew.skew,
  }
}

export type EnrollToken =
  | { kind: 'bootstrap'; sha256: string }
  | { kind: 'row'; id: string; stationId: string; sha256: string; expiresAt: Date }

export const tokenDigest = (token: string) =>
  createHash('sha256').update(token, 'utf8').digest('hex')

export const sameDigest = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

export const verifyEnroll = (
  body: MessageBody<'enroll'>,
  token: EnrollToken | undefined,
  challenge: Challenge | undefined,
  now: number,
): { ok: true; skewMs: number } | { ok: false; refusal: Refusal } => {
  if (!token)
    return refuse(
      'ENROLL_TOKEN_INVALID',
      closeCodes.revoked,
      'The enrollment token is unknown or already used.',
      'Create a new token with sly stations add.',
    )
  if (token.kind === 'row' && now >= token.expiresAt.getTime())
    return refuse(
      'ENROLL_TOKEN_EXPIRED',
      closeCodes.revoked,
      'The enrollment token expired.',
      'Create a new token with sly stations add.',
    )
  const identityKey = decodeBase64Url(body.identity_key, 32)
  const signature = decodeBase64Url(body.signature, 64)
  if (!identityKey || !signature || !decodeBase64Url(body.public_key, 32))
    return refuse(
      'PROTOCOL_INVALID_MESSAGE',
      closeCodes.authFailed,
      'enroll keys and signature must be canonical base64url of 32 and 64 bytes.',
      'Upgrade stationd.',
      {
        issues: ['/identity_key', '/public_key', '/signature'],
      },
    )
  const nonce = consumeChallenge(challenge, now)
  if (!nonce.ok) return nonce
  const skew = checkSkew(body.timestamp, now)
  if (!skew.ok) return skew
  let key: KeyObject
  try {
    key = publicKey(body.identity_key)
  } catch {
    return refuse(
      'PROTOCOL_INVALID_MESSAGE',
      closeCodes.authFailed,
      'identity_key is not an Ed25519 public key.',
      'Upgrade stationd.',
      {
        issues: ['/identity_key'],
      },
    )
  }
  if (!verify(null, enrollMessage(nonce.nonce, body.token, body.timestamp), key, signature))
    return refuse(
      'PROTOCOL_AUTH_FAILED',
      closeCodes.authFailed,
      'The enrollment signature does not verify against identity_key.',
      'Run stationd enroll again.',
    )
  return {
    ok: true,
    skewMs: skew.skew,
  }
}
