import assert from 'node:assert/strict'
import { test } from 'node:test'

import { eventOf, summaryOf, transportCapBytes } from '../src/agent-events.ts'

const name = '1731412345123456789-42.json'

const common = {
  session_id: 'sess_1',
  prompt_id: 'prm_1',
  cwd: '/workspaces/app',
}

const map = (payload: Record<string, unknown>, version?: string) =>
  eventOf(
    name,
    {
      ...common,
      ...payload,
    },
    {
      version,
    },
  )

test('every event carries the spool name as id, the write time and the session', () => {
  const event = map({
    hook_event_name: 'Stop',
  })

  assert.equal(event?.id, '1731412345123456789-42')
  assert.equal(event?.at, '2024-11-12T11:52:25.123Z')
  assert.equal(event?.session_id, 'sess_1')
  assert.equal(event?.prompt_id, 'prm_1')
})

test('SessionStart records the source, model, cwd and the Claude Code version', () => {
  assert.deepEqual(
    map(
      {
        hook_event_name: 'SessionStart',
        source: 'startup',
        model: 'opus',
        extra: 'ignored',
      },
      '2.1.322',
    )?.data,
    {
      source: 'startup',
      model: 'opus',
      cwd: '/workspaces/app',
      version: '2.1.322',
    },
  )
})

test('a prompt, a message batch and a turn end map their text', () => {
  assert.deepEqual(
    map({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'fix it',
    })?.data,
    {
      text: 'fix it',
      truncated: undefined,
    },
  )
  assert.deepEqual(
    map({
      hook_event_name: 'MessageDisplay',
      turn_id: 't1',
      message_id: 'm1',
      index: 2,
      final: true,
      delta: 'done\n',
    }),
    {
      id: '1731412345123456789-42',
      at: '2024-11-12T11:52:25.123Z',
      session_id: 'sess_1',
      prompt_id: 'prm_1',
      turn_id: 't1',
      agent_id: undefined,
      type: 'message.part',
      data: {
        message_id: 'm1',
        index: 2,
        final: true,
        text: 'done\n',
      },
    },
  )
  assert.deepEqual(
    map({
      hook_event_name: 'Stop',
      last_assistant_message: 'all done',
    })?.data,
    {
      text: 'all done',
      truncated: undefined,
    },
  )
})

test('tool events carry a one line summary of the input', () => {
  assert.deepEqual(
    map({
      hook_event_name: 'PreToolUse',
      tool_use_id: 'tu1',
      tool_name: 'Bash',
      tool_input: {
        command: 'ls -la\necho second line',
      },
    })?.data,
    {
      tool_use_id: 'tu1',
      name: 'Bash',
      summary: 'ls -la',
    },
  )
  assert.equal(
    summaryOf('Edit', {
      file_path: '/a/b.ts',
      old_string: 'x',
    }),
    '/a/b.ts',
  )
  assert.equal(
    summaryOf('Grep', {
      pattern: 'todo',
      path: '.',
    }),
    'todo',
  )
  assert.equal(
    summaryOf('WebFetch', {
      url: 'https://example.com',
      prompt: 'p',
    }),
    'https://example.com',
  )
  assert.equal(
    summaryOf('Odd', {
      count: 3,
    }),
    '',
  )
})

test('PostToolUse and PostToolUseFailure finish a tool, with the error as output on failure', () => {
  assert.deepEqual(
    map({
      hook_event_name: 'PostToolUse',
      tool_use_id: 'tu1',
      tool_name: 'Read',
      tool_input: {
        file_path: '/a',
      },
      tool_response: 'contents',
      duration_ms: 12.7,
    })?.data,
    {
      tool_use_id: 'tu1',
      name: 'Read',
      summary: '/a',
      is_error: false,
      duration_ms: 12,
      output: 'contents',
      truncated: undefined,
    },
  )
  assert.deepEqual(
    map({
      hook_event_name: 'PostToolUseFailure',
      tool_use_id: 'tu2',
      tool_name: 'Bash',
      tool_input: {
        command: 'false',
      },
      error: 'Exit code 1',
      is_interrupt: false,
    })?.data,
    {
      tool_use_id: 'tu2',
      name: 'Bash',
      summary: 'false',
      is_error: true,
      duration_ms: undefined,
      output: 'Exit code 1',
      truncated: undefined,
    },
  )
})

test('attention kinds follow the tool and the notification type', () => {
  const kind = (payload: Record<string, unknown>) =>
    (map(payload)?.data as { kind?: string } | undefined)?.kind

  assert.equal(
    kind({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: {
        command: 'rm -rf x',
      },
    }),
    'permission',
  )
  assert.equal(
    kind({
      hook_event_name: 'PermissionRequest',
      tool_name: 'AskUserQuestion',
    }),
    'question',
  )
  assert.equal(
    kind({
      hook_event_name: 'PermissionRequest',
      tool_name: 'ExitPlanMode',
    }),
    'plan',
  )
  assert.equal(
    kind({
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
    }),
    'permission',
  )
  assert.equal(
    kind({
      hook_event_name: 'Notification',
      notification_type: 'elicitation_dialog',
    }),
    'question',
  )
  assert.equal(
    kind({
      hook_event_name: 'Notification',
      notification_type: 'agent_needs_input',
    }),
    'question',
  )
  assert.equal(
    kind({
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
    }),
    undefined,
  )
  assert.deepEqual(
    map({
      hook_event_name: 'Elicitation',
      mcp_server_name: 'github',
      message: 'Pick a repo',
      mode: 'form',
    })?.data,
    {
      kind: 'question',
      tool: 'github',
      message: 'Pick a repo',
    },
  )
})

test('StopFailure and SessionEnd map their fields', () => {
  assert.deepEqual(
    map({
      hook_event_name: 'StopFailure',
      error: 'rate_limit',
      error_details: '429 too many',
      last_assistant_message: 'partial',
    })?.data,
    {
      error: 'rate_limit',
      error_details: '429 too many',
      text: 'partial',
    },
  )
  assert.deepEqual(
    map({
      hook_event_name: 'SessionEnd',
      reason: 'logout',
    })?.data,
    {
      reason: 'logout',
    },
  )
})

test('unknown events and payloads missing a needed field are dropped', () => {
  assert.equal(
    map({
      hook_event_name: 'PreCompact',
    }),
    null,
  )
  assert.equal(
    map({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
    }),
    null,
  )
  assert.equal(
    map({
      hook_event_name: 'UserPromptSubmit',
    }),
    null,
  )
  assert.equal(
    map({
      hook_event_name: 'MessageDisplay',
      message_id: 'm',
      delta: 'x',
    }),
    null,
  )
  assert.equal(
    map({
      hook_event_name: 'StopFailure',
    }),
    null,
  )
  assert.equal(
    map({
      hook_event_name: 'PermissionRequest',
    }),
    null,
  )
  assert.equal(
    eventOf(name, {
      hook_event_name: 'Stop',
    }),
    null,
  )
  assert.equal(
    eventOf('not-a-spool-name.json', {
      ...common,
      hook_event_name: 'Stop',
    }),
    null,
  )
})

test('a string past the transport cap is cut on a character boundary and flagged', () => {
  const event = map({
    hook_event_name: 'UserPromptSubmit',
    prompt: 'é'.repeat(transportCapBytes),
  })
  const data = event?.data as { text: string; truncated?: boolean }

  assert.equal(data.truncated, true)
  assert.ok(Buffer.byteLength(data.text) <= transportCapBytes)
  assert.ok(!data.text.includes('�'))
})

const euros = '€'.repeat(40_000)

const bytes = (value: unknown) => Buffer.byteLength(String(value))

test('every string of a failed turn, an attention and a session start is clipped by bytes to the transport cap', () => {
  const failed = map({
    hook_event_name: 'StopFailure',
    error: euros,
    error_details: euros,
    last_assistant_message: euros,
  })?.data as Record<string, unknown>

  for (const field of ['error', 'error_details', 'text']) {
    assert.ok(bytes(failed[field]) <= transportCapBytes, field)
    assert.ok(!String(failed[field]).includes('\uFFFD'), field)
  }

  const attention = map({
    hook_event_name: 'Notification',
    notification_type: 'permission_prompt',
    message: euros,
  })?.data as Record<string, unknown>

  assert.ok(bytes(attention.message) <= transportCapBytes)

  const started = map({
    hook_event_name: 'SessionStart',
    source: euros,
    model: euros,
    cwd: euros,
  })?.data as Record<string, unknown>

  for (const field of ['source', 'model', 'cwd']) {
    assert.ok(bytes(started[field]) <= transportCapBytes, field)
  }
})

test('SubagentStart and SubagentStop map to subagent events that carry the agent id and type', () => {
  const started = map({
    hook_event_name: 'SubagentStart',
    agent_id: 'a408',
    agent_type: 'general-purpose',
  })
  const stopped = map({
    hook_event_name: 'SubagentStop',
    agent_id: 'a408',
    agent_type: 'general-purpose',
  })

  assert.equal(started?.type, 'subagent.started')
  assert.equal(started?.agent_id, 'a408')
  assert.deepEqual(started?.data, {
    agent_type: 'general-purpose',
  })
  assert.equal(stopped?.type, 'subagent.stopped')
  assert.equal(stopped?.agent_id, 'a408')
  assert.equal(
    map({
      hook_event_name: 'SubagentStart',
    }),
    null,
  )
})

test('the recorded run with a background subagent maps to the expected event order', () => {
  const hooks = [
    ['SessionStart', undefined, undefined],
    ['UserPromptSubmit', 'a915', undefined],
    ['PreToolUse', 'a915', undefined],
    ['SubagentStart', 'a915', 'a408'],
    ['PostToolUse', 'a915', undefined],
    ['Stop', 'a915', undefined],
    ['PreToolUse', 'a915', 'a408'],
    ['PostToolUse', 'a915', 'a408'],
    ['UserPromptSubmit', 'fe47', undefined],
    ['SubagentStop', 'fe47', 'a408'],
    ['PreToolUse', 'fe47', undefined],
    ['PostToolUse', 'fe47', undefined],
    ['Stop', 'fe47', undefined],
  ] as const

  const events = hooks.map(([hook, prompt, agent], index) =>
    eventOf(`${String(1731412345000000000n + BigInt(index))}-1.json`, {
      session_id: 'sess_1',
      hook_event_name: hook,
      prompt_id: prompt,
      agent_id: agent,
      agent_type: agent ? 'general-purpose' : undefined,
      tool_use_id: `tu${index}`,
      tool_name: 'Bash',
      prompt: 'go',
    }),
  )

  assert.deepEqual(
    events.map((event) => [event?.type, event?.prompt_id, event?.agent_id]),
    [
      ['session.started', undefined, undefined],
      ['prompt', 'a915', undefined],
      ['tool.started', 'a915', undefined],
      ['subagent.started', 'a915', 'a408'],
      ['tool.finished', 'a915', undefined],
      ['turn.ended', 'a915', undefined],
      ['tool.started', 'a915', 'a408'],
      ['tool.finished', 'a915', 'a408'],
      ['prompt', 'fe47', undefined],
      ['subagent.stopped', 'fe47', 'a408'],
      ['tool.started', 'fe47', undefined],
      ['tool.finished', 'fe47', undefined],
      ['turn.ended', 'fe47', undefined],
    ],
  )
})
