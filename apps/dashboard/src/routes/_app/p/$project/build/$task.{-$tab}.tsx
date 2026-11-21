import { createFileRoute } from '@tanstack/react-router'

import { headOf, taskHeading } from '@/lib/heads'
import { z } from '@/lib/zod'
import { TaskView } from '@/workbench/build-live'

export const Route = createFileRoute('/_app/p/$project/build/$task/{-$tab}')({
  validateSearch: z.object({
    path: z.string().optional().catch(undefined),
    file: z.string().optional().catch(undefined),
  }),
  loader: ({ context, params }) => taskHeading(context.queryClient, params.task),
  head: ({ loaderData, params }) => headOf(loaderData, 'Build', params.project),
  component: function Task() {
    const { project, task, tab } = Route.useParams()
    const { path, file } = Route.useSearch()

    return (
      <TaskView
        id={task}
        project={project}
        tab={tab ?? null}
        place={{
          path: path ?? '',
          file: file ?? null,
        }}
      />
    )
  },
})
