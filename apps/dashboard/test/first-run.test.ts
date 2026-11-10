import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { Project } from '../src/lib/api.ts'
import { guideProgress, guideVisible } from '../src/lib/first-run.ts'

const project = (name: string, counts: Partial<Project> = {}): Project => ({
  id: `prj_${name}`,
  name,
  default_environment_id: `env_${name}`,
  environment_count: 1,
  service_count: 0,
  sandbox_count: 0,
  status_counts: {
    green: 0,
    amber: 0,
    red: 0,
    stopped: 0,
    asleep: 0,
  },
  ...counts,
})

const counts = (green: number, amber = 0) => ({
  green,
  amber,
  red: 0,
  stopped: 0,
  asleep: 0,
})

const fresh = {
  projects: [],
  totp: false,
  passkeys: 0,
  passkeysSettled: true,
  tokens: [],
}

test('a fresh instance has every step to do', () => {
  assert.deepEqual(guideProgress(fresh).done, {
    secure: false,
    project: false,
    service: false,
    sandbox: false,
    agent: false,
  })
})

test('a step stays unknown until its data loads', () => {
  const { done } = guideProgress({
    ...fresh,
    totp: undefined,
    passkeys: undefined,
    passkeysSettled: false,
    tokens: undefined,
  })
  assert.equal(done.secure, undefined)
  assert.equal(done.agent, undefined)
})

test('TOTP or a passkey secures the account', () => {
  assert.equal(
    guideProgress({
      ...fresh,
      totp: true,
    }).done.secure,
    true,
  )
  assert.equal(
    guideProgress({
      ...fresh,
      passkeys: 1,
    }).done.secure,
    true,
  )
  assert.equal(
    guideProgress({
      ...fresh,
      passkeys: undefined,
      passkeysSettled: false,
    }).done.secure,
    undefined,
  )
  assert.equal(
    guideProgress({
      ...fresh,
      totp: undefined,
      passkeys: 1,
    }).done.secure,
    true,
  )
})

test('only a healthy service checks off the deploy step', () => {
  const starting = guideProgress({
    ...fresh,
    projects: [
      project('web', {
        service_count: 1,
        status_counts: counts(0, 1),
      }),
    ],
  })
  assert.equal(starting.done.service, false)
  assert.equal(starting.starting, 1)
  assert.equal(starting.services, 1)
  const healthy = guideProgress({
    ...fresh,
    projects: [
      project('web', {
        service_count: 2,
        status_counts: counts(1),
      }),
      project('api', {
        service_count: 1,
        status_counts: counts(1),
      }),
    ],
  })
  assert.equal(healthy.done.service, true)
  assert.equal(healthy.healthy, 2)
  assert.equal(healthy.services, 3)
})

test('sandboxes count across projects', () => {
  const progress = guideProgress({
    ...fresh,
    projects: [
      project('web'),
      project('api', {
        sandbox_count: 2,
      }),
    ],
  })
  assert.equal(progress.done.project, true)
  assert.equal(progress.done.sandbox, true)
  assert.equal(progress.sandboxes, 2)
})

test('an agent is connected once its token makes a call', () => {
  const waiting = guideProgress({
    ...fresh,
    tokens: [
      {
        name: 'mcp:cursor',
        last_used_at: null,
      },
    ],
  })
  assert.equal(waiting.done.agent, false)
  assert.equal(waiting.waiting?.name, 'mcp:cursor')
  assert.equal(waiting.used, undefined)
  const used = guideProgress({
    ...fresh,
    tokens: [
      {
        name: 'mcp:cursor',
        last_used_at: null,
      },
      {
        name: 'mcp:claude-code',
        last_used_at: '2026-11-10T09:00:00Z',
      },
    ],
  })
  assert.equal(used.done.agent, true)
  assert.equal(used.used?.name, 'mcp:claude-code')
})

test('the guide shows while steps remain and stays to celebrate a finish seen open', () => {
  const state = {
    hidden: false,
    known: true,
    complete: false,
    seenOpen: false,
  }
  assert.equal(guideVisible(state), true)
  assert.equal(
    guideVisible({
      ...state,
      known: false,
    }),
    false,
  )
  assert.equal(
    guideVisible({
      ...state,
      hidden: true,
    }),
    false,
  )
  assert.equal(
    guideVisible({
      ...state,
      complete: true,
    }),
    false,
  )
  assert.equal(
    guideVisible({
      ...state,
      complete: true,
      seenOpen: true,
    }),
    true,
  )
})
