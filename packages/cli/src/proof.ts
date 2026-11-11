import { createHash, generateKeyPairSync, randomUUID, type webcrypto } from 'node:crypto'

import { base64url, importJWK, SignJWT } from 'jose'

export type MachineKey = webcrypto.JsonWebKey

export const newMachineKey = (): MachineKey =>
  generateKeyPairSync('ed25519').privateKey.export({
    format: 'jwk',
  })

const htuOf = (url: string) => {
  const parsed = new URL(url)

  if (parsed.protocol === 'ws:') {
    parsed.protocol = 'http:'
  }

  if (parsed.protocol === 'wss:') {
    parsed.protocol = 'https:'
  }

  return `${parsed.origin}${parsed.pathname}`
}

export const proofFor = async (
  key: MachineKey,
  method: string,
  url: string,
  accessToken?: string,
) =>
  new SignJWT({
    htm: method.toUpperCase(),
    htu: htuOf(url),
    ...(accessToken
      ? {
          ath: base64url.encode(createHash('sha256').update(accessToken).digest()),
        }
      : {}),
  })
    .setProtectedHeader({
      typ: 'dpop+jwt',
      alg: 'EdDSA',
      jwk: {
        kty: key.kty!,
        crv: key.crv,
        x: key.x,
      },
    })
    .setJti(randomUUID())
    .setIssuedAt()
    .sign(await importJWK(key, 'EdDSA'))
