import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Outlet } from '@tanstack/react-router'

import { CommandBlock } from '@/components/code'
import { EmptyState } from '@/components/page'
import { failurePage } from '@/components/panel'
import { commands } from '@/lib/commands'
import { entityIcon } from '@/lib/icons'
import { agentSessionsQuery, load } from '@/lib/queries'
import { titled } from '@/lib/title'

export const Route = createFileRoute('/_app/sessions')({
  loader: ({ context }) => load(context.queryClient, agentSessionsQuery()),
  head: () => titled('Sessions'),
  staticData: {
    fullBleed: true,
  },
  errorComponent: failurePage('Couldn’t load sessions'),
  component: SessionsLayout,
})

const scope = {
  project: 'my-project',
  environment: 'production',
}

function SessionsLayout() {
  const { data } = useSuspenseQuery(agentSessionsQuery())

  if (data.items.length === 0) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-10">
        <EmptyState
          icon={entityIcon.session}
          title="No agent session yet"
          description="A session appears here as soon as an agent starts working in a workspace. Create a workspace, open it and start the agent."
          also={
            <CommandBlock
              caption="From a terminal"
              commands={[commands.createWorkspace(scope), commands.openWorkspace(scope, '<name>')]}
            />
          }
        />
      </div>
    )
  }

  return <Outlet />
}
