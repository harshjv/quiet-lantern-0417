import type { LinkOptions } from '@tanstack/react-router'

export const projectTo = (project: string, tab?: string): LinkOptions => ({
  to: '/p/$project',
  params: {
    project,
  },
  search: {
    tab,
  },
})

export const placeTo = (project: string, preview: string | null, tab?: string): LinkOptions =>
  preview
    ? {
        to: '/p/$project/previews/$preview',
        params: {
          project,
          preview,
        },
        search: {
          tab,
        },
      }
    : projectTo(project, tab)

export const appTo = (project: string, app: string, tab?: string): LinkOptions => ({
  to: '/p/$project/apps/$app/{-$tab}',
  params: {
    project,
    app,
    tab,
  },
})

export const tasksTo = (project: string): LinkOptions => ({
  to: '/p/$project/build',
  params: {
    project,
  },
})

export type TaskFilePlace = { path: string; file: string | null }

export const taskTo = (
  project: string,
  task: string,
  tab?: string,
  place?: TaskFilePlace,
): LinkOptions => ({
  to: '/p/$project/build/$task/{-$tab}',
  params: {
    project,
    task,
    tab,
  },
  search: {
    path: place?.path || undefined,
    file: place?.file ?? undefined,
  },
})

export const newTaskTo = (project: string, fix?: string): LinkOptions => ({
  to: '/p/$project/build/new',
  params: {
    project,
  },
  search: {
    fix,
  },
})

export const shipTo = (project: string): LinkOptions => ({
  to: '/p/$project/ship',
  params: {
    project,
  },
})

export const observeTo = (project: string, tab?: string): LinkOptions => ({
  to: '/p/$project/observe/{-$tab}',
  params: {
    project,
    tab,
  },
})

export const inboxTo = (project: string | null): LinkOptions => ({
  to: '/inbox',
  search: {
    project: project ?? undefined,
  },
})
