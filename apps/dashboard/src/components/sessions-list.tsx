import { Search } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'

import { SessionRow } from '@/components/session-row'
import { ShortcutKeys } from '@/components/shortcut-keys'
import { Input } from '@/components/ui/input'
import { groupSessions, matchesTitle } from '@/lib/agent-sessions'
import type { AgentSession } from '@/lib/api'
import { useShortcut } from '@/lib/shortcuts'

export function SessionsList({
  sessions,
  selected,
}: {
  sessions: readonly AgentSession[]
  selected: { sandbox: string; session: string } | null
}) {
  const [query, setQuery] = useState('')
  const search = useRef<HTMLInputElement>(null)
  const groups = useMemo(
    () => groupSessions(sessions.filter((session) => matchesTitle(session, query))),
    [sessions, query],
  )

  useShortcut('filter', () => search.current?.focus())

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative border-b p-2">
        <Search
          className="pointer-events-none absolute top-1/2 left-4.5 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          ref={search}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search sessions"
          aria-label="Search sessions by title"
          className="h-8 pl-7 text-sm"
        />
        <ShortcutKeys
          id="filter"
          className="pointer-events-none absolute top-1/2 right-4.5 -translate-y-1/2"
        />
      </div>
      <nav aria-label="Sessions" className="min-h-0 flex-1 space-y-4 overflow-y-auto p-2">
        {groups.length === 0 && (
          <p className="px-2.5 py-4 text-sm text-muted-foreground">No session matches “{query}”.</p>
        )}
        {groups.map((entry) => (
          <section key={entry.group} aria-labelledby={`sessions-${entry.group}`}>
            <h2
              id={`sessions-${entry.group}`}
              className="px-2.5 pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase"
            >
              {entry.label}
            </h2>
            <div className="space-y-0.5">
              {entry.items.map((session) => (
                <SessionRow
                  key={`${session.sandbox.id}/${session.session_id}`}
                  session={session}
                  selected={
                    selected?.sandbox === session.sandbox.id &&
                    selected.session === session.session_id
                  }
                />
              ))}
            </div>
          </section>
        ))}
      </nav>
    </div>
  )
}
