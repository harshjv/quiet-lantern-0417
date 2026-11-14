import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  groupSessions,
  matchesTitle,
  sessionLink,
  sessionPlace,
  sessionReason,
  sessionShell,
  sessionTitle,
  topSession,
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

const now = new Date(2026, 10, 13, 12, 0, 0)

const at = (days: number) => new Date(2026, 10, 13 - days, 9, 0, 0).toISOString()

test('sessions group as waiting on you, then by day, with ended last, newest first and empty groups left out', () => {
  const groups = groupSessions(
    [
      session({
        session_id: 'a',
        status: 'ready',
        last_event_at: at(3),
      }),
      session({
        session_id: 'b',
        status: 'working',
        last_event_at: at(0),
      }),
      session({
        session_id: 'c',
        status: 'ended',
        last_event_at: at(0),
      }),
      session({
        session_id: 'd',
        status: 'failed',
        last_event_at: at(1),
      }),
      session({
        session_id: 'e',
        status: 'working',
        last_event_at: at(1),
      }),
      session({
        session_id: 'f',
        status: 'working',
        last_event_at: at(9),
      }),
    ],
    now,
  )

  assert.deepEqual(
    groups.map((g) => [g.label, g.items.map((i) => i.session_id)]),
    [
      ['Waiting on you', ['a']],
      ['Today', ['b']],
      ['Yesterday', ['e']],
      ['Earlier', ['f']],
      ['Ended', ['c', 'd']],
    ],
  )
})

test('the top session is the blocked one, else the newest waiting, else the newest', () => {
  const sessions = [
    session({
      session_id: 'old-wait',
      status: 'waiting',
      last_event_at: at(2),
    }),
    session({
      session_id: 'new-wait',
      status: 'ready',
      last_event_at: at(1),
    }),
    session({
      session_id: 'busy',
      status: 'working',
      last_event_at: at(0),
    }),
  ]

  assert.equal(topSession(sessions, now)?.session_id, 'old-wait')
  assert.equal(topSession(sessions.slice(1), now)?.session_id, 'new-wait')
  assert.equal(topSession(sessions.slice(2), now)?.session_id, 'busy')
  assert.equal(topSession([], now), undefined)
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
  assert.equal(sessionPlace(session({})), 'my-ws · claude · yolo/production')
  assert.equal(
    sessionShell(session({})),
    'sly sandboxes shell my-ws --project yolo --environment production',
  )
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

test('a blocked session ranks above a finished one in Waiting on you', () => {
  const groups = groupSessions(
    [
      session({
        session_id: 'finished-new',
        status: 'ready',
        last_event_at: at(0),
      }),
      session({
        session_id: 'blocked-old',
        status: 'waiting',
        kind: 'permission',
        last_event_at: at(2),
      }),
    ],
    now,
  )

  assert.deepEqual(
    groups[0].items.map((item) => item.session_id),
    ['blocked-old', 'finished-new'],
  )
})
