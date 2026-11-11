import { useState } from 'react'

import type { Connections } from './api'
import { useEventStream, type StreamState } from './event-stream'

export type LiveNetwork = {
  state: StreamState | 'off'
  at: string | null
  samples: Connections[]
  problem: string | null
}

type Problem = {
  code?: string
  explanation?: string
  reason?: string
}

type Heard = Omit<LiveNetwork, 'state'> & {
  heard: boolean
}

const silence: Heard = {
  heard: false,
  at: null,
  samples: [],
  problem: null,
}

const byName = (a: Connections, b: Connections) => a.service.name.localeCompare(b.service.name)

export const useLiveNetwork = (environment: string, enabled: boolean): LiveNetwork => {
  const url = enabled ? `/v1/environments/${encodeURIComponent(environment)}/network/live` : null
  const [heard, setHeard] = useState(silence)
  const [heardFrom, setHeardFrom] = useState(url)

  if (heardFrom !== url) {
    setHeardFrom(url)
    setHeard(silence)
  }

  const report = (problem: Problem) =>
    setHeard((prev) => ({
      ...prev,
      problem:
        problem.explanation ??
        problem.reason ??
        problem.code ??
        'Live traffic stopped with an error.',
    }))
  const stream = useEventStream<{
    network: { at: string; samples: Connections[] }
    error: Problem
    end: Problem
    empty: unknown
  }>(url, {
    network: (tick) =>
      setHeard((prev) => {
        const latest = new Map(prev.samples.map((sample) => [sample.service.id, sample]))

        for (const sample of tick.samples) {
          latest.set(sample.service.id, sample)
        }

        return {
          heard: true,
          at: tick.at,
          samples: [...latest.values()].sort(byName),
          problem: null,
        }
      }),
    error: report,
    end: report,
    empty: () =>
      setHeard((prev) => ({
        ...prev,
        heard: true,
        problem: 'No service in this environment is running.',
      })),
  })

  return {
    state: url ? (stream === 'live' && !heard.heard ? 'connecting' : stream) : 'off',
    at: heard.at,
    samples: heard.samples,
    problem: heard.problem,
  }
}
