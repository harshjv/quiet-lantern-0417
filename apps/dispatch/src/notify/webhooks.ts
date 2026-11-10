import { createHmac } from 'node:crypto'

import { asc, eq, gt, lt } from 'drizzle-orm'

import type { Deps } from '../api/context.ts'
import type { Db } from '../db/client.ts'
import { event, notification_channel, type Delivery } from '../db/schema.ts'
import { log as defaultLog, type Log } from '../log.ts'
import type { Keyring } from '../secrets/keyring.ts'
import { emitEvent, eventBus } from '../station/events.ts'

export const retryLadderMs = [10_000, 60_000, 600_000, 3_600_000, 21_600_000]
export const maxAttempts = retryLadderMs.length + 1
const deliveryTimeoutMs = 10_000
const tickMs = 1_000
const windowMs = 8 * 3600 * 1000
const retentionMs = 14 * 24 * 3600 * 1000
const sweepEveryMs = 3600 * 1000

type ChannelRow = typeof notification_channel.$inferSelect
type EventRow = typeof event.$inferSelect
type SealedSecret = { sealed: true; data_key_id: string; ciphertext: string }

export const sealSecret = (keyring: Keyring, channelId: string, secret: string): SealedSecret => {
  const { data_key_id, ciphertext } = keyring.encrypt(`notification_channel:${channelId}`, secret)
  return {
    sealed: true,
    data_key_id,
    ciphertext: ciphertext.toString('base64url'),
  }
}

const secretOf = (keyring: Keyring, channel: ChannelRow) => {
  const sealed = channel.config.secret as SealedSecret
  return keyring.decrypt(
    `notification_channel:${channel.id}`,
    sealed.data_key_id,
    Buffer.from(sealed.ciphertext, 'base64url'),
  )
}

export const eventBody = (
  row: Pick<EventRow, 'id' | 'type' | 'subject' | 'payload' | 'created_at'>,
) =>
  JSON.stringify({
    id: row.id,
    type: row.type,
    subject: row.subject,
    payload: row.payload,
    created_at: row.created_at.toISOString(),
  })

export const post = async (
  keyring: Keyring,
  channel: ChannelRow,
  type: string,
  deliveryId: string,
  body: string,
) => {
  const signature = `sha256=${createHmac('sha256', secretOf(keyring, channel)).update(body).digest('hex')}`
  const started = Date.now()
  try {
    const response = await fetch(channel.config.url as string, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'stationly-dispatch',
        'x-stationly-event': type,
        'x-stationly-delivery': deliveryId,
        'x-stationly-signature': signature,
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(deliveryTimeoutMs),
    })
    await response.body?.cancel()
    return {
      ok: response.status >= 200 && response.status < 300,
      status_code: response.status,
      duration_ms: Date.now() - started,
      error: response.ok ? null : `HTTP ${response.status}`,
    }
  } catch (error) {
    const { message, cause } = error as Error
    const detail: unknown = cause instanceof Error ? cause.message : cause
    return {
      ok: false,
      status_code: null,
      duration_ms: Date.now() - started,
      error: cause ? `${message}: ${String(detail)}` : message,
    }
  }
}

export const channelMatches = (channel: ChannelRow, row: EventRow) => {
  const filter = channel.filter as { types?: string[]; projects?: string[] }
  if (row.created_at.getTime() < channel.created_at.getTime()) return false
  if (
    filter.types?.length &&
    !filter.types.some((t) =>
      t.endsWith('*') ? row.type.startsWith(t.slice(0, -1)) : t === row.type,
    )
  )
    return false
  const projectId = (row.subject as { project_id?: string }).project_id
  if (filter.projects?.length && (!projectId || !filter.projects.includes(projectId))) return false
  return row.type !== 'notification.failing' || (row.subject as { id: string }).id !== channel.id
}

const deliveryIdOf = (eventId: string, channelId: string) => `${eventId}.${channelId}`

const setDelivery = (db: Db, eventId: string, channelId: string, delivery: Delivery) => {
  const row = db
    .select({
      delivered: event.delivered,
    })
    .from(event)
    .where(eq(event.id, eventId))
    .get()
  if (!row) return
  db.update(event)
    .set({
      delivered: {
        ...row.delivered,
        [channelId]: delivery,
      },
    })
    .where(eq(event.id, eventId))
    .run()
}

export const startNotifier = (deps: Pick<Deps, 'db' | 'keyring'>, log: Log = defaultLog) => {
  const { db, keyring } = deps
  const inFlight = new Set<string>()
  let running = false
  let again = false

  const markFailing = (channel: ChannelRow, attempts: number, lastError: string | null) => {
    const fresh = db
      .select()
      .from(notification_channel)
      .where(eq(notification_channel.id, channel.id))
      .get()
    if (!fresh || fresh.status === 'failing') return
    db.update(notification_channel)
      .set({
        status: 'failing',
        failing_since: new Date(),
      })
      .where(eq(notification_channel.id, channel.id))
      .run()
    emitEvent(
      db,
      'notification.failing',
      {
        entity: 'notification_channel',
        id: channel.id,
      },
      {
        notification_channel: channel.id,
        attempts,
        last_error: lastError,
      },
    )
    log('notification.failing', {
      channel_id: channel.id,
      attempts,
      last_error: lastError,
    })
  }

  const attempt = async (channel: ChannelRow, row: EventRow, previous: Delivery) => {
    const key = deliveryIdOf(row.id, channel.id)
    inFlight.add(key)
    try {
      const result = await post(keyring, channel, row.type, key, eventBody(row))
      const attempts = previous.attempts + 1
      if (result.ok) {
        setDelivery(db, row.id, channel.id, {
          status: 'delivered',
          attempts,
          last_error: null,
          delivered_at: new Date().toISOString(),
          next_at: null,
        })
        log('notification.delivered', {
          channel_id: channel.id,
          event_id: row.id,
          type: row.type,
          attempt: attempts,
          status_code: result.status_code,
          duration_ms: result.duration_ms,
        })
        return
      }
      const exhausted = attempts >= maxAttempts
      const nextAt = exhausted
        ? null
        : new Date(Date.now() + retryLadderMs[attempts - 1]!).toISOString()
      setDelivery(db, row.id, channel.id, {
        status: exhausted ? 'failed' : 'pending',
        attempts,
        last_error: result.error,
        delivered_at: null,
        next_at: nextAt,
      })
      log('notification.attempt_failed', {
        channel_id: channel.id,
        event_id: row.id,
        type: row.type,
        attempt: attempts,
        error: result.error,
        next_at: nextAt,
      })
      if (exhausted) markFailing(channel, attempts, result.error)
    } finally {
      inFlight.delete(key)
    }
  }

  const tick = () => {
    if (running) {
      again = true
      return
    }
    running = true
    try {
      do {
        again = false
        const channels = db
          .select()
          .from(notification_channel)
          .where(eq(notification_channel.status, 'active'))
          .all()
        if (!channels.length) continue
        const recent = db
          .select()
          .from(event)
          .where(gt(event.created_at, new Date(Date.now() - windowMs)))
          .orderBy(asc(event.id))
          .all()
        const now = Date.now()
        for (const row of recent) {
          for (const channel of channels) {
            if (channel.kind !== 'webhook') continue
            const existing = row.delivered[channel.id]
            if (!existing) {
              if (!channelMatches(channel, row)) continue
              const pending: Delivery = {
                status: 'pending',
                attempts: 0,
                last_error: null,
                delivered_at: null,
                next_at: new Date(now).toISOString(),
              }
              setDelivery(db, row.id, channel.id, pending)
              void attempt(channel, row, pending)
              continue
            }
            if (existing.status !== 'pending' || inFlight.has(deliveryIdOf(row.id, channel.id)))
              continue
            if (existing.next_at && Date.parse(existing.next_at) > now) continue
            void attempt(channel, row, existing)
          }
        }
      } while (again)
    } finally {
      running = false
    }
  }

  const sweep = () => {
    const removed = db
      .delete(event)
      .where(lt(event.created_at, new Date(Date.now() - retentionMs)))
      .run().changes
    if (removed)
      log('events.swept', {
        removed,
      })
  }

  const wake = () => {
    try {
      tick()
    } catch (error) {
      log('notification.tick_failed', {
        explanation: (error as Error).message,
      })
    }
  }
  eventBus.on('event', wake)
  const timer = setInterval(wake, tickMs)
  const sweeper = setInterval(sweep, sweepEveryMs)
  timer.unref()
  sweeper.unref()
  sweep()
  wake()
  return {
    stop: () => {
      eventBus.off('event', wake)
      clearInterval(timer)
      clearInterval(sweeper)
    },
  }
}
