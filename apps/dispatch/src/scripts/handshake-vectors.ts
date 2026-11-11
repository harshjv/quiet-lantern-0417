import { createPrivateKey, sign } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Command } from 'commander'

import { enrollMessage, helloMessage } from '../station/handshake.ts'

export const pkcs8Ed25519Prefix = Buffer.from('302e020100300506032b657004220420', 'hex')

export const vectorInputs = {
  seed: Buffer.from(
    Array.from(
      {
        length: 32,
      },
      (_, i) => i,
    ),
  ),
  nonce: Buffer.from(
    Array.from(
      {
        length: 32,
      },
      (_, i) => 0x40 + i,
    ),
  ),
  stationId: 'stn_01JC7ZABCDEFGHJKMNPQRSTVWX',
  token: 'stationly-vector-token',
  timestampMs: 1793528102317,
}

export const vectorsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/protocol/testdata',
)
export const tsVectorsPath = resolve(vectorsDir, 'handshake-vectors.ts.json')
export const goVectorsPath = resolve(vectorsDir, 'handshake-vectors.go.json')

export const buildVectors = () => {
  const { seed, nonce, stationId, token, timestampMs } = vectorInputs
  const key = createPrivateKey({
    key: Buffer.concat([pkcs8Ed25519Prefix, seed]),
    format: 'der',
    type: 'pkcs8',
  })
  const hello = helloMessage(nonce, stationId, timestampMs)
  const enroll = enrollMessage(nonce, token, timestampMs)

  return {
    seed: seed.toString('base64url'),
    nonce: nonce.toString('base64url'),
    station_id: stationId,
    token,
    timestamp_ms: timestampMs,
    hello: {
      message: hello.toString('hex'),
      signature: sign(null, hello, key).toString('base64url'),
    },
    enroll: {
      message: enroll.toString('hex'),
      signature: sign(null, enroll, key).toString('base64url'),
    },
  }
}

export const handshakeVectorsCommand = (program: Command) =>
  program
    .command('handshake-vectors')
    .description(
      'Write the station handshake test vectors to packages/protocol/testdata/handshake-vectors.ts.json',
    )
    .action(() => {
      mkdirSync(vectorsDir, {
        recursive: true,
      })
      writeFileSync(tsVectorsPath, `${JSON.stringify(buildVectors(), null, 2)}\n`)
    })
