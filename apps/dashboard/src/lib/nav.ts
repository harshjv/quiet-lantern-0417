import { useSyncExternalStore } from 'react'

export const modes = ['build', 'ship', 'observe', 'outside'] as const

export type Mode = (typeof modes)[number]

export type Place = { mode: Mode; project: string | null; view: string | null; fix?: string | null }

export type Go = (next: Partial<Place>) => void

export const parsePlace = (hash: string): Place => {
  const [path, query] = hash.replace(/^#/, '').split('?')
  const [mode, ...view] = (path ?? '').split('/')
  const search = new URLSearchParams(query)

  return {
    mode: modes.find((m) => m === mode) ?? 'build',
    project: search.get('p') || null,
    view: view.join('/') || null,
    fix: search.get('fix') || null,
  }
}

export const placeHref = (place: Place) => {
  const search = new URLSearchParams()

  if (place.project) {
    search.set('p', place.project)
  }

  if (place.fix) {
    search.set('fix', place.fix)
  }

  const query = search.toString()

  return `#${place.mode}${place.view ? `/${place.view}` : ''}${query ? `?${query}` : ''}`
}

const subscribe = (notify: () => void) => {
  window.addEventListener('hashchange', notify)

  return () => window.removeEventListener('hashchange', notify)
}

const snapshot = () => location.hash

export const currentPlace = () => parsePlace(location.hash)

export const usePlace = () => parsePlace(useSyncExternalStore(subscribe, snapshot, () => ''))

export const nextPlace = (current: Place, next: Partial<Place>): Place => ({
  ...current,
  view: null,
  fix: null,
  ...next,
})

export const go: Go = (next) => {
  const href = placeHref(nextPlace(currentPlace(), next))

  if (href !== location.hash) {
    location.hash = href
  }
}

export const viewId = (view: string | null, kind: string) =>
  view?.startsWith(`${kind}:`) ? (view.slice(kind.length + 1).split('/')[0] ?? null) : null

export const viewTab = (view: string | null) => view?.split('/')[1] ?? null

export const places = {
  task: (id: string): Partial<Place> => ({
    mode: 'build',
    view: id,
  }),
  app: (id: string, tab: string | null = null): Partial<Place> => ({
    mode: 'ship',
    view: `app:${id}${tab ? `/${tab}` : ''}`,
  }),
  deployment: (id: string): Partial<Place> => ({
    mode: 'ship',
    view: `deployment:${id}`,
  }),
  machine: (id: string, tab: string | null = null): Partial<Place> => ({
    mode: 'ship',
    view: `machine:${id}${tab ? `/${tab}` : ''}`,
  }),
  project: (project: string, tab: string | null = null): Partial<Place> => ({
    mode: 'ship',
    project,
    view: tab,
  }),
  preview: (project: string, preview: string, tab: string | null = null): Partial<Place> => ({
    mode: 'ship',
    project,
    view: `preview:${preview}${tab ? `/${tab}` : ''}`,
  }),
  approval: (id: string): Partial<Place> => ({
    mode: 'outside',
    view: `approval:${id}`,
  }),
  page: (id: string): Partial<Place> => ({
    mode: 'outside',
    view: id,
  }),
}
