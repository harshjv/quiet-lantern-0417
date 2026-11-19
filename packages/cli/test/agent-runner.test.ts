import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { runnerAskRules, type AgentEventInputValue } from '@stationly/protocol'

import type { AgentAdapter, AgentExit } from '../src/agent/adapter.ts'
import {
  claudeAdapter,
  claudeArgs,
  claudeSettings,
  interruptLine,
  userLine,
} from '../src/agent/claude.ts'
import { runSession, type InboxItem, type RunnerDeps } from '../src/agent/runner.ts'

const fakeAdapter = (code: number) => {
  const sent: string[] = []
  const calls: string[] = []
  const waiters: (() => void)[] = []
  let finish: (exit: AgentExit) => void = () => undefined
  const exit = new Promise<AgentExit>((resolve) => {
    finish = resolve
  })
  const adapter: AgentAdapter = {
    agent: 'claude',
    start: () => ({
      send: (text) => void sent.push(text),
      interrupt: () => void calls.push('interrupt'),
      close: () => {
        calls.push('close')
        finish({
          code,
          signal: null,
        })
      },
      halt: () => void calls.push('halt'),
      nextResult: () => new Promise<void>((resolve) => void waiters.push(resolve)),
      stop: () => void calls.push('stop'),
      events: null,
      exit,
    }),
  }

  return {
    adapter,
    sent,
    calls,
    result: () => waiters.shift()?.(),
  }
}

const deps = (
  adapter: AgentAdapter,
  batches: InboxItem[][],
  posted: AgentEventInputValue[],
  acked: string[][],
  calls: string[],
  onWaiting: () => void = () => undefined,
): RunnerDeps => ({
  adapter,
  start: {
    sessionId: 'sess-1',
    resume: false,
    model: null,
    cwd: '/tmp',
  },
  inbox: (_after, waitS) => {
    const next = batches.shift()

    if (next) {
      return Promise.resolve(next)
    }

    if (waitS === 0) {
      return Promise.resolve([])
    }

    onWaiting()

    return new Promise<InboxItem[]>(() => undefined)
  },
  ack: (ids) => Promise.resolve(void acked.push(ids)),
  exited: () => Promise.resolve(void calls.push('exited')),
  post: (events) => Promise.resolve(void posted.push(...events)),
  now: () => new Date('2026-11-13T10:00:00.000Z'),
  sleep: () => Promise.resolve(),
})

test('the runner runs one turn: it sends the prompt, acknowledges it at the result, closes stdin and reports its exit', async () => {
  const fake = fakeAdapter(0)
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
      ],
      posted,
      acked,
      fake.calls,
      () => fake.result(),
    ),
  )

  assert.equal(await code, 0)
  assert.deepEqual(fake.sent, ['first'])
  assert.deepEqual(acked, [['a']])
  assert.deepEqual(fake.calls, ['close', 'exited'])
  assert.deepEqual(posted, [])
})

test('an interrupt reaches the process, settles the turn as interrupted and ends the run', async () => {
  const fake = fakeAdapter(1)
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
      fake.calls,
    ),
  )

  assert.equal(await done, 1)
  assert.deepEqual(fake.calls, ['interrupt', 'close', 'exited'])
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
    allow: ['mcp__stationly'],
    ask: [...runnerAskRules],
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
      `process.stdin.on('data', (chunk) => { fs.appendFileSync(${JSON.stringify(log)}, chunk); process.stdout.write(JSON.stringify({ type: 'result' }) + '\\n') })`,
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
  await process_.nextResult()
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
