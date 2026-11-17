import { createFileRoute } from '@tanstack/react-router'

import { titled } from '@/lib/title'
import { z } from '@/lib/zod'
import { NewTask } from '@/workbench/build-live'

export const Route = createFileRoute('/_app/build/new')({
  validateSearch: z.object({
    fix: z.string().optional().catch(undefined),
  }),
  head: () => titled('New task', 'Build'),
  component: function New() {
    const { project, fix } = Route.useSearch()

    return <NewTask project={project ?? null} fix={fix ?? null} />
  },
})
