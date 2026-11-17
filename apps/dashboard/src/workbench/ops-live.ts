import { useQueries, useQuery } from '@tanstack/react-query'

import type { App, Deployment, Preview } from '@/lib/api'
import { appsQuery, placeDeploymentsQuery, previewsQuery, projectsQuery } from '@/lib/queries'

export type LiveProject = { id: string; name: string }

export type LivePlace = {
  key: string
  name: string
  project: LiveProject
  preview: Preview | null
}

export type LiveApp = {
  app: App
  place: LivePlace
  newest: Deployment | null
}

const newestByApp = (deployments: Deployment[]) => {
  const newest = new Map<string, Deployment>()

  for (const deployment of deployments) {
    const app = (deployment as { app_id?: string }).app_id

    if (!app) {
      continue
    }

    const held = newest.get(app)

    if (!held || deployment.number > held.number) {
      newest.set(app, deployment)
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

export const useLivePreviews = (projects: LiveProject[]) =>
  useQueries({
    queries: projects.map((project) => previewsQuery(project.id)),
  }).flatMap((query, index) =>
    (query.data?.items ?? []).map((preview): LivePlace => ({
      key: preview.id,
      name: preview.name,
      project: projects[index]!,
      preview,
    })),
  )

const lasting = (place: LivePlace) => !place.preview || place.preview.origin.type === 'named'

export const useLivePlaces = (projects: LiveProject[]) => [
  ...projects.map((project): LivePlace => ({
    key: project.id,
    name: 'production',
    project,
    preview: null,
  })),
  ...useLivePreviews(projects),
]

export const useLiveApps = (scope: string | null) => {
  const projects = useLiveProjects(scope)
  const places = useLivePlaces(projects).filter(lasting)
  const target = (place: LivePlace) => ({
    project: place.project.id,
    preview: place.preview?.id ?? null,
  })
  const apps = useQueries({
    queries: places.map((place) => appsQuery(target(place))),
  })
  const deployments = useQueries({
    queries: places.map((place) => placeDeploymentsQuery(target(place))),
  })

  return places.flatMap((place, index) => {
    const newest = newestByApp(deployments[index]?.data?.items ?? [])

    return (apps[index]?.data?.items ?? []).map((app): LiveApp => ({
      app,
      place,
      newest: newest.get(app.id) ?? null,
    }))
  })
}

export const failedApps = (apps: LiveApp[]) =>
  apps.filter((live) => live.newest?.status === 'failed')

export const failingApps = (apps: LiveApp[]) => apps.filter((live) => live.app.status === 'failing')

export const appLink = (app: App) => {
  const domain = (app.domains ?? [])[0] as { hostname?: string } | undefined

  return domain?.hostname ? `https://${domain.hostname}` : null
}
