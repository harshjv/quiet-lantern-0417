import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'

import { agentEventLimits, type AgentEventInputValue } from '@stationly/protocol'

import { eventOf, needsVersion, type HookPayload } from './agent-events.ts'

export type PostResult = {
  status: number
  retryAfterS?: number
  badIndexes?: number[]
}

export type RelayDeps = {
  dir: string
  post: (events: AgentEventInputValue[]) => Promise<PostResult>
  version: (sessionId: string) => Promise<string | undefined>
  now: () => number
  sleep: (ms: number) => Promise<void>
}

export const relayLimits = {
  batchBytes: 256 * 1024,
  spoolBytes: 64 * 1024 * 1024,
  postIntervalMs: 1000,
  pollMs: 250,
  idleExitMs: 5 * 60 * 1000,
  backoffMs: {
    first: 1000,
    last: 30000,
  },
} as const

export const spoolDir = () => join(homedir(), '.local', 'state', 'stationly', 'spool')

const spoolFiles = async (dir: string) =>
  (await readdir(dir)).filter((name) => /^\d+-\d+\.json$/.test(name)).sort()

const sizeOf = async (dir: string, name: string) => (await stat(join(dir, name))).size

const dropOldest = async (dir: string, files: string[]) => {
  const sizes = await Promise.all(files.map((name) => sizeOf(dir, name)))
  let total = sizes.reduce((sum, size) => sum + size, 0)
  let dropped = 0

  while (total > relayLimits.spoolBytes && dropped < files.length) {
    total -= sizes[dropped]!
    await rm(join(dir, files[dropped]!), {
      force: true,
    })
    dropped += 1
  }

  return dropped
}

const payloadOf = async (dir: string, name: string): Promise<HookPayload | null> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, name), 'utf8'))

    return typeof parsed === 'object' && parsed !== null ? (parsed as HookPayload) : null
  } catch {
    return null
  }
}

type Batch = {
  files: string[]
  events: AgentEventInputValue[]
  eventFiles: string[]
}

const batchOf = async (deps: RelayDeps, files: string[]): Promise<Batch> => {
  const batch: Batch = {
    files: [],
    events: [],
    eventFiles: [],
  }
  let bytes = 0

  for (const name of files) {
    if (batch.events.length >= agentEventLimits.batch || bytes >= relayLimits.batchBytes) {
      break
    }

    const payload = await payloadOf(deps.dir, name)
    const version =
      payload && needsVersion(payload) ? await deps.version(String(payload.session_id)) : undefined
    const event = payload
      ? eventOf(name, payload, {
          version,
        })
      : null

    batch.files.push(name)

    const size = event ? Buffer.byteLength(JSON.stringify(event)) : 0

    if (event && size <= agentEventLimits.raw) {
      batch.events.push(event)
      batch.eventFiles.push(name)
      bytes += size
    }
  }

  return batch
}

const badFiles = (batch: Batch, offset: number, result: PostResult) => {
  const named = (result.badIndexes ?? []).flatMap((index) => {
    const name = batch.eventFiles[index - offset]

    return name === undefined ? [] : [name]
  })

  return named.length === result.badIndexes?.length ? [...new Set(named)] : []
}

const removeAll = (dir: string, files: string[]) =>
  Promise.all(
    files.map((name) =>
      rm(join(dir, name), {
        force: true,
      }),
    ),
  )

export const relay = async (deps: RelayDeps) => {
  let omitted = 0
  let backoff: number = relayLimits.backoffMs.first
  let lastPost = Number.NEGATIVE_INFINITY
  let idleSince = deps.now()
  let salvaged = false

  for (;;) {
    const files = await spoolFiles(deps.dir)

    if (files.length === 0) {
      if (deps.now() - idleSince >= relayLimits.idleExitMs) {
        return
      }

      await deps.sleep(relayLimits.pollMs)
      continue
    }

    idleSince = deps.now()
    const dropped = await dropOldest(deps.dir, files)

    omitted += dropped

    const batch = await batchOf(deps, files.slice(dropped))

    if (batch.events.length === 0) {
      await removeAll(deps.dir, batch.files)
      continue
    }

    const first = batch.events[0]!
    const events: AgentEventInputValue[] =
      omitted > 0
        ? [
            {
              id: `omitted-${first.id}`,
              type: 'omitted',
              at: first.at,
              session_id: first.session_id,
              data: {
                count: omitted,
              },
            },
            ...batch.events,
          ]
        : batch.events

    await deps.sleep(Math.max(0, lastPost + relayLimits.postIntervalMs - deps.now()))
    lastPost = deps.now()

    const result: PostResult = await deps.post(events).catch(() => ({
      status: 0,
    }))

    if (result.status >= 200 && result.status < 300) {
      await removeAll(deps.dir, batch.files)
      omitted = 0
      salvaged = false
      backoff = relayLimits.backoffMs.first
      continue
    }

    const retryable = result.status === 0 || result.status === 429 || result.status >= 500

    if (!retryable) {
      const bad = salvaged ? [] : badFiles(batch, events.length - batch.events.length, result)

      if (bad.length > 0) {
        await removeAll(deps.dir, bad)
        salvaged = true

        continue
      }

      await removeAll(deps.dir, batch.files)

      return
    }

    await deps.sleep(Math.max(backoff, (result.retryAfterS ?? 0) * 1000))
    backoff = Math.min(backoff * 2, relayLimits.backoffMs.last)
  }
}

const execFileAsync = promisify(execFile)

export const claudeVersion = () => {
  const cache = new Map<string, Promise<string | undefined>>()

  return (sessionId: string) => {
    const cached = cache.get(sessionId)

    if (cached) {
      return cached
    }

    const lookup = execFileAsync('claude', ['--version'], {
      timeout: 5000,
    }).then(
      ({ stdout }) => stdout.trim().split(/\s+/)[0] || undefined,
      () => undefined,
    )

    cache.set(sessionId, lookup)

    return lookup
  }
}

export const realDeps = async (post: RelayDeps['post'], dir = spoolDir()): Promise<RelayDeps> => {
  await mkdir(dir, {
    recursive: true,
  })

  return {
    dir,
    post,
    version: claudeVersion(),
    now: () => Date.now(),
    sleep: (ms) => sleep(ms),
  }
}
