import { createFileRoute } from '@tanstack/react-router'

import { titled } from '@/lib/title'
import { ProjectShipLog } from '@/workbench/ship-log'

export const Route = createFileRoute('/_app/p/$project/ship')({
  staticData: {
    mode: 'ship',
  },
  head: ({ params }) => titled('Ship', params.project),
  component: function Ship() {
    return <ProjectShipLog project={Route.useParams().project} />
  },
})
