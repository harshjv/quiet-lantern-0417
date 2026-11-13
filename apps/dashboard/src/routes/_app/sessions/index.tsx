import { createFileRoute } from '@tanstack/react-router'

import { EmptyState } from '@/components/page'
import { entityIcon } from '@/lib/icons'

export const Route = createFileRoute('/_app/sessions/')({
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
