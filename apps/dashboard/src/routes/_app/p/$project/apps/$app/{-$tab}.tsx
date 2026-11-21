import { createFileRoute } from '@tanstack/react-router'

import { appHeading, headOf } from '@/lib/heads'
import { ProjectPage } from '@/workbench/project-page'

export const Route = createFileRoute('/_app/p/$project/apps/$app/{-$tab}')({
  loader: ({ context, params }) => appHeading(context.queryClient, params.app),
  head: ({ loaderData, params }) => headOf(loaderData, params.project),
  component: function App() {
    const { project, app, tab } = Route.useParams()

    return (
      <ProjectPage
        project={project}
        preview={null}
        app={{
          app,
          tab: tab ?? null,
        }}
        tab={null}
      />
    )
  },
})
