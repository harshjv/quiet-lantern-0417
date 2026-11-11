import assert from 'node:assert/strict'
import { test } from 'node:test'

import { workspaceEgress, workspaceToolchainHosts } from '../src/index.ts'

test('the workspace allowlist carries the hosts a mise toolchain and Docker image pulls need', () => {
  const domains = workspaceEgress('claude').domains.map((entry) => entry.domain)

  for (const host of [
    ...workspaceToolchainHosts,
    'production.cloudfront.docker.com',
    'registry-1.docker.io',
  ]) {
    assert.ok(domains.includes(host), host)
  }
})

test('the allowlist lists no host twice', () => {
  for (const agent of ['claude', 'codex'] as const) {
    const domains = workspaceEgress(agent).domains.map((entry) => entry.domain)

    assert.equal(new Set(domains).size, domains.length)
  }
})
