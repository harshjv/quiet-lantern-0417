import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Outlet, useParams } from '@tanstack/react-router'

import { CommandBlock } from '@/components/code'
import { EmptyState } from '@/components/page'
import { failurePage } from '@/components/panel'
import { SessionsList } from '@/components/sessions-list'
import { commands } from '@/lib/commands'
import { entityIcon } from '@/lib/icons'
import { agentSessionsQuery, load } from '@/lib/queries'
import { titled } from '@/lib/title'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/_app/sessions')({
  loader: ({ context }) => load(context.queryClient, agentSessionsQuery()),
  head: () => titled('Sessions'),
  errorComponent: failurePage('Couldn’t load sessions'),
  component: SessionsLayout,
})

const scope = {
  project: 'my-project',
  environment: 'production',
}

function SessionsLayout() {
  const { data } = useSuspenseQuery(agentSessionsQuery())
  const open = useParams({
    strict: false,
    select: (params) =>
      'sandbox' in params && 'session' in params
        ? {
            sandbox: params.sandbox as string,
            session: params.session as string,
          }
        : null,
  })

  if (data.items.length === 0) {
    return (
      <EmptyState
        icon={entityIcon.session}
        title="No agent session yet"
        description="A session appears here as soon as an agent starts working in a workspace. Create a workspace, open it and start the agent."
        also={
          <CommandBlock
            caption="From a terminal"
            commands={[commands.createWorkspace(scope), commands.openWorkspace('<name>')]}
          />
        }
      />
    )
  }

  return (
    <div className="grid h-[calc(100svh-6.5rem)] min-h-96 gap-4 md:grid-cols-[22rem_minmax(0,1fr)]">
      <aside
        aria-label="Sessions"
        className={cn('min-h-0 overflow-hidden rounded-lg border', open && 'hidden md:block')}
      >
        <SessionsList sessions={data.items} selected={open} />
      </aside>
      <section className={cn('flex min-h-0 min-w-0 flex-col', !open && 'hidden md:flex')}>
        <Outlet />
      </section>
    </div>
  )
}
