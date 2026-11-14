import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { AgentEventInputValue } from '@stationly/protocol'

import type { AgentAdapter, AgentExit } from '../src/agent/adapter.ts'
import {
  claudeAdapter,
  claudeArgs,
  claudeSettings,
  interruptLine,
  userLine,
} from '../src/agent/claude.ts'
import { runSession, type InboxItem, type RunnerDeps } from '../src/agent/runner.ts'

const fakeAdapter = () => {
  const sent: string[] = []
  const calls: string[] = []
  let finish: (exit: AgentExit) => void = () => undefined
  const exit = new Promise<AgentExit>((resolve) => {
    finish = resolve
  })
  const adapter: AgentAdapter = {
    agent: 'claude',
    start: () => ({
      send: (text) => void sent.push(text),
      interrupt: () => void calls.push('interrupt'),
      stop: () => void calls.push('stop'),
      events: null,
      exit,
    }),
  }

  return {
    adapter,
    sent,
    calls,
    finish,
  }
}

const deps = (
  adapter: AgentAdapter,
  batches: InboxItem[][],
  posted: AgentEventInputValue[],
  acked: string[][],
  onEmpty: () => void,
): RunnerDeps => ({
  adapter,
  start: {
    sessionId: 'sess-1',
    resume: false,
    model: null,
    cwd: '/tmp',
  },
  inbox: () => {
    const next = batches.shift()

    if (next) {
      return Promise.resolve(next)
    }

    onEmpty()

    return new Promise<InboxItem[]>(() => undefined)
  },
  ack: (ids) => Promise.resolve(void acked.push(ids)),
  post: (events) => Promise.resolve(void posted.push(...events)),
  now: () => new Date('2026-11-13T10:00:00.000Z'),
  sleep: () => Promise.resolve(),
})

test('the runner sends prompts to the one process, acknowledges them, and reports the exit as the session ending', async () => {
  const fake = fakeAdapter()
  const posted: AgentEventInputValue[] = []
  const acked: string[][] = []
  const code = runSession(
    deps(
      fake.adapter,
      [
        [
          {
            id: 'a',
            seq: 1,
            kind: 'prompt',
            text: 'first',
          },
        ],
        [
          {
            id: 'b',
            seq: 2,
            kind: 'prompt',
            text: 'second',
          },
        ],
      ],
      posted,
      acked,
      () =>
        fake.finish({
          code: 0,
          signal: null,
        }),
    ),
  )

  assert.equal(await code, 0)
  assert.deepEqual(fake.sent, ['first', 'second'])
  assert.deepEqual(acked, [['a'], ['b']])
  assert.equal(posted.length, 1)
  assert.equal(posted[0]!.type, 'session.ended')
  assert.equal(posted[0]!.session_id, 'sess-1')
  assert.deepEqual(posted[0]!.data, {
    reason: 'process_exited',
    code: 0,
  })
})

test('an interrupt reaches the process and settles the turn as interrupted', async () => {
  const fake = fakeAdapter()
  const posted: AgentEventInputValue[] = []
  const done = runSession(
    deps(
      fake.adapter,
      [
        [
          {
            id: 'i',
            seq: 3,
            kind: 'interrupt',
            text: null,
          },
        ],
      ],
      posted,
      [],
      () =>
        fake.finish({
          code: 1,
          signal: null,
        }),
    ),
  )

  assert.equal(await done, 1)
  assert.deepEqual(fake.calls, ['interrupt'])
  assert.deepEqual(
    posted.map((event) => [event.type, (event.data as { reason?: string }).reason]),
    [
      ['turn.ended', 'interrupted'],
      ['session.ended', 'process_exited'],
    ],
  )
})

test('the Claude Code process is one headless stream-json session in auto mode that denies instead of prompting', () => {
  const args = claudeArgs(
    {
      sessionId: 'abc',
      resume: false,
      model: 'claude-opus-5-5',
    },
    '/state/settings.json',
  )

  assert.deepEqual(args.slice(0, 7), [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--replay-user-messages',
  ])
  assert.ok(args.join(' ').includes('--session-id abc --model claude-opus-5-5'))
  assert.ok(args.join(' ').includes('--permission-mode auto --settings /state/settings.json'))
  assert.ok(
    claudeArgs(
      {
        sessionId: 'abc',
        resume: true,
        model: null,
      },
      '/s',
    )
      .join(' ')
      .includes('--resume abc'),
  )
  assert.deepEqual(claudeSettings.permissions, {
    defaultMode: 'auto',
    denyInsteadOfPrompting: true,
  })
  assert.deepEqual(JSON.parse(userLine('hi')), {
    type: 'user',
    message: {
      role: 'user',
      content: 'hi',
    },
  })
  assert.equal(JSON.parse(interruptLine('r1')).request.subtype, 'interrupt')
})

test('the Claude adapter feeds a real child process its stdin lines and reports its exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-'))
  const log = join(dir, 'stdin.log')
  const script = join(dir, 'claude')

  writeFileSync(
    script,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs')",
      `process.stdin.on('data', (chunk) => fs.appendFileSync(${JSON.stringify(log)}, chunk))`,
      "process.stdin.on('end', () => process.exit(7))",
      '',
    ].join('\n'),
  )
  chmodSync(script, 0o755)

  const process_ = claudeAdapter(script, join(dir, 'state')).start({
    sessionId: 'abc',
    resume: false,
    model: null,
    cwd: dir,
  })

  process_.send('hello')
  process_.interrupt()
  process_.stop()

  const exit = await process_.exit

  assert.equal(exit.code, 7)

  const lines = readFileSync(log, 'utf8').trim().split('\n')

  assert.equal(JSON.parse(lines[0]!).message.content, 'hello')
  assert.equal(JSON.parse(lines[1]!).request.subtype, 'interrupt')
  assert.deepEqual(
    JSON.parse(readFileSync(join(dir, 'state', 'settings.json'), 'utf8')),
    claudeSettings,
  )
})
