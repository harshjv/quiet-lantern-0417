import { createFileRoute } from '@tanstack/react-router'

import { titled } from '@/lib/title'
import { z } from '@/lib/zod'
import { LiveObserve } from '@/workbench/observe-live'

export const Route = createFileRoute('/_app/p/$project/observe/{-$tab}')({
  staticData: {
    mode: 'observe',
  },
  validateSearch: z.object({
    app: z.string().optional().catch(undefined),
  }),
  head: ({ params }) => titled('Observe', params.project),
  component: function Observe() {
    const { project, tab } = Route.useParams()

    return <LiveObserve project={project} tab={tab ?? null} app={Route.useSearch().app ?? null} />
  },
})
