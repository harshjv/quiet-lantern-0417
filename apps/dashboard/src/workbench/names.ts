import { useQueries, useQuery } from '@tanstack/react-query'

import type { Names, Places } from '@/lib/changes'
import {
  appsQuery,
  namesQuery,
  previewsQuery,
  projectKeysQuery,
  projectsQuery,
} from '@/lib/queries'

import { serversQuery } from './server-data'

const known = (projects: readonly (string | null)[]) => [
  ...new Set(projects.filter((id): id is string => Boolean(id))),
]

export function usePlaces(projects: readonly (string | null)[]): Places {
  const ids = known(projects)
  const previews = useQueries({
    queries: ids.map((id) => previewsQuery(id)),
  }).flatMap((query, index) =>
    (query.data?.items ?? []).map((preview) => ({
      project: ids[index]!,
      preview,
    })),
  )
  const apps = useQueries({
    queries: previews.map((entry) =>
      appsQuery({
        project: entry.project,
        preview: entry.preview.id,
      }),
    ),
  })
  const places = new Map<string, string>()

  previews.forEach((entry, index) => {
    places.set(entry.preview.id, entry.preview.name)

    for (const app of apps[index]?.data?.items ?? []) {
      places.set(app.id, entry.preview.name)
    }
  })

  return places
}

export function useNames(projects: readonly (string | null)[]): Names {
  const ids = known(projects)
  const listed = useQuery(projectsQuery)
  const servers = useQuery({
    ...serversQuery,
    retry: false,
  })
  const apps = useQueries({
    queries: ids.map((id) => namesQuery(id)),
  })
  const previews = useQueries({
    queries: ids.map((id) => previewsQuery(id)),
  })
  const keys = useQueries({
    queries: ids.map((id) => projectKeysQuery(id, 'production')),
  })
  const names = new Map<string, string>()

  for (const project of listed.data?.items ?? []) {
    names.set(project.id, project.name)
  }

  for (const server of servers.data?.items ?? []) {
    names.set(server.id, server.name)
  }

  for (const preview of previews.flatMap((query) => query.data?.items ?? [])) {
    names.set(preview.id, preview.name)
  }

  for (const key of keys.flatMap((query) => query.data?.items ?? [])) {
    names.set(key.id, key.name)
  }

  for (const app of apps.flatMap((query) => query.data?.items ?? [])) {
    names.set(app.id, app.name)

    for (const port of app.ports ?? []) {
      names.set(port.id, `${app.name} port ${port.port}`)
    }

    for (const volume of app.volumes ?? []) {
      names.set(volume.id, `${app.name} ${volume.mount_path}`)
    }

    for (const domain of app.domains ?? []) {
      names.set(domain.id, domain.hostname)
    }

    for (const key of app.keys ?? []) {
      names.set(key.id, key.name)
    }
  }

  return names
}
