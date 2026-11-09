import { ArrowDownToLine, Pause, Play } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ErrorState } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api, ApiFailure, unwrap } from '@/lib/api'
import { clock } from '@/lib/format'
import type { LogLine } from '@/lib/api'
import { cn } from '@/lib/utils'

type Selector = { deployment: string } | { build: string } | { sandbox: string; role: 'init' | 'runtime' }

const maxLines = 5000
const tail = 500
const redacted = /(\[redacted(?::[A-Za-z0-9_]+)?\])/

function LogText({ text }: { text: string }) {
  const parts = text.split(redacted)
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="rounded-sm bg-amber-200/70 px-0.5 text-amber-950 dark:bg-amber-500/25 dark:text-amber-100">
            {part}
          </mark>
        ) : (
          part
        )
      )}
    </>
  )
}

const queryOf = (selector: Selector): Record<string, string> => {
  if ('deployment' in selector) return { deployment: selector.deployment }
  if ('build' in selector) return { build: selector.build }
  return { sandbox: selector.sandbox, role: selector.role }
}

export function LogViewer({ selector, follow: followAtMount, label }: { selector: Selector; follow: boolean; label: string }) {
  const [follow] = useState(followAtMount)
  const [lines, setLines] = useState<LogLine[]>([])
  const [error, setError] = useState<unknown>(null)
  const [state, setState] = useState<'loading' | 'following' | 'ended' | 'idle'>('loading')
  const [filter, setFilter] = useState('')
  const [stick, setStick] = useState(true)
  const [paused, setPaused] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const key = JSON.stringify(selector)

  useEffect(() => {
    setLines([])
    setError(null)
    setState('loading')
    if (!follow || paused) {
      let cancelled = false
      unwrap(api.v1.logs.get({ query: { ...queryOf(selector), tail } }))
        .then(page => {
          if (cancelled) return
          setLines(page.lines)
          setState('idle')
        })
        .catch(failure => !cancelled && (setError(failure), setState('idle')))
      return () => {
        cancelled = true
      }
    }
    const params = new URLSearchParams({ ...queryOf(selector), tail: String(tail), follow: 'true' })
    const source = new EventSource(`/v1/logs?${params}`)
    const buffer: LogLine[] = []
    let frame = 0
    const flush = () => {
      frame = 0
      const batch = buffer.splice(0)
      setLines(prev => {
        const next = prev.concat(batch)
        return next.length > maxLines ? next.slice(next.length - maxLines) : next
      })
    }
    source.addEventListener('log', message => {
      buffer.push(JSON.parse((message as MessageEvent<string>).data) as LogLine)
      if (!frame) frame = window.requestAnimationFrame(flush)
    })
    source.addEventListener('end', () => {
      source.close()
      setState('ended')
    })
    source.addEventListener('error', message => {
      if (message instanceof MessageEvent && typeof message.data === 'string') {
        const body = JSON.parse(message.data) as { code: string; explanation: string }
        setError(new ApiFailure(503, { code: body.code, explanation: body.explanation, fix: 'The station holds the logs; they stream again once it is reachable.' }))
        source.close()
        setState('ended')
      }
    })
    source.onopen = () => setState('following')
    return () => {
      source.close()
      if (frame) window.cancelAnimationFrame(frame)
    }
  }, [key, follow, paused])

  useEffect(() => {
    if (stick && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [lines, stick])

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    return needle ? lines.filter(line => line.text.toLowerCase().includes(needle)) : lines
  }, [lines, filter])

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {state === 'following' ? 'following' : state === 'loading' ? 'loading' : state === 'ended' ? 'stream ended' : `${lines.length} lines`}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter lines" aria-label={`Filter ${label}`} className="h-7 w-40 text-xs sm:w-56" />
          {follow && (
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => setPaused(p => !p)} aria-label={paused ? 'Resume following' : 'Pause following'}>
              {paused ? <Play /> : <Pause />}
            </Button>
          )}
          <Button type="button" variant={stick ? 'secondary' : 'ghost'} size="icon-sm" onClick={() => setStick(s => !s)} aria-pressed={stick} aria-label="Stick to the newest line">
            <ArrowDownToLine />
          </Button>
        </div>
      </div>
      {error ? (
        <div className="p-3">
          <ErrorState error={error} title="Logs are unavailable" />
        </div>
      ) : (
        <div
          ref={box}
          role="log"
          aria-label={label}
          tabIndex={0}
          onScroll={e => {
            const el = e.currentTarget
            setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
          }}
          className="h-[26rem] overflow-auto bg-zinc-50 py-2 font-mono text-[0.75rem] leading-5 dark:bg-zinc-950"
        >
          {shown.length === 0 ? (
            <p className="px-3 text-muted-foreground">{state === 'loading' ? 'Loading lines…' : filter ? 'No line matches the filter.' : 'No log lines yet.'}</p>
          ) : (
            shown.map((line, i) => (
              <div key={`${line.cursor ?? ''}-${i}`} className="flex gap-3 px-3 hover:bg-zinc-200/50 dark:hover:bg-zinc-800/50">
                <span className="shrink-0 text-muted-foreground tabular-nums select-none">{clock(line.at)}</span>
                <span className={cn('w-4 shrink-0 select-none', line.stream === 'stderr' ? 'text-red-700 dark:text-red-400' : 'text-muted-foreground')} title={line.stream}>
                  {line.stream === 'stderr' ? 'E' : '·'}
                </span>
                <span className="min-w-0 break-all whitespace-pre-wrap">
                  <LogText text={line.text} />
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  )
}
