import { useSyncExternalStore } from 'react'

import type { Project } from '@/lib/api'

const key = 'stationly.get-started.hidden'
const changed = 'stationly:get-started'

let fallback = false

const read = () => {
  try {
    return window.localStorage.getItem(key) === '1'
  } catch {
    return fallback
  }
}

const subscribe = (notify: () => void) => {
  window.addEventListener('storage', notify)
  window.addEventListener(changed, notify)
  return () => {
    window.removeEventListener('storage', notify)
    window.removeEventListener(changed, notify)
  }
}

const store = (hidden: boolean) => {
  try {
    if (hidden) window.localStorage.setItem(key, '1')
    else window.localStorage.removeItem(key)
  } catch {
    return
  }
}

export const setGuideHidden = (hidden: boolean) => {
  fallback = hidden
  store(hidden)
  window.dispatchEvent(new Event(changed))
}

export const useGuideHidden = () => useSyncExternalStore(subscribe, read)

type GuideToken = {
  last_used_at?: string | null
}

type GuideInput<T extends GuideToken> = {
  projects: Project[]
  totp: boolean | undefined
  passkeys: number | undefined
  passkeysSettled: boolean
  tokens: T[] | undefined
}

const total = (projects: Project[], count: (project: Project) => number) =>
  projects.reduce((sum, project) => sum + count(project), 0)

export const guideProgress = <T extends GuideToken>(input: GuideInput<T>) => {
  const healthy = total(input.projects, (p) => p.status_counts.green)
  const sandboxes = total(input.projects, (p) => p.sandbox_count)
  const used = input.tokens?.find((token) => token.last_used_at)
  const secured =
    input.totp || Boolean(input.passkeys)
      ? true
      : input.totp === false && input.passkeysSettled
        ? false
        : undefined
  return {
    healthy,
    starting: total(input.projects, (p) => p.status_counts.amber),
    services: total(input.projects, (p) => p.service_count),
    sandboxes,
    used,
    waiting: input.tokens?.find((token) => !token.last_used_at),
    done: {
      secure: secured,
      project: input.projects.length > 0,
      service: healthy > 0,
      sandbox: sandboxes > 0,
      agent: input.tokens ? Boolean(used) : undefined,
    },
  }
}

export const guideVisible = (state: {
  hidden: boolean
  known: boolean
  complete: boolean
  seenOpen: boolean
}) => !state.hidden && state.known && (!state.complete || state.seenOpen)
