import type { Project } from './api.ts'
import { persistedFlag } from './persisted-flag.ts'

const guideHidden = persistedFlag('stationly.get-started.hidden')

export const setGuideHidden = guideHidden.set

export const useGuideHidden = guideHidden.use

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
  const healthy = total(input.projects, (p) => p.status_counts.healthy)
  const tasks = total(input.projects, (p) => p.task_count)
  const used = input.tokens?.find((token) => token.last_used_at)
  const secured =
    input.totp || Boolean(input.passkeys)
      ? true
      : input.totp === false && input.passkeysSettled
        ? false
        : undefined

  return {
    healthy,
    deploying: total(input.projects, (p) => p.status_counts.deploying),
    apps: total(input.projects, (p) => p.app_count),
    tasks,
    used,
    waiting: input.tokens?.find((token) => !token.last_used_at),
    done: {
      secure: secured,
      project: input.projects.length > 0,
      app: healthy > 0,
      task: tasks > 0,
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
