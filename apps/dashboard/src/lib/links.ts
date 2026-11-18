import type { LinkOptions } from '@tanstack/react-router'

export const placeTo = (project: string, preview: string | null, tab?: string): LinkOptions =>
  preview
    ? {
        to: '/projects/$project/previews/$preview/{-$tab}',
        params: {
          project,
          preview,
          tab,
        },
      }
    : {
        to: '/projects/$project/{-$tab}',
        params: {
          project,
          tab,
        },
      }

export const appTo = (app: string, tab?: string): LinkOptions => ({
  to: '/apps/$app/{-$tab}',
  params: {
    app,
    tab,
  },
})

export const machineTo = (machine: string, tab?: string): LinkOptions => ({
  to: '/machines/$machine/{-$tab}',
  params: {
    machine,
    tab,
  },
})
