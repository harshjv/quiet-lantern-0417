import { createFileRoute } from '@tanstack/react-router'

import { placeTitle, titled } from '@/lib/title'
import { z } from '@/lib/zod'
import { ProjectPage } from '@/workbench/project-page'

export const Route = createFileRoute('/_app/p/$project/')({
  validateSearch: z.object({
    tab: z.string().optional().catch(undefined),
  }),
  head: ({ params }) => titled(placeTitle(params.project, null)),
  component: function Production() {
    const { project } = Route.useParams()
    const { tab } = Route.useSearch()

    return <ProjectPage project={project} preview={null} app={null} tab={tab ?? null} />
  },
})
