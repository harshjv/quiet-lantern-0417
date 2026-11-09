import { createFileRoute, redirect } from '@tanstack/react-router'
import { ErrorState } from '@/components/page'
import { environmentsQuery, projectQuery } from '@/lib/queries'

export const Route = createFileRoute('/_app/projects/$project/')({
  loader: async ({ context, params }) => {
    const [project, environments] = await Promise.all([context.queryClient.query(projectQuery(params.project)), context.queryClient.query(environmentsQuery(params.project))])
    const chosen = environments.items.find(e => e.id === project.default_environment_id) ?? environments.items[0]
    if (chosen) throw redirect({ to: '/projects/$project/$environment', params: { project: params.project, environment: chosen.name }, replace: true })
    return null
  },
  errorComponent: ({ error }) => <ErrorState error={error} title="The project could not be loaded" />,
  component: () => <ErrorState error={new Error('This project has no environments yet.')} title="Nothing to show" />
})
