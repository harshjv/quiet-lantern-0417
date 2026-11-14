import { useQuery } from '@tanstack/react-query'

import { Section } from '@/components/page'
import { Panel } from '@/components/panel'
import { SessionRow } from '@/components/session-row'
import { SessionThread } from '@/components/session-thread'
import { Skeleton } from '@/components/ui/skeleton'
import type { Sandbox } from '@/lib/api'
import { agentSessionsQuery } from '@/lib/queries'

function Sessions({ sandbox }: { sandbox: Sandbox }) {
  const { data, isPending } = useQuery(agentSessionsQuery(sandbox.id))

  if (isPending) {
    return <Skeleton className="h-24 w-full" />
  }

  const [latest, ...others] = data?.items ?? []

  if (!latest) {
    return (
      <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
        No session yet. Start the agent in this workspace and it appears here.
      </p>
    )
  }

  return (
    <div className="space-y-6">
      <SessionThread key={latest.session_id} session={latest} fill={false} own />
      {others.length > 0 && (
        <Section title="Earlier sessions">
          <div className="space-y-0.5">
            {others.map((session) => (
              <SessionRow key={session.session_id} session={session} />
            ))}
          </div>
        </Section>
      )}
    </div>
  )
}

export function WorkspaceSessions({ sandbox }: { sandbox: Sandbox }) {
  return (
    <Panel rows={2} title="Couldn’t load sessions">
      <Sessions sandbox={sandbox} />
    </Panel>
  )
}
