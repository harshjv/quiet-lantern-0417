import { createFileRoute } from '@tanstack/react-router'

import { placeTitle, titled } from '@/lib/title'
import { ProjectShip } from '@/workbench/ship-project'

export const Route = createFileRoute('/_app/_ship/projects/$project/{-$tab}')({
  head: ({ params }) => titled(placeTitle(params.project, null), 'Ship'),
  component: function Production() {
    const { project, tab } = Route.useParams()

    return <ProjectShip project={project} preview={null} tab={tab ?? null} />
  },
})
