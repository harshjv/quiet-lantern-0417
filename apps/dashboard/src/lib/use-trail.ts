import { useSuspenseQuery, type QueryClient } from '@tanstack/react-query'

import type { Crumb } from '@/components/crumbs'

import { environmentQuery, load, projectQuery } from './queries'

export const loadTrail = async (client: QueryClient, environmentId: string) => {
  const environment = await load(client, environmentQuery(environmentId))
  await load(client, projectQuery(environment.project_id))
}

export function useEnvironmentTrail(environmentId: string) {
  const { data: environment } = useSuspenseQuery(environmentQuery(environmentId))
  const { data: project } = useSuspenseQuery(projectQuery(environment.project_id))
  const crumbs: Crumb[] = [
    {
      label: 'Projects',
      to: '/',
    },
    {
      label: project.name,
      to: '/projects/$project',
      params: {
        project: project.name,
      },
    },
    {
      label: environment.name,
      to: '/projects/$project/$environment',
      params: {
        project: project.name,
        environment: environment.name,
      },
    },
  ]
  return {
    environment,
    project,
    crumbs,
  }
}
