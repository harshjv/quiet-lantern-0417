import { useQuery, useSuspenseQuery } from '@tanstack/react-query'

import { scopeOf, type PlaceView } from './place'
import { previewQueryOf, projectQuery } from './queries'

type Placed = { project_id: string; preview_id: string | null }

export function useTrail(row: Placed) {
  const { data: project } = useSuspenseQuery(projectQuery(row.project_id))
  const { data: preview } = useQuery({
    ...previewQueryOf(row.preview_id ?? ''),
    enabled: row.preview_id !== null,
  })
  const place: PlaceView = {
    project: project.id,
    preview: row.preview_id,
    projectName: project.name,
    previewName: row.preview_id ? (preview?.name ?? row.preview_id) : null,
  }

  return {
    project,
    place,
    scope: scopeOf(place),
    production: row.preview_id === null,
  }
}
