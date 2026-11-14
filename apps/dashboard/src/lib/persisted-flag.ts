import { useSyncExternalStore } from 'react'

export const persistedFlag = (key: string) => {
  const changed = `${key}:changed`
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

  const set = (value: boolean) => {
    fallback = value

    try {
      if (value) {
        window.localStorage.setItem(key, '1')
      } else {
        window.localStorage.removeItem(key)
      }
    } catch {
      return
    } finally {
      window.dispatchEvent(new Event(changed))
    }
  }

  return {
    set,
    use: () => useSyncExternalStore(subscribe, read),
  }
}
