import { createFileRoute } from '@tanstack/react-router'

import { titled } from '@/lib/title'
import { LiveObserve } from '@/workbench/observe-live'

export const Route = createFileRoute('/_app/observe/{-$tab}')({
  staticData: {
    mode: 'observe',
  },
  head: () => titled('Observe'),
  component: function Observe() {
    return (
      <LiveObserve
        project={Route.useSearch().project ?? null}
        tab={Route.useParams().tab ?? null}
      />
    )
  },
})
