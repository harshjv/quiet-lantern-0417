import { createFileRoute } from '@tanstack/react-router'

import { placeTitle, titled } from '@/lib/title'
import { ProjectShip } from '@/workbench/ship-project'

export const Route = createFileRoute('/_app/_ship/projects/$project/previews/$preview/{-$tab}')({
  head: ({ params }) => titled(placeTitle(params.project, params.preview), 'Ship'),
  component: function Preview() {
    const { project, preview, tab } = Route.useParams()

    return <ProjectShip project={project} preview={preview} tab={tab ?? null} />
  },
})
