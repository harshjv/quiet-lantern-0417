import { logError } from '../log.ts'
import type { StationServer, StreamHandle } from '../station/server.ts'

import type { StationSample } from './connections.ts'

export type LiveTick = { at: string; samples: StationSample[] }

export type LiveSubscriber = {
  ids: Set<string>
  deliver: (tick: LiveTick) => void
  notify: (event: 'error' | 'end', data: Record<string, unknown>) => void
}

type Group = {
  key: string
  stationId: string
  subscribers: Set<LiveSubscriber>
  current: StreamHandle | null
  ids: Set<string>
  reconfiguring: Promise<void>
  dirty: boolean
  closeTimer: NodeJS.Timeout | null
  retryTimer: NodeJS.Timeout | null
  buffer: LiveTick | null
  flushTimer: NodeJS.Timeout | null
}

export type LiveOptions = { lingerMs?: number; flushMs?: number; retryMs?: number }

const errorCode = (error: unknown) => (error as { code?: string }).code ?? 'STATION_OFFLINE'

export const createLiveHub = (
  stations: Pick<StationServer, 'openStream'>,
  options: LiveOptions = {},
) => {
  const lingerMs = options.lingerMs ?? 15_000
  const flushMs = options.flushMs ?? 300
  const retryMs = options.retryMs ?? 5_000
  const groups = new Map<string, Group>()
  const claims = new Map<string, () => void>()

  const flush = (g: Group) => {
    if (g.flushTimer) clearTimeout(g.flushTimer)
    g.flushTimer = null
    const tick = g.buffer
    g.buffer = null
    if (!tick) return
    for (const sub of g.subscribers) {
      const samples = tick.samples.filter(
        (s) => s.service_id !== undefined && sub.ids.has(s.service_id),
      )
      if (samples.length)
        sub.deliver({
          at: tick.at,
          samples,
        })
    }
  }

  const take = (g: Group, items: StationSample[]) => {
    for (const item of items) {
      if (g.buffer && g.buffer.at !== item.at) flush(g)
      if (!g.buffer)
        g.buffer = {
          at: item.at,
          samples: [],
        }
      g.buffer.samples.push(item)
    }
    if (g.flushTimer) clearTimeout(g.flushTimer)
    g.flushTimer = setTimeout(() => flush(g), flushMs)
  }

  const wanted = (g: Group) => {
    const ids = new Set<string>()
    for (const sub of g.subscribers) for (const id of sub.ids) ids.add(id)
    return ids
  }

  const covers = (have: Set<string>, want: Set<string>) => [...want].every((id) => have.has(id))

  const scheduleRetry = (g: Group) => {
    if (g.retryTimer || !g.subscribers.size) return
    g.retryTimer = setTimeout(() => {
      g.retryTimer = null
      void reconfigure(g)
    }, retryMs)
  }

  const open = async (g: Group) => {
    g.dirty = false
    const want = wanted(g)
    if (!want.size || (g.current && covers(g.ids, want))) return
    const ids = new Set([...g.ids, ...want])
    let handle: StreamHandle | null = null
    let owed = 0
    try {
      handle = await stations.openStream(
        g.stationId,
        'network.subscribe',
        {
          service_ids: [...ids].sort(),
        },
        {
          onData: (items, bytes) => {
            if (handle && g.current === handle) take(g, items as StationSample[])
            if (handle) handle.credit(bytes)
            else owed += bytes
          },
          onEnd: (reason) => {
            if (!handle || g.current !== handle) return
            g.current = null
            g.ids = new Set()
            flush(g)
            for (const sub of g.subscribers)
              sub.notify('end', {
                station_id: g.stationId,
                reason,
              })
            scheduleRetry(g)
          },
        },
      )
    } catch (error) {
      for (const sub of g.subscribers)
        sub.notify('error', {
          station_id: g.stationId,
          code: errorCode(error),
          explanation: (error as Error).message,
        })
      scheduleRetry(g)
      if (!g.subscribers.size) startLinger(g)
      return
    }
    if (owed) handle.credit(owed)
    const previous = g.current
    g.current = handle
    g.ids = ids
    previous?.cancel()
    if (!g.subscribers.size) startLinger(g)
  }

  const reconfigure = (g: Group) => {
    g.dirty = true
    g.reconfiguring = g.reconfiguring
      .then(() => (g.dirty ? open(g) : undefined))
      .catch((error: unknown) =>
        logError('network.live_reconfigure_failed', {
          station_id: g.stationId,
          message: error instanceof Error ? error.message : String(error),
        }),
      )
    return g.reconfiguring
  }

  const close = (g: Group) => {
    if (g.closeTimer) clearTimeout(g.closeTimer)
    if (g.retryTimer) clearTimeout(g.retryTimer)
    if (g.flushTimer) clearTimeout(g.flushTimer)
    g.current?.cancel()
    groups.delete(g.key)
  }

  const startLinger = (g: Group) => {
    if (g.closeTimer) return
    g.closeTimer = setTimeout(() => {
      g.closeTimer = null
      if (!g.subscribers.size) close(g)
    }, lingerMs)
  }

  const subscribe = (stationId: string, environmentId: string, sub: LiveSubscriber) => {
    const key = `${stationId}|${environmentId}`
    let g = groups.get(key)
    if (!g) {
      g = {
        key,
        stationId,
        subscribers: new Set(),
        current: null,
        ids: new Set(),
        reconfiguring: Promise.resolve(),
        dirty: false,
        closeTimer: null,
        retryTimer: null,
        buffer: null,
        flushTimer: null,
      }
      groups.set(key, g)
    }
    const group = g
    if (group.closeTimer) clearTimeout(group.closeTimer)
    group.closeTimer = null
    group.subscribers.add(sub)
    void reconfigure(group)
    return () => {
      if (!group.subscribers.delete(sub)) return
      if (!group.subscribers.size) startLinger(group)
    }
  }

  const claim = (credential: string, environmentId: string, release: () => void) => {
    const key = `${credential}|${environmentId}`
    const previous = claims.get(key)
    claims.set(key, release)
    previous?.()
    return () => {
      if (claims.get(key) === release) claims.delete(key)
    }
  }

  const shutdown = () => {
    for (const g of [...groups.values()]) close(g)
  }

  return {
    subscribe,
    claim,
    shutdown,
  }
}

export type LiveHub = ReturnType<typeof createLiveHub>
