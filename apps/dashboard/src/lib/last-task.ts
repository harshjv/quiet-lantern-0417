const key = 'stationly.new-task.last'

export type LastTask = { project: string | null; environment: string | null; repository: string }

export const readLastTask = (): LastTask | null => {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? 'null') as Partial<LastTask> | null

    return value && typeof value.repository === 'string'
      ? {
          project: value.project ?? null,
          environment: value.environment ?? null,
          repository: value.repository,
        }
      : null
  } catch {
    return null
  }
}

export const writeLastTask = (value: LastTask) => {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    return
  }
}
