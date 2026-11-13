import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  groupSessions,
  matchesTitle,
  sessionLink,
  sessionMeta,
  sessionReason,
  sessionTitle,
} from '../src/lib/agent-sessions.ts'
import type { AgentSession } from '../src/lib/api.ts'

const session = (fields: Partial<AgentSession>): AgentSession => ({
  session_id: 's1',
  sandbox: {
    id: 'sbx_1',
    name: 'my-ws',
  },
  agent: 'claude',
  project: {
    id: 'prj_1',
    name: 'yolo',
  },
  environment: {
    id: 'env_1',
    name: 'production',
  },
  status: 'working',
  kind: null,
  title: 'fix login redirect',
  started_at: '2026-11-13T10:00:00.000Z',
  last_event_at: '2026-11-13T10:05:00.000Z',
  ...fields,
})

test('sessions group as waiting, working and finished, newest first, and empty groups are left out', () => {
  const groups = groupSessions([
    session({
      session_id: 'a',
      status: 'ready',
      last_event_at: '2026-11-13T09:00:00.000Z',
    }),
    session({
      session_id: 'b',
      status: 'working',
    }),
    session({
      session_id: 'c',
      status: 'ended',
      last_event_at: '2026-11-13T09:30:00.000Z',
    }),
    session({
      session_id: 'd',
      status: 'failed',
      last_event_at: '2026-11-13T09:45:00.000Z',
    }),
  ])

  assert.deepEqual(
    groups.map((g) => [g.label, g.items.map((i) => i.session_id)]),
    [
      ['Working', ['b']],
      ['Finished', ['d', 'c', 'a']],
    ],
  )
  assert.deepEqual(
    groupSessions([
      session({
        status: 'waiting',
        kind: 'plan',
      }),
    ]).map((g) => g.label),
    ['Waiting on you'],
  )
})

test('a waiting session names what it waits for and a finished one says so', () => {
  assert.equal(
    sessionReason(
      session({
        status: 'waiting',
        kind: 'permission',
      }),
    ),
    'Approve a tool call',
  )
  assert.equal(
    sessionReason(
      session({
        status: 'waiting',
        kind: 'question',
      }),
    ),
    'Question',
  )
  assert.equal(
    sessionReason(
      session({
        status: 'waiting',
        kind: 'plan',
      }),
    ),
    'Approve a plan',
  )
  assert.equal(
    sessionReason(
      session({
        status: 'ready',
      }),
    ),
    'Finished, waiting for your reply',
  )
  assert.equal(
    sessionReason(
      session({
        status: 'failed',
      }),
    ),
    'Turn failed',
  )
  assert.equal(
    sessionReason(
      session({
        status: 'working',
      }),
    ),
    null,
  )
  assert.equal(
    sessionReason(
      session({
        status: 'ended',
      }),
    ),
    null,
  )
})

test('the second line names the workspace, agent, project and environment', () => {
  assert.equal(sessionMeta(session({})), 'my-ws · claude · yolo/production')
})

test('a session without a prompt is untitled and search matches titles only, ignoring case', () => {
  assert.equal(
    sessionTitle(
      session({
        title: null,
      }),
    ),
    'Untitled session',
  )
  assert.equal(matchesTitle(session({}), 'LOGIN'), true)
  assert.equal(matchesTitle(session({}), '  '), true)
  assert.equal(matchesTitle(session({}), 'my-ws'), false)
})

test('a session links by workspace id and session id', () => {
  assert.deepEqual(sessionLink(session({})), {
    sandbox: 'sbx_1',
    session: 's1',
  })
})
