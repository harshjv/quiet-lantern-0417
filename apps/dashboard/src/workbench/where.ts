import { useMatches, useParams, type LinkOptions } from '@tanstack/react-router'

import { observeTo, projectTo, shipTo, tasksTo } from '@/lib/links'

export type View = 'overview' | 'build' | 'ship' | 'observe'

export type Mode = View | 'home' | 'outside'

export const views: View[] = ['overview', 'build', 'ship', 'observe']

export const isView = (mode: Mode): mode is View => views.includes(mode as View)

export const useMode = () =>
  useMatches({
    select: (matches): Mode =>
      matches.findLast((match) => match.staticData.mode)?.staticData.mode ?? 'home',
  })

export const useProject = () =>
  useParams({
    strict: false,
    select: (params) => params.project ?? null,
  })

export const inProject =
  (to: (project: string) => LinkOptions) =>
  (project: string | null): LinkOptions =>
    project
      ? to(project)
      : {
          to: '/',
        }

export const viewTo = (view: View, project: string) => {
  switch (view) {
    case 'overview':
      return projectTo(project)
    case 'build':
      return tasksTo(project)
    case 'ship':
      return shipTo(project)
    case 'observe':
      return observeTo(project)
  }
}
