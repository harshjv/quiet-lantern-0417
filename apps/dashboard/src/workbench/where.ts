import { linkOptions, useMatches, useParams, useSearch } from '@tanstack/react-router'

import { placeTo } from '@/lib/links'
import { z } from '@/lib/zod'

export type Mode = 'build' | 'ship' | 'observe' | 'outside'

export const projectSearch = z.object({
  project: z.string().optional().catch(undefined),
})

export const useMode = () =>
  useMatches({
    select: (matches): Mode =>
      matches.findLast((match) => match.staticData.mode)?.staticData.mode ?? 'build',
  })

export const useProject = () => {
  const params = useParams({
    strict: false,
  })
  const search = useSearch({
    strict: false,
  })
  const loaded = useMatches({
    select: (matches) =>
      matches.findLast((match) => match.loaderData?.project)?.loaderData?.project,
  })

  return params.project ?? search.project ?? loaded ?? null
}

export const modeHome = (mode: Mode, project: string | null) => {
  const search = {
    project: project ?? undefined,
  }

  switch (mode) {
    case 'build':
      return linkOptions({
        to: '/build',
        search,
      })
    case 'ship':
      return project
        ? placeTo(project, null)
        : linkOptions({
            to: '/projects',
          })
    case 'observe':
      return linkOptions({
        to: '/observe/{-$tab}',
        params: {
          tab: undefined,
        },
        search,
      })
    case 'outside':
      return linkOptions({
        to: '/inbox',
        search,
      })
  }
}
