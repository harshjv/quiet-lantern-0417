import { useSuspenseQuery, type QueryClient } from '@tanstack/react-query'

import type { Crumb } from '@/components/crumbs'

import { environmentQuery, load, projectQuery } from './queries'
import { placeOf } from './title'

export const loadTrail = async (client: QueryClient, environmentId: string) => {
  const environment = await load(client, environmentQuery(environmentId))
  const project = await load(client, projectQuery(environment.project_id))

  return placeOf(project.name, environment.name)
}

export function useEnvironmentTrail(environmentId: string) {
  const { data: environment } = useSuspenseQuery(environmentQuery(environmentId))
  const { data: project } = useSuspenseQuery(projectQuery(environment.project_id))
  const crumbs: Crumb[] = [
    {
      label: 'Projects',
      to: '/projects',
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
