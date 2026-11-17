import { useQueries, useQuery } from '@tanstack/react-query'

import type { Names } from '@/lib/changes'
import { namesQuery, previewsQuery, projectKeysQuery, projectsQuery } from '@/lib/queries'

import { serversQuery } from './server-data'

export function useNames(projects: readonly (string | null)[]): Names {
  const ids = [...new Set(projects.filter((id): id is string => Boolean(id)))]
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

    for (const allocation of app.port_allocations ?? []) {
      names.set(allocation.id, allocation.address ?? `public port ${allocation.host_port}`)
    }

    for (const key of app.keys ?? []) {
      names.set(key.id, key.name)
    }
  }

  return names
}
