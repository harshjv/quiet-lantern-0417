import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  type webcrypto,
} from 'node:crypto'

export type MachineKey = webcrypto.JsonWebKey

const encode = (value: Buffer | string) => Buffer.from(value).toString('base64url')

export const newMachineKey = (): MachineKey =>
  generateKeyPairSync('ed25519').privateKey.export({
    format: 'jwk',
  })

const htuOf = (url: string) => {
  const parsed = new URL(url)
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:'
  if (parsed.protocol === 'wss:') parsed.protocol = 'https:'
  return `${parsed.origin}${parsed.pathname}`
}

export const proofFor = (key: MachineKey, method: string, url: string, accessToken?: string) => {
  const header = {
    typ: 'dpop+jwt',
    alg: 'EdDSA',
    jwk: {
      kty: key.kty,
      crv: key.crv,
      x: key.x,
    },
  }
  const payload = {
    jti: randomUUID(),
    htm: method.toUpperCase(),
    htu: htuOf(url),
    iat: Math.floor(Date.now() / 1000),
    ...(accessToken
      ? {
          ath: encode(createHash('sha256').update(accessToken).digest()),
        }
      : {}),
  }
  const input = `${encode(JSON.stringify(header))}.${encode(JSON.stringify(payload))}`
  return `${input}.${encode(
    sign(
      null,
      Buffer.from(input),
      createPrivateKey({
        key,
        format: 'jwk',
      }),
    ),
  )}`
}
