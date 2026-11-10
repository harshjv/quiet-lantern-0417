import { useEffect, useState } from 'react'

import type { Connections } from './api'

export type LiveNetworkState = 'off' | 'connecting' | 'live' | 'offline'

export type LiveNetwork = {
  state: LiveNetworkState
  at: string | null
  samples: Connections[]
  problem: string | null
}

const idle: LiveNetwork = {
  state: 'off',
  at: null,
  samples: [],
  problem: null,
}

export const useLiveNetwork = (environment: string, enabled: boolean): LiveNetwork => {
  const [live, setLive] = useState<LiveNetwork>(idle)
  useEffect(() => {
    if (!enabled) {
      setLive(idle)
      return
    }
    setLive({
      ...idle,
      state: 'connecting',
    })
    const latest = new Map<string, Connections>()
    const source = new EventSource(
      `/v1/environments/${encodeURIComponent(environment)}/network/live`,
    )
    const publish = (at: string | null, problem: string | null) =>
      setLive((prev) => ({
        state: 'live',
        at: at ?? prev.at,
        samples: [...latest.values()].sort((a, b) => a.service.name.localeCompare(b.service.name)),
        problem,
      }))
    source.addEventListener('network', (message: MessageEvent<string>) => {
      try {
        const tick = JSON.parse(message.data) as { at: string; samples: Connections[] }
        for (const sample of tick.samples) latest.set(sample.service.id, sample)
        publish(tick.at, null)
      } catch {
        return
      }
    })
    const onProblem = (message: MessageEvent<string>) => {
      try {
        const data = JSON.parse(message.data) as {
          code?: string
          explanation?: string
          reason?: string
        }
        setLive((prev) => ({
          ...prev,
          problem:
            data.explanation ?? data.reason ?? data.code ?? 'Live traffic stopped with an error.',
        }))
      } catch {
        return
      }
    }
    source.addEventListener('error', onProblem as EventListener)
    source.addEventListener('end', onProblem as EventListener)
    source.addEventListener('empty', () =>
      setLive((prev) => ({
        ...prev,
        state: 'live',
        problem: 'No service in this environment is running.',
      })),
    )
    source.onopen = () =>
      setLive((prev) => ({
        ...prev,
        state: prev.at ? 'live' : 'connecting',
      }))
    source.onerror = () =>
      setLive((prev) => ({
        ...prev,
        state: source.readyState === EventSource.CLOSED ? 'offline' : 'connecting',
      }))
    return () => source.close()
  }, [environment, enabled])
  return live
}
