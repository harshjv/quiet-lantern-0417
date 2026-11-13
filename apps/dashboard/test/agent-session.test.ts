import assert from 'node:assert/strict'
import { test } from 'node:test'

import { agentEventTypeValues, type AgentEventValue } from '@stationly/protocol'

import {
  agentStatusView,
  applyPart,
  applyStored,
  emptyAgentState,
  failedCalls,
  isInstanceAdmin,
  runningCalls,
  sessionsOf,
  toolSentence,
  turnsOf,
  type AgentState,
  type ToolCall,
} from '../src/lib/agent-session.ts'
import { agentStreamTypes } from '../src/lib/agent-stream.ts'

let seq = 0

const stored = (
  type: AgentEventValue['type'],
  data: Record<string, unknown>,
  session = 's1',
): AgentEventValue => {
  seq += 1

  return {
    id: `e${seq}`,
    seq,
    type,
    at: new Date(Date.UTC(2026, 10, 12, 10, 0, seq)).toISOString(),
    session_id: session,
    data,
  } as AgentEventValue
}

const fold = (events: AgentEventValue[]): AgentState => events.reduce(applyStored, emptyAgentState)

const call = (name: string, state: ToolCall['state'] = 'done'): ToolCall => ({
  id: name,
  name,
  summary: '',
  state,
  output: null,
  durationMs: null,
})

test('a repeated or older seq is ignored', () => {
  const first = stored('prompt', {
    text: 'a',
  })
  const state = applyStored(applyStored(emptyAgentState, first), first)

  assert.equal(state.events.length, 1)
  assert.equal(
    applyStored(state, {
      ...first,
      seq: 0,
    }).events.length,
    1,
  )
})

test('turns group by prompt and fold consecutive tool calls', () => {
  seq = 0
  const state = fold([
    stored('prompt', {
      text: 'fix it',
    }),
    stored('tool.started', {
      tool_use_id: 't1',
      name: 'Bash',
      summary: 'ls',
    }),
    stored('tool.finished', {
      tool_use_id: 't1',
      name: 'Bash',
      summary: 'ls',
      is_error: false,
    }),
    stored('tool.started', {
      tool_use_id: 't2',
      name: 'Read',
      summary: 'a.ts',
    }),
    stored('message', {
      message_id: 'm1',
      text: 'done',
    }),
    stored('turn.ended', {}),
    stored('prompt', {
      text: 'again',
    }),
  ])
  const turns = turnsOf(state, 's1')

  assert.equal(turns.length, 2)
  assert.equal(turns[0].prompt, 'fix it')
  assert.equal(turns[0].items[0].kind, 'tools')
  assert.equal(turns[0].items.length, 2)
  assert.equal(runningCalls((turns[0].items[0] as { calls: ToolCall[] }).calls), 1)
  assert.notEqual(turns[0].endedAt, null)
  assert.equal(turns[1].endedAt, null)
})

test('a tool.finished after its turn ended is attached to its call by tool_use_id', () => {
  seq = 0
  const state = fold([
    stored('prompt', {
      text: 'go',
    }),
    stored('tool.started', {
      tool_use_id: 't1',
      name: 'Bash',
      summary: 'make',
    }),
    stored('turn.ended', {}),
    stored('prompt', {
      text: 'next',
    }),
    stored('tool.finished', {
      tool_use_id: 't1',
      name: 'Bash',
      summary: 'make',
      is_error: true,
      output: 'boom',
    }),
  ])
  const turns = turnsOf(state, 's1')
  const calls = (turns[0].items[0] as { calls: ToolCall[] }).calls

  assert.equal(calls[0].state, 'failed')
  assert.equal(calls[0].output, 'boom')
  assert.equal(turns[1].items.length, 0)
})

test('a tool.finished without a start makes its own call', () => {
  seq = 0
  const turns = turnsOf(
    fold([
      stored('tool.finished', {
        tool_use_id: 'x',
        name: 'Edit',
        summary: 'a.ts',
        is_error: false,
      }),
    ]),
    's1',
  )

  assert.equal(turns[0].prompt, null)
  assert.equal((turns[0].items[0] as { calls: ToolCall[] }).calls.length, 1)
})

test('live message parts show until the stored message replaces them', () => {
  seq = 0
  const base = fold([
    stored('prompt', {
      text: 'go',
    }),
  ])
  const live = applyPart(base, {
    type: 'message.part',
    session_id: 's1',
    data: {
      message_id: 'm1',
      index: 0,
      final: false,
      text: 'partial',
    },
  })

  assert.equal(turnsOf(live, 's1')[0].items[0].kind, 'live')

  const done = applyStored(
    live,
    stored('message', {
      message_id: 'm1',
      text: 'whole',
    }),
  )
  const items = turnsOf(done, 's1')[0].items

  assert.deepEqual(
    items.map((item) => item.kind),
    ['message'],
  )
})

test('sessions list in order of first event and turns stay inside their session', () => {
  seq = 0
  const state = fold([
    stored(
      'prompt',
      {
        text: 'one',
      },
      'a',
    ),
    stored(
      'prompt',
      {
        text: 'two',
      },
      'b',
    ),
  ])

  assert.deepEqual(
    sessionsOf(state.events).map((session) => session.id),
    ['a', 'b'],
  )
  assert.equal(turnsOf(state, 'b')[0].prompt, 'two')
})

test('a failed turn carries its error', () => {
  seq = 0
  const turns = turnsOf(
    fold([
      stored('prompt', {
        text: 'go',
      }),
      stored('turn.failed', {
        error: 'rate_limit',
      }),
    ]),
    's1',
  )

  assert.equal(turns[0].failure, 'rate_limit')
})

test('tool groups read as one sentence', () => {
  assert.equal(
    toolSentence([
      call('Bash'),
      call('Bash'),
      call('Read'),
      call('Edit'),
      call('Write'),
      call('Edit'),
    ]),
    'Ran 2 commands, read a file, edited 3 files',
  )
  assert.equal(
    toolSentence([call('Grep'), call('mcp__x__y')]),
    'Searched 1 time, used 1 other tool',
  )
  assert.equal(failedCalls([call('Bash', 'failed'), call('Read')]), 1)
})

test('status labels follow the spec and a stuck working status goes stale after five minutes', () => {
  const now = new Date('2026-11-12T10:10:00Z')
  const at = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString()

  assert.equal(agentStatusView(null).label, 'No session yet')
  assert.equal(
    agentStatusView({
      status: 'waiting',
      last_event_at: at(0),
    }).label,
    'Waiting on you',
  )
  assert.equal(
    agentStatusView({
      status: 'waiting',
      last_event_at: at(0),
    }).pulse,
    true,
  )
  assert.equal(
    agentStatusView({
      status: 'ready',
      last_event_at: at(0),
    }).label,
    'Finished, waiting for your reply',
  )
  assert.equal(
    agentStatusView({
      status: 'failed',
      last_event_at: at(0),
    }).tone,
    'danger',
  )
  assert.equal(
    agentStatusView({
      status: 'ended',
      last_event_at: at(0),
    }).tone,
    'neutral',
  )

  const fresh = agentStatusView(
    {
      status: 'working',
      last_event_at: at(4),
    },
    now,
  )

  assert.equal(fresh.label, 'Working')
  assert.equal(fresh.pulse, true)

  const stale = agentStatusView(
    {
      status: 'working',
      last_event_at: at(7),
    },
    now,
  )

  assert.equal(stale.label, 'Working, no activity for 7 min')
  assert.equal(stale.pulse, false)
})

test('an instance admin holds admin on every project and environment', () => {
  assert.equal(
    isInstanceAdmin([
      {
        project_id: '*',
        environment_id: '*',
        level: 'admin',
      },
    ]),
    true,
  )
  assert.equal(
    isInstanceAdmin([
      {
        project_id: 'p',
        environment_id: '*',
        level: 'admin',
      },
    ]),
    false,
  )
  assert.equal(
    isInstanceAdmin([
      {
        project_id: '*',
        environment_id: '*',
        level: 'deploy',
      },
    ]),
    false,
  )
})

test('the dashboard follows every event type the API stores plus the live parts', () => {
  assert.deepEqual([...agentStreamTypes].sort(), [...agentEventTypeValues].sort())
})

const partOf = (index: number, text: string) => ({
  type: 'message.part' as const,
  session_id: 's1',
  data: {
    message_id: 'm1',
    index,
    final: false,
    text,
  },
})

const liveText = (state: AgentState) =>
  turnsOf(state, 's1')[0].items.find((item) => item.kind === 'live')?.text

test('live parts of a message show joined in index order, as they arrive or out of order', () => {
  const base = fold([
    stored('prompt', {
      text: 'go',
    }),
  ])
  const texts = ['one ', 'two ', 'three ', 'four']

  const inOrder = texts.reduce((state, text, index) => applyPart(state, partOf(index, text)), base)

  assert.equal(liveText(inOrder), 'one two three four')

  const shuffled = [2, 0, 3, 1].reduce(
    (state, index) => applyPart(state, partOf(index, texts[index])),
    base,
  )

  assert.equal(liveText(shuffled), 'one two three four')
})

test('a working status with background agents says how many are running', () => {
  const now = new Date('2026-11-12T10:10:00Z')
  const record = (agents: string[]) => ({
    status: 'working' as const,
    last_event_at: now.toISOString(),
    agents,
  })

  assert.equal(agentStatusView(record(['a']), now).label, 'Working, 1 background agent')
  assert.equal(agentStatusView(record(['a', 'b']), now).label, 'Working, 2 background agents')
  assert.equal(agentStatusView(record([]), now).label, 'Working')
})
