import { createFileRoute } from '@tanstack/react-router'

import { headOf, taskHeading } from '@/lib/heads'
import { LiveBuild } from '@/workbench/build-live'

export const Route = createFileRoute('/_app/build/$task')({
  loader: ({ context, params }) => taskHeading(context.queryClient, params.task),
  head: ({ loaderData }) => headOf(loaderData, 'Build'),
  component: function Task() {
    return <LiveBuild task={Route.useParams().task} project={Route.useSearch().project ?? null} />
  },
})
