import { createFileRoute, redirect } from '@tanstack/react-router'

import { EmptyState } from '@/components/page'
import { sessionLink, topSession } from '@/lib/agent-sessions'
import { entityIcon } from '@/lib/icons'
import { agentSessionsQuery, load } from '@/lib/queries'

const wide = () => window.matchMedia('(min-width: 768px)').matches

export const Route = createFileRoute('/_app/sessions/')({
  loader: async ({ context }) => {
    const sessions = await load(context.queryClient, agentSessionsQuery())
    const top = topSession(sessions.items, new Date())

    if (top && wide()) {
      throw redirect({
        to: '/sessions/$sandbox/$session',
        params: sessionLink(top),
        replace: true,
      })
    }
  },
  component: NoSession,
})

function NoSession() {
  return (
    <EmptyState
      icon={entityIcon.session}
      title="Pick a session"
      description="Choose one on the left to follow what the agent is doing."
      className="h-full"
    />
  )
}
