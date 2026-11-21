import { createFileRoute } from '@tanstack/react-router'

import { ProjectTasks } from '@/workbench/build-list'

export const Route = createFileRoute('/_app/p/$project/build/')({
  component: function Tasks() {
    return <ProjectTasks project={Route.useParams().project} />
  },
})
