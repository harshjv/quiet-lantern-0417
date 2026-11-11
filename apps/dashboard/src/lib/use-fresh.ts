import { useState } from 'react'

import { changedKeys, signatureOf, unversioned, versionsOf, type Versions } from './fresh'

export const highlight = 'motion-safe:animate-highlight'

export function useFresh<T extends { id: string }>(
  items: readonly T[],
  version: Versions<T> = unversioned,
) {
  const rows = versionsOf(items, version)
  const signature = signatureOf(rows)
  const [state, setState] = useState(() => ({
    signature,
    seen: new Map(rows),
    fresh: new Set<string>(),
  }))

  if (state.signature !== signature) {
    setState({
      signature,
      seen: new Map(rows),
      fresh: changedKeys(state.seen, rows),
    })
  }

  return state.fresh
}
