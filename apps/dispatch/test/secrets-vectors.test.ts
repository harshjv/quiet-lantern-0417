import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { buildRedactor, encodedForms } from '../src/api/redaction.ts'
import { envDigest } from '../src/secrets/deploy.ts'

const load = <T>(name: string) => JSON.parse(readFileSync(new URL(`../../../packages/protocol/testdata/${name}`, import.meta.url), 'utf8')) as T

type RedactionVectors = {
  encodings: { value: string; forms: string[] }[]
  cases: { name: string; known: { key: string; value: string }[]; input: string; output: string }[]
}

type DigestVectors = { cases: { name: string; env: Parameters<typeof envDigest>[0]; digest: string }[] }

const redaction = load<RedactionVectors>('redaction-vectors.json')

test('each value has the encoded forms the shared vectors pin', () => {
  for (const { value, forms } of redaction.encodings) assert.deepEqual(encodedForms(value), forms, value)
})

for (const vector of redaction.cases) {
  test(`redaction vector: ${vector.name}`, () => {
    assert.equal(buildRedactor(vector.known)(vector.input), vector.output)
  })
}

for (const vector of load<DigestVectors>('env-digest-vectors.json').cases) {
  test(`env_digest vector: ${vector.name}`, () => {
    assert.equal(envDigest(vector.env), vector.digest)
  })
}
