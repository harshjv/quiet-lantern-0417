import assert from 'node:assert/strict'
import { test } from 'node:test'

import { githubTokenHelp, githubTokenRefused, needsGithubToken } from '../src/lib/new-task.ts'
import { failedStepText, setupFailure } from '../src/lib/setup-failure.ts'

const failure = (code: string, details: Record<string, unknown> = {}) => ({
  code,
  details,
})

test('the composer asks for a GitHub token only when the server says the repository needs one', () => {
  assert.equal(needsGithubToken(failure('REPO_ACCESS_REQUIRED')), true)
  assert.equal(needsGithubToken(failure('REPO_ACCESS_DENIED')), false)
  assert.equal(needsGithubToken(new Error('nope')), false)
  assert.equal(needsGithubToken(null), false)
})

test('a token the project already has that still cannot read it is an error with no field', () => {
  assert.equal(githubTokenRefused(failure('REPO_ACCESS_DENIED')), true)
  assert.equal(githubTokenRefused(failure('REPO_ACCESS_REQUIRED')), false)
})

test('the token help says why and how to get one', () => {
  assert.match(githubTokenHelp, /^Private or missing repository\./)
  assert.match(githubTokenHelp, /Contents read and write/)
  assert.match(githubTokenHelp, /gh auth token/)
})

const clone = {
  step: 'clone' as const,
  repository: 'https://github.com/harshjv/etherbit-next-ui',
  branch: null,
}

test('a clone that GitHub asked credentials for says so and asks for a token', () => {
  const found = setupFailure({
    ...clone,
    tail: ["fatal: could not read Username for 'https://github.com': No such device or address"],
  })

  assert.equal(found.title, 'Could not clone harshjv/etherbit-next-ui.')
  assert.equal(
    found.advice,
    'Private or missing repository. Add a GitHub token, then start a new task.',
  )
  assert.equal(found.needsToken, true)
})

test('a clone that failed for another reason names the step and shows no token field', () => {
  const found = setupFailure({
    ...clone,
    tail: ['fatal: unable to access: Could not resolve host: github.com'],
  })

  assert.equal(found.title, 'Could not clone harshjv/etherbit-next-ui.')
  assert.equal(found.advice, 'Start a new task.')
  assert.equal(found.needsToken, false)
})

test('every other step has its own plain sentence and a new task as the way out', () => {
  const sentence = (
    step: Parameters<typeof setupFailure>[0]['step'],
    branch: string | null = null,
  ) =>
    setupFailure({
      ...clone,
      step,
      branch,
      tail: [],
    })

  assert.equal(sentence('agent').title, 'Could not install the agent.')
  assert.equal(sentence('config').title, "Could not write the agent's configuration.")
  assert.equal(sentence('git_auth').title, 'Could not set up git sign-in.')
  assert.equal(sentence('checkout', 'release').title, 'Could not check out release.')
  assert.equal(sentence('toolchain').title, "Could not install the repository's toolchain.")
  assert.equal(sentence(null).title, 'Setup did not finish.')

  for (const step of ['agent', 'config', 'git_auth', 'checkout', 'toolchain', null] as const) {
    assert.equal(sentence(step).advice, 'Start a new task.')
    assert.equal(sentence(step).needsToken, false)
  }
})

test('the tooltip of a failed workspace names the step', () => {
  assert.equal(failedStepText('clone'), 'Failed at clone the repository.')
  assert.equal(failedStepText(null), 'Setup did not finish.')
})
