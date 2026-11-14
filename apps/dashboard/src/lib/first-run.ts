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
  const healthy = total(input.projects, (p) => p.status_counts.green)
  const sandboxes = total(input.projects, (p) => p.sandbox_count)
  const workspaces = total(input.projects, (p) => p.workspace_count)
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
    workspaces,
    used,
    waiting: input.tokens?.find((token) => !token.last_used_at),
    done: {
      secure: secured,
      project: input.projects.length > 0,
      service: healthy > 0,
      sandbox: sandboxes > 0,
      workspace: workspaces > 0,
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
