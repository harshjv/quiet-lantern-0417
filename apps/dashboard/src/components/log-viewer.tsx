import { useQuery } from '@tanstack/react-query'
import { ArrowDownToLine, CircleAlert, Pause, Play } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import { ErrorState } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ApiFailure, type LogLine } from '@/lib/api'
import { useEventStream } from '@/lib/event-stream'
import { clock, plural } from '@/lib/format'
import { firstErrorIndex, logFollowUrl, type LogSelector } from '@/lib/logs'
import { logsQuery } from '@/lib/queries'
import { useShortcut } from '@/lib/shortcuts'
import { highlight } from '@/lib/use-fresh'
import { cn } from '@/lib/utils'

const maxLines = 5000
const noLines: LogLine[] = []
const redacted = /(\[redacted(?::[A-Za-z0-9_]+)?\])/

function LogText({ text }: { text: string }) {
  const parts = text.split(redacted)

  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark
            key={i}
            className="rounded-sm bg-amber-200/70 px-0.5 text-amber-950 dark:bg-amber-500/25 dark:text-amber-100"
          >
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  )
}

type ServerError = {
  code: string
  explanation: string
}

function useFollowedLines(url: string | null) {
  const [lines, setLines] = useState<LogLine[]>([])
  const [failure, setFailure] = useState<ApiFailure | null>(null)
  const [linesFrom, setLinesFrom] = useState(url)
  const buffer = useRef<LogLine[]>([])
  const frame = useRef(0)

  if (linesFrom !== url) {
    setLinesFrom(url)
    setLines([])
    setFailure(null)
  }

  useEffect(
    () => () => {
      window.cancelAnimationFrame(frame.current)
      frame.current = 0
      buffer.current = []
    },
    [url],
  )

  const flush = () => {
    frame.current = 0
    const batch = buffer.current.splice(0)

    setLines((prev) => prev.concat(batch).slice(-maxLines))
  }

  const state = useEventStream<{
    log: LogLine
    end: unknown
    error: ServerError
  }>(url, {
    log: (line) => {
      buffer.current.push(line)

      if (!frame.current) {
        frame.current = window.requestAnimationFrame(flush)
      }
    },
    end: (_, close) => close(),
    error: (body, close) => {
      setFailure(
        new ApiFailure(503, {
          code: body.code,
          explanation: body.explanation,
          fix: 'The station holds the logs; they stream again once it is reachable.',
        }),
      )
      close()
    },
  })

  return {
    lines,
    failure,
    state,
  }
}

export function LogViewer({
  selector,
  follow: followAtMount,
  label,
}: {
  selector: LogSelector
  follow: boolean
  label: string
}) {
  const [follow] = useState(followAtMount)
  const [paused, setPaused] = useState(false)
  const streaming = follow && !paused
  const tail = useQuery({
    ...logsQuery(selector),
    enabled: !streaming,
  })
  const followed = useFollowedLines(streaming ? logFollowUrl(selector) : null)
  const lines = streaming ? followed.lines : (tail.data ?? noLines)
  const error = streaming ? followed.failure : tail.error
  const loading = streaming ? followed.state === 'connecting' : tail.isPending
  const status = loading
    ? 'Loading'
    : !streaming
      ? plural(lines.length, 'line')
      : followed.state === 'live'
        ? 'Following new lines'
        : 'No more lines'
  const [filter, setFilter] = useState('')
  const filterInput = useRef<HTMLInputElement>(null)

  useShortcut('filter', () => filterInput.current?.focus())
  const [stick, setStick] = useState(true)
  const [jumped, setJumped] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const firstError = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (stick && box.current) {
      box.current.scrollTop = box.current.scrollHeight
    }
  }, [lines, stick])

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase()

    return needle ? lines.filter((line) => line.text.toLowerCase().includes(needle)) : lines
  }, [lines, filter])
  const errorAt = firstErrorIndex(shown)
  const jumpToError = () => {
    setStick(false)
    setJumped(true)
    firstError.current?.scrollIntoView({
      block: 'center',
    })
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs text-muted-foreground" aria-live="polite">
          {status}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {errorAt >= 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-xs"
              onClick={jumpToError}
            >
              <CircleAlert /> First error
            </Button>
          )}
          <Input
            ref={filterInput}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter lines"
            aria-label={`Filter ${label}`}
            className="h-7 w-40 text-xs sm:w-56"
          />
          {follow && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={() => setPaused((p) => !p)}
              aria-label={paused ? 'Resume following' : 'Pause following'}
            >
              {paused ? <Play /> : <Pause />}
            </Button>
          )}
          <Button
            type="button"
            variant={stick ? 'secondary' : 'ghost'}
            size="icon-sm"
            onClick={() => setStick((s) => !s)}
            aria-pressed={stick}
            aria-label="Stick to the newest line"
          >
            <ArrowDownToLine />
          </Button>
        </div>
      </div>
      {error ? (
        <div className="p-3">
          <ErrorState error={error} title="Couldn’t load logs" />
        </div>
      ) : (
        <div
          ref={box}
          role="log"
          aria-label={label}
          tabIndex={0}
          onScroll={(e) => {
            const el = e.currentTarget

            setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
          }}
          className="h-[26rem] overflow-auto bg-zinc-50 py-2 font-mono text-[0.75rem] leading-5 dark:bg-zinc-950"
        >
          {shown.length === 0 ? (
            <p className="px-3 text-muted-foreground">
              {loading
                ? 'Loading lines…'
                : filter
                  ? 'No lines match the filter.'
                  : 'No log lines yet.'}
            </p>
          ) : (
            shown.map((line, i) => (
              <div
                key={`${line.cursor ?? ''}-${i}`}
                ref={i === errorAt ? firstError : undefined}
                className={cn(
                  'flex gap-3 px-3 hover:bg-zinc-200/50 dark:hover:bg-zinc-800/50',
                  i === errorAt && jumped && highlight,
                )}
              >
                <span className="shrink-0 text-muted-foreground tabular-nums select-none">
                  {clock(line.at)}
                </span>
                <span
                  className={cn(
                    'w-4 shrink-0 select-none',
                    line.stream === 'stderr'
                      ? 'text-red-700 dark:text-red-400'
                      : 'text-muted-foreground',
                  )}
                  title={line.stream === 'stderr' ? 'Error output' : 'Standard output'}
                >
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
