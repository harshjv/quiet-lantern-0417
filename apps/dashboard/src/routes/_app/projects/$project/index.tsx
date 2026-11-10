import { createFileRoute, redirect } from '@tanstack/react-router'
import { Layers } from 'lucide-react'

import { AlsoWith } from '@/components/code'
import { NewEnvironment } from '@/components/new-environment'
import { EmptyState, PageHeader } from '@/components/page'
import { failurePage } from '@/components/panel'
import { commands } from '@/lib/commands'
import { environmentsQuery, load, projectQuery } from '@/lib/queries'

export const Route = createFileRoute('/_app/projects/$project/')({
  loader: async ({ context, params }) => {
    const [project, environments] = await Promise.all([
      load(context.queryClient, projectQuery(params.project)),
      load(context.queryClient, environmentsQuery(params.project)),
    ])
    const chosen =
      environments.items.find((e) => e.id === project.default_environment_id) ??
      environments.items[0]
    if (chosen)
      throw redirect({
        to: '/projects/$project/$environment',
        params: {
          project: params.project,
          environment: chosen.name,
        },
        replace: true,
      })
    return null
  },
  errorComponent: failurePage('Couldn’t load this project'),
  component: EmptyProject,
})

function EmptyProject() {
  const { project } = Route.useParams()
  return (
    <div className="space-y-6">
      <PageHeader title={project} />
      <EmptyState
        icon={Layers}
        title="No environments yet"
        description="Create one to start adding services."
        action={<NewEnvironment project={project} environments={[]} />}
        also={<AlsoWith cli={commands.createEnvironment(project)} tool="create_environment" />}
      />
    </div>
  )
}
