import type { Service } from './api'
import { differenceInSeconds, format, formatDistanceToNowStrict, isValid, parseISO } from 'date-fns'

const parsed = (value: string | null | undefined) => {
  if (!value) return null
  const date = parseISO(value)
  return isValid(date) ? date : null
}

export const ago = (value: string | null | undefined) => {
  const date = parsed(value)
  return date ? formatDistanceToNowStrict(date, { addSuffix: true }) : '—'
}

export const stamp = (value: string | null | undefined) => {
  const date = parsed(value)
  return date ? format(date, 'yyyy-MM-dd HH:mm:ss') : '—'
}

export const clock = (value: string | null | undefined) => {
  const date = parsed(value)
  return date ? format(date, 'HH:mm:ss') : ''
}

export const duration = (from: string | null | undefined, to: string | null | undefined) => {
  const start = parsed(from)
  if (!start) return '—'
  const seconds = Math.max(0, differenceInSeconds(parsed(to) ?? new Date(), start))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export const bytes = (value: number | null | undefined) => {
  if (value === null || value === undefined) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let n = value
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i += 1
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`
}

export const shortSha = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : null)

export const json = (value: unknown) => (value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2))

export const shortDigest = (ref: string) => ref.replace(/@sha256:([a-f0-9]{12})[a-f0-9]{52}$/, '@sha256:$1…')

export const sourceText = (service: Pick<Service, 'source'>) => {
  const s = service.source
  if (s.type === 'image') return shortDigest(s.ref.includes('@') ? s.ref : `${s.ref}@${s.digest}`)
  if (s.type === 'dockerfile' || s.type === 'railpack') return `${s.repo.replace(/^github\.com\//, '')}@${s.branch}`
  if (s.type === 'local') return 'sly push'
  return 'template'
}

export const actorText = (actor: { type: string; client?: string | null }) => `${actor.type}${actor.client ? ` (${actor.client})` : ''}`

export const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)

export const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

export const slugPattern = '[a-z0-9][a-z0-9\\-]{0,62}'

export const slugTitle = 'Lower case letters, digits and hyphens, starting with a letter or digit'
