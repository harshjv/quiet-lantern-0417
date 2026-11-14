import { ChevronRight, Search } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'

import { useNow } from '@/components/sandbox-clock'
import { SessionRow } from '@/components/session-row'
import { ShortcutKeys } from '@/components/shortcut-keys'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { groupSessions, matchesTitle, type SessionGroup } from '@/lib/agent-sessions'
import type { AgentSession } from '@/lib/api'
import { useShortcut } from '@/lib/shortcuts'
import { cn } from '@/lib/utils'

const heading = 'px-2.5 pb-1 text-xs font-medium tracking-wide text-muted-foreground'

export function SessionsList({
  sessions,
  selected,
  onlyWaiting,
  onOpen,
}: {
  sessions: readonly AgentSession[]
  selected: { sandbox: string; session: string } | null
  onlyWaiting: boolean
  onOpen?: () => void
}) {
  const [query, setQuery] = useState('')
  const [showEnded, setShowEnded] = useState(false)
  const search = useRef<HTMLInputElement>(null)
  const now = useNow(60_000)
  const groups = useMemo(
    () =>
      groupSessions(
        sessions.filter((session) => matchesTitle(session, query)),
        new Date(now),
      ).filter((entry) => !onlyWaiting || entry.group === 'waiting'),
    [sessions, query, now, onlyWaiting],
  )

  useShortcut('filter', () => search.current?.focus())

  const rows = (items: readonly AgentSession[]) =>
    items.map((session) => (
      <SessionRow
        key={`${session.sandbox.id}/${session.session_id}`}
        session={session}
        onOpen={onOpen}
        selected={
          selected?.sandbox === session.sandbox.id && selected.session === session.session_id
        }
      />
    ))

  const section = (group: SessionGroup, label: string, items: readonly AgentSession[]) => (
    <section key={group} aria-labelledby={`sessions-${group}`}>
      <h2 id={`sessions-${group}`} className={heading}>
        {label}
      </h2>
      <div className="space-y-0.5">{rows(items)}</div>
    </section>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative px-2 pb-2">
        <Search
          className="pointer-events-none absolute top-1/2 left-4.5 size-3.5 -translate-y-[calc(50%+0.25rem)] text-muted-foreground"
          aria-hidden
        />
        <Input
          ref={search}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search sessions"
          aria-label="Search sessions by title"
          className="h-8 border-transparent bg-transparent pl-7 text-sm shadow-none"
        />
        <ShortcutKeys
          id="filter"
          className="pointer-events-none absolute top-1/2 right-4.5 -translate-y-[calc(50%+0.25rem)]"
        />
      </div>
      <nav aria-label="Sessions" className="min-h-0 flex-1 space-y-4 overflow-y-auto px-2 pb-2">
        {groups.length === 0 && (
          <p className="px-2.5 py-2 text-sm text-muted-foreground">
            {onlyWaiting && !query
              ? 'Nothing is waiting on you.'
              : `No session matches “${query}”.`}
          </p>
        )}
        {groups.map((entry) =>
          entry.group === 'ended' ? (
            <Collapsible
              key={entry.group}
              open={showEnded || query !== ''}
              onOpenChange={setShowEnded}
            >
              <CollapsibleTrigger
                className={cn(
                  heading,
                  'flex w-full items-center gap-1 rounded-md hover:text-foreground',
                )}
              >
                <ChevronRight
                  className={cn(
                    'size-3 transition-transform',
                    (showEnded || query !== '') && 'rotate-90',
                  )}
                  aria-hidden
                />
                {entry.label}
              </CollapsibleTrigger>
              <CollapsibleContent className="space-y-0.5">{rows(entry.items)}</CollapsibleContent>
            </Collapsible>
          ) : (
            section(entry.group, entry.label, entry.items)
          ),
        )}
      </nav>
    </div>
  )
}
