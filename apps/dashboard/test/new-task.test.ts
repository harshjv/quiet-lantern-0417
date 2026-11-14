import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  credentialKey,
  isTaskName,
  missingCredential,
  repositoryUrl,
  taskName,
  taskSentence,
} from '../src/lib/new-task.ts'

test('a task is named from the first five words of its prompt, with a suffix to keep it unique', () => {
  assert.equal(
    taskName('Fix the login redirect on the settings page', 'ab12'),
    'fix-the-login-redirect-on-ab12',
  )
  assert.equal(taskName('   ', 'ab12'), 'task-ab12')
  assert.equal(taskName('!!!', 'ab12'), 'task-ab12')
  assert.ok(taskName('a'.repeat(100), 'ab12').length <= 45)
  assert.ok(isTaskName(taskName('Ünïcode and symbols: ***')))
  assert.notEqual(taskName('same'), taskName('same'))
})

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

test('a project needs one of the agent keys', () => {
  assert.equal(missingCredential(['A', 'B'], ['B', 'C']), false)
  assert.equal(missingCredential(['A', 'B'], ['C']), true)
})

test('the sentence under the composer restates the choice', () => {
  assert.equal(
    taskSentence({
      agent: 'Claude Code',
      station: 'station-9bs4jr',
      workspace: null,
    }),
    'Runs with Claude Code on station-9bs4jr in a new workspace, in auto mode: tool calls that would need approval are denied.',
  )
  assert.equal(
    taskSentence({
      agent: 'Claude Code',
      station: null,
      workspace: 'my-ws',
    }),
    'Runs with Claude Code in my-ws, in auto mode: tool calls that would need approval are denied.',
  )
})

test('the pasted key is stored under the name that fits it', () => {
  const keys = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']

  assert.equal(credentialKey(keys, 'sk-ant-api03-abc'), 'ANTHROPIC_API_KEY')
  assert.equal(credentialKey(keys, 'sk-ant-oat01-abc'), 'CLAUDE_CODE_OAUTH_TOKEN')
  assert.equal(credentialKey(keys, ''), 'CLAUDE_CODE_OAUTH_TOKEN')
  assert.equal(credentialKey(['CODEX_API_KEY', 'CODEX_ACCESS_TOKEN'], 'x'), 'CODEX_API_KEY')
})
