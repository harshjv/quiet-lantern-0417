import { Link } from '@tanstack/react-router'

import { useNow } from '@/components/sandbox-clock'
import { agentStatusView } from '@/lib/agent-session'
import { sessionLink, sessionPlace, sessionReason, sessionTitle } from '@/lib/agent-sessions'
import type { AgentSession } from '@/lib/api'
import { shortAgo } from '@/lib/format'
import { toneDot, toneText } from '@/lib/tone'
import { cn } from '@/lib/utils'

function SessionDot({ session }: { session: AgentSession }) {
  const view = agentStatusView(session)

  return (
    <span className="relative mt-1.5 inline-flex size-2 shrink-0" aria-hidden>
      {view.pulse && (
        <span
          className={cn(
            'absolute inline-flex size-full animate-ping rounded-full opacity-60 motion-reduce:hidden',
            toneDot[view.tone],
          )}
        />
      )}
      <span className={cn('relative inline-flex size-2 rounded-full', toneDot[view.tone])} />
    </span>
  )
}

export function SessionRow({
  session,
  selected,
  onOpen,
}: {
  session: AgentSession
  selected?: boolean
  onOpen?: () => void
}) {
  const now = useNow(30_000)
  const reason = sessionReason(session)

  return (
    <Link
      to="/sessions/$sandbox/$session"
      params={sessionLink(session)}
      aria-current={selected ? 'page' : undefined}
      data-testid="session-row"
      onClick={onOpen}
      title={sessionPlace(session)}
      className={cn(
        'flex min-w-0 gap-2.5 rounded-md px-2.5 py-2 text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50',
        selected && 'bg-muted',
      )}
    >
      <SessionDot session={session} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {sessionTitle(session)}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {shortAgo(session.last_event_at, new Date(now))}
          </span>
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {reason && (
            <span
              className={cn(
                session.status === 'waiting' && toneText.warning,
                session.status === 'failed' && toneText.danger,
              )}
            >
              {reason}
              {' · '}
            </span>
          )}
          {session.sandbox.name}
        </span>
      </span>
    </Link>
  )
}
