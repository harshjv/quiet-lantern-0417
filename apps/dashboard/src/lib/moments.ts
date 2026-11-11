import type { DeploymentStatus } from './api'

export type Watch = { key: string; waited: boolean }

export const watching = (key: string, value: boolean | undefined): Watch => ({
  key,
  waited: value === false,
})

export const nextWatch = (watch: Watch, key: string, value: boolean | undefined): Watch => {
  if (watch.key !== key) {
    return watching(key, value)
  }

  if (value || watch.waited) {
    return watch
  }

  return watching(key, value)
}

export const hasBecome = (watch: Watch, key: string, value: boolean | undefined) =>
  value === true && watch.key === key && watch.waited

const wentLive = new Set<DeploymentStatus>(['active', 'superseded'])

export const isFirstLive = (
  deployment: string,
  history: readonly { id: string; status: DeploymentStatus }[],
) => !history.some((d) => d.id !== deployment && wentLive.has(d.status))
