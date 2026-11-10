import { useQuery } from '@tanstack/react-query'
import type { Crumb } from '@/components/crumbs'
import { environmentQuery, projectQuery } from './queries'

export function useEnvironmentTrail(environmentId: string | undefined) {
  const environment = useQuery({ ...environmentQuery(environmentId ?? ''), enabled: Boolean(environmentId) })
  const project = useQuery({ ...projectQuery(environment.data?.project_id ?? ''), enabled: Boolean(environment.data) })
  const ready = project.data && environment.data ? { project: project.data, environment: environment.data } : null
  const crumbs: Crumb[] = [
    { label: 'Projects', to: '/' },
    ...(ready
      ? [
          { label: ready.project.name, to: '/projects/$project', params: { project: ready.project.name } },
          { label: ready.environment.name, to: '/projects/$project/$environment', params: { project: ready.project.name, environment: ready.environment.name } }
        ]
      : [])
  ]
  return { environment: environment.data, project: project.data, crumbs }
}
