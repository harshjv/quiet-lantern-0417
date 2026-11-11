import { useSyncExternalStore } from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ago, stamp } from '@/lib/format'
import { cn } from '@/lib/utils'

type Clock = {
  now: number
  listeners: Set<() => void>
  timer: number | undefined
  subscribe: (listener: () => void) => () => void
}

const clocks = new Map<number, Clock>()

const clockOf = (every: number) => {
  const existing = clocks.get(every)

  if (existing) {
    return existing
  }

  const clock: Clock = {
    now: Date.now(),
    listeners: new Set(),
    timer: undefined,
    subscribe: (listener) => {
      clock.listeners.add(listener)
      clock.now = Date.now()
      clock.timer ??= window.setInterval(() => {
        clock.now = Date.now()

        for (const notify of clock.listeners) {
          notify()
        }
      }, every)

      return () => {
        clock.listeners.delete(listener)

        if (clock.listeners.size > 0) {
          return
        }

        window.clearInterval(clock.timer)
        clock.timer = undefined
      }
    },
  }

  clocks.set(every, clock)

  return clock
}

export const useNow = (every: number) => {
  const clock = clockOf(every)

  return useSyncExternalStore(clock.subscribe, () => clock.now)
}

export function Time({
  value,
  live,
  prefix,
  className,
}: {
  value: string | null | undefined
  live?: boolean
  prefix?: string
  className?: string
}) {
  const now = useNow(live ? 1000 : 15_000)
  const text = `${prefix ? `${prefix} ` : ''}${ago(value, new Date(now))}`

  if (!value) {
    return <span className={className}>{text}</span>
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time dateTime={value} className={cn('whitespace-nowrap', className)}>
          {text}
        </time>
      </TooltipTrigger>
      <TooltipContent>{stamp(value)}</TooltipContent>
    </Tooltip>
  )
}
