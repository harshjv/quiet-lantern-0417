import { isOptimistic } from './cache.ts'

export type Versioned = readonly [key: string, version: string]

export type Versions<T> = (item: T) => string

export const unversioned = () => ''

export const versionsOf = <T extends { id: string }>(items: readonly T[], version: Versions<T>) =>
  items.filter((item) => !isOptimistic(item)).map((item): Versioned => [item.id, version(item)])

export const signatureOf = (rows: readonly Versioned[]) =>
  rows.map(([key, version]) => `${key}@${version}`).join('\n')

export const changedKeys = (seen: ReadonlyMap<string, string>, rows: readonly Versioned[]) =>
  new Set(rows.filter(([key, version]) => seen.get(key) !== version).map(([key]) => key))
