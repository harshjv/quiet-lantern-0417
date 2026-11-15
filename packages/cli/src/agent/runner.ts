import { randomUUID } from 'node:crypto'

import type { AgentEventInputValue } from '@stationly/protocol'

import type { AgentAdapter, AgentExit, StartOptions } from './adapter.ts'

export type InboxItem = {
  id: string
  seq: number
  kind: 'prompt' | 'interrupt'
  text: string | null
}

export type RunnerDeps = {
  adapter: AgentAdapter
  start: StartOptions
  inbox: (after: number, waitS: number) => Promise<InboxItem[]>
  ack: (ids: string[]) => Promise<void>
  exited: (failed: boolean) => Promise<void>
  post: (events: AgentEventInputValue[]) => Promise<void>
  now: () => Date
  sleep: (ms: number) => Promise<void>
}

export const retryMs = 2000

export const inboxWaitS = 25

const event = (
  deps: RunnerDeps,
  type: 'turn.ended' | 'turn.failed' | 'session.ended',
  data: Record<string, unknown>,
) =>
  ({
    id: `runner-${randomUUID()}`,
    type,
    at: deps.now().toISOString(),
    session_id: deps.start.sessionId,
    data,
  }) as AgentEventInputValue

const pump = async (deps: RunnerDeps, events: AsyncIterable<AgentEventInputValue>) => {
  for await (const next of events) {
    await deps.post([next])
  }
}

const exited = (exit: AgentExit) => ({
  reason: 'process_exited',
  ...(exit.code === null
    ? {}
    : {
        code: exit.code,
      }),
  ...(exit.signal === null
    ? {}
    : {
        signal: exit.signal,
      }),
})

const never = new Promise<never>(() => undefined)

const exitAttempts = 3

const report = async (deps: RunnerDeps, failed: boolean) => {
  for (let attempt = 1; attempt <= exitAttempts; attempt += 1) {
    try {
      await deps.exited(failed)

      return
    } catch {
      await deps.sleep(retryMs * attempt)
    }
  }
}

export const runSession = async (deps: RunnerDeps) => {
  const process = deps.adapter.start(deps.start)
  const done = process.exit.then((exit) => ({
    exit,
  }))
  const piped = process.events ? pump(deps, process.events) : null
  const nextResult = () =>
    process.nextResult().then(() => ({
      result: true as const,
    }))
  const poll = (after: number, waitS: number) =>
    deps.inbox(after, waitS).then(
      (items) => ({
        items,
      }),
      () => null,
    )
  let after = 0
  let sent: string[] = []
  let closed = false
  let halted = false
  let settled = false
  let result = nextResult()
  let polling: Promise<{ items: InboxItem[] } | null> = poll(after, inboxWaitS)

  const ack = async (ids: string[]) => {
    if (ids.length) {
      await deps.ack(ids).catch(() => undefined)
    }
  }

  const take = async (items: InboxItem[]) => {
    for (const item of items) {
      if (item.seq <= after) {
        continue
      }

      after = item.seq

      if (item.kind === 'prompt' && item.text !== null) {
        process.send(item.text)
        sent.push(item.id)
      }

      if (item.kind === 'interrupt') {
        settled = true
        process.interrupt()
        await ack([item.id])
        await deps
          .post([
            event(deps, 'turn.ended', {
              reason: 'interrupted',
            }),
          ])
          .catch(() => undefined)
        await settle()
      }
    }
  }

  const settle = async () => {
    await ack(sent)
    sent = []

    if (closed) {
      return
    }

    const waiting = await deps.inbox(after, 0).catch(() => [] as InboxItem[])
    const fresh = waiting.filter((item) => item.seq > after)

    if (fresh.length) {
      await take(fresh)

      return
    }

    process.close()
    closed = true
  }

  const afterClose = async (items: InboxItem[]) => {
    const fresh = items.filter((item) => item.seq > after)

    if (!fresh.length) {
      return
    }

    for (const item of fresh.filter((entry) => entry.kind === 'interrupt')) {
      after = Math.max(after, item.seq)
      await ack([item.id])
      await deps
        .post([
          event(deps, 'turn.ended', {
            reason: 'interrupted',
          }),
        ])
        .catch(() => undefined)
    }

    halted = true
    process.halt()
  }

  for (;;) {
    const next = await Promise.race([done, result, polling])

    if (next && 'exit' in next) {
      await piped

      const failed = !settled && !halted && next.exit.code !== 0

      if (failed) {
        await deps
          .post([
            event(deps, 'turn.failed', {
              error: 'The agent exited before it settled',
              error_details: `exit code ${next.exit.code ?? next.exit.signal ?? 'unknown'}`,
            }),
          ])
          .catch(() => undefined)
      } else if (next.exit.code !== 0 && !halted) {
        await deps.post([event(deps, 'session.ended', exited(next.exit))]).catch(() => undefined)
      }

      await report(deps, failed)

      return next.exit.code ?? 1
    }

    if (next && 'result' in next) {
      settled = true
      result = nextResult()
      await settle()
      continue
    }

    if (!next) {
      await deps.sleep(retryMs)
      polling = halted ? never : poll(after, inboxWaitS)
      continue
    }

    if (closed) {
      await afterClose(next.items)
    } else {
      await take(next.items)
    }

    polling = halted ? never : poll(after, inboxWaitS)
  }
}
