import { createFileRoute } from '@tanstack/react-router'

import { titled } from '@/lib/title'
import { z } from '@/lib/zod'
import { NewTask } from '@/workbench/build-live'

export const Route = createFileRoute('/_app/p/$project/build/new')({
  validateSearch: z.object({
    fix: z.string().optional().catch(undefined),
  }),
  head: ({ params }) => titled('New task', 'Build', params.project),
  component: function New() {
    const { project } = Route.useParams()
    const { fix } = Route.useSearch()

    return <NewTask project={project} fix={fix ?? null} />
  },
})
