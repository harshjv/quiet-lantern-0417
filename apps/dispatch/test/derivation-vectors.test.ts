import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { networkAddress, networkLayout } from '@stationly/protocol'

import { hashed } from '../src/generation/hash.ts'
import { registryAddress, slash24At } from '../src/net/cidr.ts'
import { projectRepository, projectRepositoryPrefix } from '../src/platform/registry.ts'

const load = (name: string): unknown =>
  JSON.parse(
    readFileSync(new URL(`../../../packages/protocol/testdata/${name}`, import.meta.url), 'utf8'),
  )

type HashVectors = { cases: { name: string; object: Record<string, unknown>; hash: string }[] }

type Subnet = { subnet: string; gateway: string }

type NetworkVectors = {
  cases: {
    name: string
    pool: string
    system: Subnet
    ingress: Subnet
    registry: { subnet: string; address: string }
  }[]
}

type DepotVectors = {
  cases: {
    name: string
    project_id: string
    repository_name: string
    prefix: string
    repository: string
  }[]
}

for (const { name, object, hash } of (load('generation-hash-vectors.json') as HashVectors).cases) {
  test(`generation hash vector: ${name}`, () => {
    const { hash: _outer, ...content } = object

    assert.equal(hashed(content).hash, hash)
  })
}

for (const { name, pool, system, ingress, registry } of (
  load('network-vectors.json') as NetworkVectors
).cases) {
  test(`network vector: ${name}`, () => {
    assert.deepEqual(slash24At(pool, networkLayout.systemIndex), system)
    assert.deepEqual(slash24At(pool, networkLayout.ingressIndex), ingress)
    assert.equal(slash24At(pool, networkLayout.registryFirstIndex).subnet, registry.subnet)
    assert.equal(registryAddress(registry.subnet), registry.address)
    assert.equal(
      `${networkAddress(pool, networkLayout.registryFirstIndex, networkLayout.registryHost)}:${networkLayout.registryPort}`,
      registry.address,
    )
  })
}

for (const vector of (load('depot-vectors.json') as DepotVectors).cases) {
  test(`depot vector: ${vector.name}`, () => {
    assert.equal(projectRepositoryPrefix(vector.project_id), vector.prefix)
    assert.equal(projectRepository(vector.project_id, vector.repository_name), vector.repository)
  })
}
