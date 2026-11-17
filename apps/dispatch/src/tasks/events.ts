import { EventEmitter } from 'node:events'

import { and, asc, count, eq, gt, inArray, lt, sql, sum } from 'drizzle-orm'

import {
  agentEventLimits,
  isLiveAgentEvent,
  type AgentEventInputValue,
  type AgentEventType,
  type AgentEventValue,
} from '@stationly/protocol'

import { invalid } from '../api/errors.ts'
import type { Redactor } from '../api/redaction.ts'
import type { Db } from '../db/client.ts'
import { conversation, conversation_event, task, task_inbox } from '../db/schema.ts'
import { readSetting } from '../db/settings.ts'
import type { Log } from '../log.ts'
import { every } from '../schedule.ts'

import { conversationOf, shapeEvent, terminalConversation, type ConversationRow } from './runner.ts'
import { applyActivity, type TaskRow } from './status.ts'

type Input = AgentEventInputValue
type Caps = { perMachineCount: number; perMachineBytes: number }
type Data = Record<string, unknown>

export type AgentEventLive = AgentEventInputValue

export const agentBus = new EventEmitter()
agentBus.setMaxListeners(0)

const capCheckEvery = 50

type Held = {
  parts: Map<number, string>
  bytes: number
  last: Input
  redact: Redactor
  timer: ReturnType<typeof setTimeout> | null
}

const holders = new WeakMap<Db, Map<string, Held>>()

const heldOf = (db: Db) => {
  let held = holders.get(db)

  if (!held) {
    held = new Map()
    holders.set(db, held)
  }

  return held
}

export const mapStrings = (value: unknown, f: (text: string) => string): unknown => {
  if (typeof value === 'string') {
    return f(value)
  }

  if (Array.isArray(value)) {
    return value.map((item) => mapStrings(item, f))
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, mapStrings(item, f)]),
    )
  }

  return value
}

const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value))

const cutBytes = (text: string, limit: number) =>
  Buffer.byteLength(text) <= limit
    ? text
    : Buffer.from(text).subarray(0, limit).toString('utf8').replace(/�+$/, '')

const cutStrings = (data: Data, limitOf: (key: string) => number) => {
  let truncated = false
  const cut = Object.fromEntries(
    Object.entries(data).map(([key, value]) => {
      if (typeof value !== 'string') {
        return [key, value]
      }

      const text = cutBytes(value, limitOf(key))

      truncated ||= text !== value

      return [key, text]
    }),
  )

  return truncated
    ? {
        ...cut,
        truncated: true,
      }
    : cut
}

const outputLimit = (data: Data, enabled: boolean) => {
  if (enabled) {
    return agentEventLimits.toolOutput
  }

  return data.is_error === true ? agentEventLimits.failedOutput : 0
}

const fit = (data: Data, limit: number): Data => {
  let current = data

  while (byteLength(current) > limit) {
    const longest = Object.entries(current)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .sort((a, b) => b[1].length - a[1].length)[0]

    if (!longest || longest[1].length === 0) {
      break
    }

    current = {
      ...current,
      [longest[0]]: cutBytes(longest[1], Math.floor(Buffer.byteLength(longest[1]) / 2)),
      truncated: true,
    }
  }

  return current
}

export const prepareData = (
  type: AgentEventType,
  raw: Data,
  redact: Redactor,
  outputEnabled: boolean,
) => {
  const redacted = mapStrings(raw, redact) as Data
  const keep = type === 'tool.finished' ? outputLimit(redacted, outputEnabled) : 0
  const { output, ...rest } = redacted
  const base = type === 'tool.finished' && keep > 0 && output !== undefined ? redacted : rest
  const limits = agentEventLimits
  const cut = cutStrings(base, (key) => {
    if (key === 'output') {
      return keep
    }

    return type === 'message' && key === 'text' ? limits.message : limits.string
  })

  return fit(cut, limits.event)
}

const toIso = (value: string, index: number) => {
  const at = new Date(value)

  if (Number.isNaN(at.getTime())) {
    invalid([
      {
        path: `/events/${index}/at`,
        message: 'not a date and time',
      },
    ])
  }

  return at
}

const checkRaw = (events: Input[]) => {
  const issues = events.flatMap((event, index) =>
    byteLength(event) > agentEventLimits.raw
      ? [
          {
            path: `/events/${index}`,
            message: `larger than ${agentEventLimits.raw} bytes`,
          },
        ]
      : [],
  )

  if (issues.length) {
    invalid(issues)
  }
}

const nextSeq = (db: Db, taskId: string) =>
  db
    .update(task)
    .set({
      event_seq: sql`${task.event_seq} + 1`,
    })
    .where(eq(task.id, taskId))
    .returning({
      value: task.event_seq,
    })
    .get().value

const branchOf = (type: AgentEventType, data: Data) =>
  type === 'session.started' && typeof data.branch === 'string' && data.branch ? data.branch : null

const storeEvent = (
  db: Db,
  row: TaskRow,
  event: Input,
  index: number,
  redact: Redactor,
  outputEnabled: boolean,
  now: Date,
) => {
  const at = toIso(event.at, index)
  const session = terminalConversation(db, row, event.session_id, now)
  const shaped = shapeEvent(db, session, event)
  const data = prepareData(shaped.type, shaped.data, redact, outputEnabled)
  const seq = nextSeq(db, row.id)
  const inserted = db
    .insert(conversation_event)
    .values({
      task_id: row.id,
      seq,
      event_id: event.id,
      conversation_id: session.id,
      prompt_id: event.prompt_id ?? null,
      turn_id: event.turn_id ?? null,
      agent_id: event.agent_id ?? null,
      type: shaped.type,
      at,
      received_at: now,
      data,
      bytes: byteLength(data),
    })
    .onConflictDoNothing()
    .run().changes

  if (!inserted) {
    return null
  }

  if (shaped.input) {
    db.update(task_inbox)
      .set({
        event_seq: seq,
      })
      .where(eq(task_inbox.id, shaped.input.id))
      .run()
  }

  const branch = branchOf(shaped.type, data)
  const current =
    branch && branch !== row.branch
      ? {
          ...row,
          branch,
        }
      : row

  if (current !== row) {
    db.update(task)
      .set({
        branch: current.branch,
      })
      .where(eq(task.id, row.id))
      .run()
  }

  return {
    seq,
    row: applyActivity(
      db,
      current,
      {
        type: shaped.type,
        at: at.toISOString(),
        session_id: event.session_id,
        prompt_id: event.prompt_id,
        agent_id: event.agent_id,
        data,
      },
      session.id,
    ),
  }
}

const liveOf = (event: Input, redact: Redactor): AgentEventLive => ({
  ...event,
  data: cutStrings(mapStrings(event.data, redact) as Data, () => agentEventLimits.message),
})

const joined = (held: Held): Input => {
  const { last } = held
  const part = last.data as { message_id: string }

  return {
    id: `message:${part.message_id}`,
    type: 'message',
    at: last.at,
    session_id: last.session_id,
    prompt_id: last.prompt_id,
    turn_id: last.turn_id,
    agent_id: last.agent_id,
    data: {
      message_id: part.message_id,
      text: [...held.parts.entries()]
        .sort((a, b) => a[0] - b[0])
        .map((entry) => entry[1])
        .join(''),
    },
  }
}

const holdKey = (taskId: string, event: Input) =>
  `${taskId}:${(event.data as { message_id: string }).message_id}`

const holdPart = (db: Db, row: TaskRow, event: Input, redact: Redactor, onIdle: () => void) => {
  const part = event.data as { index: number; final: boolean; text: string }
  const held = heldOf(db)
  const key = holdKey(row.id, event)
  const entry = held.get(key) ?? {
    parts: new Map<number, string>(),
    bytes: 0,
    last: event,
    redact,
    timer: null,
  }

  if (entry.timer) {
    clearTimeout(entry.timer)
  }

  if (
    !entry.parts.has(part.index) &&
    entry.bytes + Buffer.byteLength(part.text) <= agentEventLimits.partsHeld
  ) {
    entry.parts.set(part.index, part.text)
    entry.bytes += Buffer.byteLength(part.text)
  }

  entry.last = event
  entry.redact = redact
  held.set(key, entry)

  if (part.final) {
    held.delete(key)

    return joined(entry)
  }

  entry.timer = setTimeout(onIdle, agentEventLimits.partsIdleS * 1000)
  entry.timer.unref()

  return null
}

const store = (
  db: Db,
  row: TaskRow,
  events: { event: Input; index: number }[],
  redact: Redactor,
  now: Date,
) => {
  const outputEnabled = readSetting(db, 'machine.agent_events_output')
  let current = row
  let accepted = 0
  let duplicates = 0
  let first: number | null = null
  let last = 0

  db.transaction((tx) => {
    const tdb = tx as unknown as Db

    for (const { event, index } of events) {
      const done = storeEvent(tdb, current, event, index, redact, outputEnabled, now)

      if (!done) {
        duplicates += 1

        continue
      }

      accepted += 1
      current = done.row
      first ??= done.seq
      last = done.seq
    }
  })

  if (
    first !== null &&
    Math.floor(last / capCheckEvery) !== Math.floor((first - 1) / capCheckEvery)
  ) {
    enforceAgentCaps(db, row.id)
  }

  if (accepted) {
    setImmediate(() => agentBus.emit('stored', row.id))
  }

  return {
    accepted,
    duplicates,
  }
}

const flushIdle = (db: Db, taskId: string, key: string, log: Log, now: () => Date) => () => {
  try {
    const held = heldOf(db)
    const entry = held.get(key)
    const row = db.select().from(task).where(eq(task.id, taskId)).get()

    held.delete(key)

    if (entry && row) {
      store(
        db,
        row,
        [
          {
            event: joined(entry),
            index: 0,
          },
        ],
        entry.redact,
        now(),
      )
    }
  } catch (error) {
    log('task.events_flush_failed', {
      task: taskId,
      explanation: (error as Error).message,
      stack: (error as Error).stack,
    })
  }
}

export const recordEvents = (db: Db, row: TaskRow, events: Data[], redact: Redactor) =>
  store(
    db,
    row,
    events.map((event, index) => ({
      event: event as unknown as Input,
      index,
    })),
    redact,
    new Date(),
  )

export const ingestAgentEvents = (
  db: Db,
  row: TaskRow,
  events: Input[],
  redact: Redactor,
  log: Log,
  now: () => Date = () => new Date(),
) => {
  checkRaw(events)

  let live = 0
  const storing: { event: Input; index: number }[] = []

  for (const [index, event] of events.entries()) {
    if (
      event.type === 'attention' &&
      conversationOf(db, row.id, event.session_id)?.origin === 'dashboard'
    ) {
      live += 1
      continue
    }

    if (!isLiveAgentEvent(event.type)) {
      storing.push({
        event,
        index,
      })

      continue
    }

    toIso(event.at, index)
    live += 1
    agentBus.emit('part', row.id, liveOf(event, redact))

    if (event.type !== 'message.part') {
      continue
    }

    const message = holdPart(
      db,
      row,
      event,
      redact,
      flushIdle(db, row.id, holdKey(row.id, event), log, now),
    )

    if (message) {
      storing.push({
        event: message,
        index,
      })
    }
  }

  const result = store(db, row, storing, redact, now())

  return {
    accepted: result.accepted + live,
    duplicates: result.duplicates,
  }
}

export const enforceAgentCaps = (db: Db, taskId: string, limits: Caps = agentEventLimits) => {
  const total = db
    .select({
      n: count(),
      bytes: sum(conversation_event.bytes),
    })
    .from(conversation_event)
    .where(eq(conversation_event.task_id, taskId))
    .get()

  if (
    !total ||
    (total.n <= limits.perMachineCount && Number(total.bytes ?? 0) <= limits.perMachineBytes)
  ) {
    return 0
  }

  let over = Math.max(0, total.n - limits.perMachineCount)
  let bytes = Number(total.bytes ?? 0)
  const doomed: number[] = []

  for (const row of db
    .select({
      seq: conversation_event.seq,
      bytes: conversation_event.bytes,
    })
    .from(conversation_event)
    .where(eq(conversation_event.task_id, taskId))
    .orderBy(asc(conversation_event.seq))
    .all()) {
    if (over <= 0 && bytes <= limits.perMachineBytes) {
      break
    }

    doomed.push(row.seq)
    over -= 1
    bytes -= row.bytes
  }

  for (let i = 0; i < doomed.length; i += 500) {
    db.delete(conversation_event)
      .where(
        and(
          eq(conversation_event.task_id, taskId),
          inArray(conversation_event.seq, doomed.slice(i, i + 500)),
        ),
      )
      .run()
  }

  return doomed.length
}

export const sweepAgentEvents = (db: Db, now = new Date()) => {
  const cutoff = new Date(
    now.getTime() - readSetting(db, 'machine.agent_events_retention_s') * 1000,
  )
  const expired = db
    .delete(conversation_event)
    .where(lt(conversation_event.received_at, cutoff))
    .run().changes
  const trimmed = db
    .selectDistinct({
      id: conversation_event.task_id,
    })
    .from(conversation_event)
    .all()
    .reduce((sumTrimmed, { id }) => sumTrimmed + enforceAgentCaps(db, id), 0)

  return {
    expired,
    trimmed,
  }
}

export const startAgentEventSweep = (db: Db, log: Log) =>
  every(3600, 'machine.agent_events_sweep_failed', log, () => {
    const result = sweepAgentEvents(db)

    if (result.expired || result.trimmed) {
      log('machine.agent_events_swept', result)
    }
  })

export const firstConversationEvent = (db: Db, taskId: string, conversationId: string) =>
  db
    .select({
      seq: conversation_event.seq,
    })
    .from(conversation_event)
    .where(
      and(
        eq(conversation_event.task_id, taskId),
        eq(conversation_event.conversation_id, conversationId),
      ),
    )
    .orderBy(asc(conversation_event.seq))
    .limit(1)
    .get()?.seq

export const taskEventsAfter = (
  db: Db,
  taskId: string,
  since: number,
  limit: number,
  conversationId?: string,
) =>
  db
    .select()
    .from(conversation_event)
    .where(
      and(
        eq(conversation_event.task_id, taskId),
        gt(conversation_event.seq, since),
        conversationId ? eq(conversation_event.conversation_id, conversationId) : sql`1 = 1`,
      ),
    )
    .orderBy(asc(conversation_event.seq))
    .limit(limit)
    .all()

export const sessionIds = (db: Db, taskId: string) =>
  new Map(
    db
      .select({
        id: conversation.id,
        session: conversation.agent_session_id,
      })
      .from(conversation)
      .where(eq(conversation.task_id, taskId))
      .all()
      .map((row) => [row.id, row.session]),
  )

export const shownTaskEvent = (
  row: typeof conversation_event.$inferSelect,
  sessions: Map<string, string>,
  redact: Redactor,
): AgentEventValue =>
  ({
    id: row.event_id,
    seq: row.seq,
    type: row.type,
    at: row.at.toISOString(),
    session_id: sessions.get(row.conversation_id) ?? row.conversation_id,
    conversation_id: row.conversation_id,
    ...(row.prompt_id
      ? {
          prompt_id: row.prompt_id,
        }
      : {}),
    ...(row.turn_id
      ? {
          turn_id: row.turn_id,
        }
      : {}),
    ...(row.agent_id
      ? {
          agent_id: row.agent_id,
        }
      : {}),
    data: mapStrings(row.data, redact),
  }) as AgentEventValue

export type { ConversationRow }
