import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'

import { EmptyState } from '@/components/page'
import { failurePage } from '@/components/panel'
import { SessionThread } from '@/components/session-thread'
import { Button } from '@/components/ui/button'
import { entityIcon } from '@/lib/icons'
import { agentSessionsQuery } from '@/lib/queries'
import { titled } from '@/lib/title'

export const Route = createFileRoute('/_app/sessions/$sandbox/$session')({
  head: () => titled('Session'),
  errorComponent: failurePage('Couldn’t open this session'),
  component: SessionPage,
})

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

  return <SessionThread key={`${sandbox}/${session}`} session={found} fill />
}
