import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'

import { AgentStatusBadge } from '@/components/agent-status'
import { AgentThread, useAgentSession, WaitingNotice } from '@/components/agent-tab'
import { Code } from '@/components/code'
import { EmptyState } from '@/components/page'
import { failurePage } from '@/components/panel'
import { Button } from '@/components/ui/button'
import { sessionMeta, sessionTitle } from '@/lib/agent-sessions'
import type { AgentSession } from '@/lib/api'
import { entityIcon } from '@/lib/icons'
import { agentSessionsQuery } from '@/lib/queries'
import { titled } from '@/lib/title'

export const Route = createFileRoute('/_app/sessions/$sandbox/$session')({
  head: () => titled('Session'),
  errorComponent: failurePage('Couldn’t open this session'),
  component: SessionPage,
})

function Thread({ session }: { session: AgentSession }) {
  const { state, stream } = useAgentSession(session.sandbox.id, true, session.session_id)
  const shell = `sly sandboxes shell ${session.sandbox.name}`

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <header className="space-y-1 border-b pb-3">
        <div className="flex items-start gap-3">
          <Button asChild variant="ghost" size="icon-sm" className="md:hidden">
            <Link to="/sessions" aria-label="All sessions">
              <ArrowLeft />
            </Link>
          </Button>
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight">
            {sessionTitle(session)}
          </h1>
          <AgentStatusBadge status={session} announce />
        </div>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <Link
            to="/sandboxes/$sandbox"
            params={{
              sandbox: session.sandbox.id,
            }}
            className="underline-offset-4 hover:underline"
          >
            {sessionMeta(session)}
          </Link>
          <Code copy={shell}>{shell}</Code>
        </p>
      </header>
      {session.status === 'waiting' && <WaitingNotice kind={session.kind} state={state} />}
      <AgentThread
        state={state}
        stream={stream}
        session={session.session_id}
        className="h-full space-y-6 p-1 pr-3"
        frameClassName="min-h-0 flex-1"
        empty={
          <EmptyState
            icon={entityIcon.session}
            title="Nothing to show yet"
            description="This session has no events in the view."
          />
        }
      />
    </div>
  )
}

function SessionPage() {
  const { sandbox, session } = Route.useParams()
  const { data } = useSuspenseQuery(agentSessionsQuery())
  const found = data.items.find(
    (item) => item.sandbox.id === sandbox && item.session_id === session,
  )

  if (!found) {
    return (
      <EmptyState
        icon={entityIcon.session}
        title="This session is not in the list"
        description="It may belong to a workspace that was deleted, or the link is wrong."
        action={
          <Button asChild variant="outline">
            <Link to="/sessions">All sessions</Link>
          </Button>
        }
      />
    )
  }

  return <Thread key={`${sandbox}/${session}`} session={found} />
}
