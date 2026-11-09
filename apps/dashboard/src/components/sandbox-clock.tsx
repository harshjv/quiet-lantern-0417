import { useEffect, useState } from 'react'
import { remaining } from '@/lib/sandbox'
import { cn } from '@/lib/utils'

export const useNow = (intervalMs = 1000) => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return now
}

export function TimeLeft({ sandbox, className }: { sandbox: { status: string; stop_at: string | null; delete_at: string | null }; className?: string }) {
  const clock = remaining(sandbox, useNow())
  if (!clock) return <span className="text-muted-foreground">—</span>
  return (
    <span className={cn('tabular-nums', clock.urgent && 'text-amber-700 dark:text-amber-400', className)}>
      {clock.text} <span className="text-muted-foreground">{clock.label}</span>
    </span>
  )
}
