import { useEffect, useEffectEvent, useState } from 'react'

export type StreamState = 'connecting' | 'live' | 'offline'

type Handlers<T> = {
  [K in keyof T]: (data: T[K], close: () => void) => void
}

export function useEventStream<T extends Record<string, unknown>>(
  url: string | null,
  handlers: Handlers<T>,
): StreamState {
  const [state, setState] = useState<StreamState>(url ? 'connecting' : 'offline')
  const types = Object.keys(handlers).join(',')
  const dispatch = useEffectEvent((type: string, data: unknown, close: () => void) => {
    const handler = handlers[type] as (data: unknown, close: () => void) => void

    handler(data, close)
  })

  useEffect(() => {
    if (!url) {
      setState('offline')

      return
    }

    setState('connecting')
    const source = new EventSource(url)
    const close = () => {
      source.close()
      setState('offline')
    }

    for (const type of types.split(',')) {
      source.addEventListener(type, (message) => {
        if (!(message instanceof MessageEvent) || typeof message.data !== 'string') {
          return
        }

        let data: unknown

        try {
          data = JSON.parse(message.data)
        } catch {
          return
        }

        dispatch(type, data, close)
      })
    }

    source.onopen = () => setState('live')
    source.onerror = () =>
      setState(source.readyState === EventSource.CLOSED ? 'offline' : 'connecting')

    return () => source.close()
  }, [url, types])

  return state
}
