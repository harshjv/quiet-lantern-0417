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
  inbox: (after: number) => Promise<InboxItem[]>
  ack: (ids: string[]) => Promise<void>
  post: (events: AgentEventInputValue[]) => Promise<void>
  now: () => Date
  sleep: (ms: number) => Promise<void>
}

export const retryMs = 2000

const event = (
  deps: RunnerDeps,
  type: 'turn.ended' | 'session.ended',
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

export const runSession = async (deps: RunnerDeps) => {
  const process = deps.adapter.start(deps.start)
  const done = process.exit.then((exit) => ({
    exit,
  }))
  const piped = process.events ? pump(deps, process.events) : null
  let after = 0

  for (;;) {
    const next = await Promise.race([
      done,
      deps.inbox(after).then(
        (items) => ({
          items,
        }),
        () => null,
      ),
    ])

    if (next && 'exit' in next) {
      await piped
      await deps.post([event(deps, 'session.ended', exited(next.exit))]).catch(() => undefined)

      return next.exit.code ?? 1
    }

    if (!next) {
      await deps.sleep(retryMs)
      continue
    }

    for (const item of next.items) {
      if (item.kind === 'prompt' && item.text !== null) {
        process.send(item.text)
      }

      if (item.kind === 'interrupt') {
        process.interrupt()
        await deps
          .post([
            event(deps, 'turn.ended', {
              reason: 'interrupted',
            }),
          ])
          .catch(() => undefined)
      }

      after = Math.max(after, item.seq)
    }

    if (next.items.length) {
      await deps.ack(next.items.map((item) => item.id)).catch(() => undefined)
    }
  }
}
