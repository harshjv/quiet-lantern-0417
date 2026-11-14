import { createFileRoute } from '@tanstack/react-router'

import { NewTask } from '@/components/new-task'
import { failurePage } from '@/components/panel'
import { load, projectsQuery } from '@/lib/queries'
import { titled } from '@/lib/title'

export const Route = createFileRoute('/_app/')({
  loader: ({ context }) => load(context.queryClient, projectsQuery),
  head: () => titled('New task'),
  errorComponent: failurePage('Couldn’t load your projects'),
  component: NewTask,
})
