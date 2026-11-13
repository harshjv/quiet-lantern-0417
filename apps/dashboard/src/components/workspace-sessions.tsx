import { useQuery } from '@tanstack/react-query'

import { Section } from '@/components/page'
import { Panel } from '@/components/panel'
import { SessionRow } from '@/components/session-row'
import { Skeleton } from '@/components/ui/skeleton'
import type { Sandbox } from '@/lib/api'
import { agentSessionsQuery } from '@/lib/queries'

function Rows({ sandbox }: { sandbox: Sandbox }) {
  const { data, isPending } = useQuery(agentSessionsQuery(sandbox.id))

  if (isPending) {
    return <Skeleton className="h-12 w-full" />
  }

  if (!data?.items.length) {
    return (
      <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
        No session yet. Start the agent in this workspace and it appears here.
      </p>
    )
  }

  return (
    <div className="space-y-0.5 rounded-lg border p-1">
      {data.items.map((session) => (
        <SessionRow key={session.session_id} session={session} />
      ))}
    </div>
  )
}

export function WorkspaceSessions({ sandbox }: { sandbox: Sandbox }) {
  return (
    <Section title="Sessions" description="What the agent in this workspace has worked on.">
      <Panel rows={2} title="Couldn’t load sessions">
        <Rows sandbox={sandbox} />
      </Panel>
    </Section>
  )
}
