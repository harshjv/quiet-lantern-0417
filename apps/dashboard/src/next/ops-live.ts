import { useQueries, useQuery } from '@tanstack/react-query'

import type { Deployment, Service } from '@/lib/api'
import {
  environmentDeploymentsQuery,
  environmentsQuery,
  projectsQuery,
  servicesQuery,
} from '@/lib/queries'

export type LiveProject = { id: string; name: string }

export type LiveEnvironment = {
  id: string
  name: string
  ephemeral: boolean
  project: LiveProject
  pull_request?: { repo: string; number: number } | null
  ttl_seconds?: number | null
}

export type LiveApp = {
  service: Service
  environment: LiveEnvironment
  newest: Deployment | null
}

const newestByService = (deployments: Deployment[]) => {
  const newest = new Map<string, Deployment>()

  for (const deployment of deployments) {
    const service = (deployment as { service_id?: string }).service_id

    if (!service) {
      continue
    }

    const held = newest.get(service)

    if (!held || deployment.number > held.number) {
      newest.set(service, deployment)
    }
  }

  return newest
}

export const useLiveProjects = (scope: string | null) => {
  const { data } = useQuery(projectsQuery)

  return (data?.items ?? [])
    .filter((p) => !scope || p.name === scope || p.id === scope)
    .map((p) => ({
      id: p.id,
      name: p.name,
    }))
}

export const useLiveEnvironments = (projects: LiveProject[]) =>
  useQueries({
    queries: projects.map((project) => environmentsQuery(project.id)),
  }).flatMap((query, index) =>
    (query.data?.items ?? []).map((environment): LiveEnvironment => ({
      id: environment.id,
      name: environment.name,
      ephemeral: environment.ephemeral,
      project: projects[index]!,
      pull_request: environment.pull_request ?? null,
      ttl_seconds: environment.ttl_seconds ?? null,
    })),
  )

export const useLiveApps = (scope: string | null) => {
  const projects = useLiveProjects(scope)
  const environments = useLiveEnvironments(projects).filter((environment) => !environment.ephemeral)
  const services = useQueries({
    queries: environments.map((environment) => servicesQuery(environment.id)),
  })
  const deployments = useQueries({
    queries: environments.map((environment) => environmentDeploymentsQuery(environment.id)),
  })

  return environments.flatMap((environment, index) => {
    const newest = newestByService(deployments[index]?.data?.items ?? [])

    return (services[index]?.data?.items ?? []).map((service): LiveApp => ({
      service,
      environment,
      newest: newest.get(service.id) ?? null,
    }))
  })
}

export const failedApps = (apps: LiveApp[]) => apps.filter((app) => app.newest?.status === 'failed')

export const troubledApps = (apps: LiveApp[]) =>
  apps.filter(
    (app) =>
      app.newest?.status === 'failed' ||
      app.service.status === 'red' ||
      app.service.status === 'amber',
  )

export const healthText: Record<Service['status'], string> = {
  green: 'Healthy',
  amber: 'Unhealthy',
  red: 'Failing',
  stopped: 'Stopped',
  asleep: 'Asleep',
}

export const healthTone: Record<Service['status'], 'success' | 'warning' | 'danger' | 'neutral'> = {
  green: 'success',
  amber: 'warning',
  red: 'danger',
  stopped: 'neutral',
  asleep: 'neutral',
}

export const appLink = (service: Service) => {
  const domain = (service.domains ?? [])[0] as { hostname?: string } | undefined

  return domain?.hostname ? `https://${domain.hostname}` : null
}
