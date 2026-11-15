import assert from 'node:assert/strict'
import { test } from 'node:test'

import { credentialKey, repositoryUrl } from '../src/lib/new-task.ts'

test('a repository is an https URL or owner/name on GitHub', () => {
  assert.equal(repositoryUrl('harshjv/stationly'), 'https://github.com/harshjv/stationly')
  assert.equal(
    repositoryUrl('https://github.com/harshjv/stationly.git'),
    'https://github.com/harshjv/stationly',
  )
  assert.equal(repositoryUrl('git@github.com:a/b.git'), null)
  assert.equal(repositoryUrl('http://github.com/a/b'), null)
  assert.equal(repositoryUrl(''), null)
})

test('the pasted key is stored under the name that fits it', () => {
  const keys = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']

  assert.equal(credentialKey(keys, 'sk-ant-api03-abc'), 'ANTHROPIC_API_KEY')
  assert.equal(credentialKey(keys, 'sk-ant-oat01-abc'), 'CLAUDE_CODE_OAUTH_TOKEN')
  assert.equal(credentialKey(keys, ''), 'CLAUDE_CODE_OAUTH_TOKEN')
  assert.equal(credentialKey(['CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'], 'x'), 'CODEX_API_KEY')
})
