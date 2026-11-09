import assert from 'node:assert/strict'
import { createPrivateKey, createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { enrollMessage, helloMessage, publicKey } from '../src/station/handshake.ts'
import { buildVectors, goVectorsPath, pkcs8Ed25519Prefix, tsVectorsPath, vectorInputs } from '../src/scripts/handshake-vectors.ts'

const load = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as ReturnType<typeof buildVectors>

const identityKeyOf = (seed: Buffer) => {
  const jwk = createPublicKey(createPrivateKey({ key: Buffer.concat([pkcs8Ed25519Prefix, seed]), format: 'der', type: 'pkcs8' })).export({ format: 'jwk' })
  return publicKey(jwk.x as string)
}

test('the committed TypeScript vectors are what the generator produces now', () => {
  assert.deepEqual(load(tsVectorsPath), buildVectors())
})

test('each message is 100 bytes with the nonce right after its prefix', () => {
  const hello = helloMessage(vectorInputs.nonce, vectorInputs.stationId, vectorInputs.timestampMs)
  const enroll = enrollMessage(vectorInputs.nonce, vectorInputs.token, vectorInputs.timestampMs)
  assert.equal(hello.length, 100)
  assert.equal(enroll.length, 100)
  assert.deepEqual(hello.subarray(30, 62), vectorInputs.nonce)
  assert.deepEqual(enroll.subarray(28, 60), vectorInputs.nonce)
})

test('the bytes and signatures built by Go match TypeScript and verify', () => {
  const go = load(goVectorsPath)
  assert.deepEqual(go, buildVectors())
  const identity = identityKeyOf(vectorInputs.seed)
  for (const kind of ['hello', 'enroll'] as const) {
    assert.ok(verify(null, Buffer.from(go[kind].message, 'hex'), identity, Buffer.from(go[kind].signature, 'base64url')), `${kind} signature built by Go does not verify`)
  }
})
