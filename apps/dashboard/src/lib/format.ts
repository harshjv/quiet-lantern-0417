import { differenceInSeconds, format, formatDistanceStrict, isValid, parseISO } from 'date-fns'

import { slugPattern as slugSource } from '@stationly/protocol/domain'
import { bytesText } from '@stationly/protocol/format'

import type { Service } from './api'

const parsed = (value: string | null | undefined) => {
  if (!value) {
    return null
  }

  const date = parseISO(value)

  return isValid(date) ? date : null
}

export const blank = '—'

export const ago = (value: string | null | undefined, now = new Date()) => {
  const date = parsed(value)

  if (!date) {
    return 'never'
  }

  if (Math.abs(differenceInSeconds(now, date)) < 5) {
    return 'just now'
  }

  return formatDistanceStrict(date, now, {
    addSuffix: true,
  })
}

export const stamp = (value: string | null | undefined) => {
  const date = parsed(value)

  return date ? format(date, 'yyyy-MM-dd HH:mm:ss zzz') : 'not yet'
}

export const span = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds))
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)

  if (days > 0) {
    return hours ? `${days} d ${hours} h` : `${days} d`
  }

  if (hours > 0) {
    return minutes ? `${hours} h ${minutes} min` : `${hours} h`
  }

  if (minutes > 0) {
    return total % 60 ? `${minutes} min ${total % 60} s` : `${minutes} min`
  }

  return `${total} s`
}

export const clock = (value: string | null | undefined) => {
  const date = parsed(value)

  return date ? format(date, 'HH:mm:ss') : ''
}

export const duration = (
  from: string | null | undefined,
  to: string | null | undefined,
  now = new Date(),
) => {
  const start = parsed(from)

  return start ? span(differenceInSeconds(parsed(to) ?? now, start)) : blank
}

export const bytes = (value: number | null | undefined) =>
  value === null || value === undefined ? blank : bytesText(value)

export const shortSha = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : null)

export const json = (value: unknown) =>
  value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2)

export const shortDigest = (ref: string) =>
  ref.replace(/@sha256:([a-f0-9]{12})[a-f0-9]{52}$/, '@sha256:$1…')

export const sourceText = (service: Pick<Service, 'source'>) => {
  const s = service.source

  if (s.type === 'image') {
    return shortDigest(s.ref.includes('@') ? s.ref : `${s.ref}@${s.digest}`)
  }

  if (s.type === 'dockerfile' || s.type === 'railpack') {
    return `${s.repo.replace(/^github\.com\//, '')}@${s.branch}`
  }

  if (s.type === 'local') {
    return 'Uploaded from a folder'
  }

  return 'Template'
}

export const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)

export const plural = (count: number, word: string, many = `${word}s`) =>
  `${count} ${count === 1 ? word : many}`

export const inputPattern = (pattern: string) => pattern.slice(1, -1).replaceAll('-]', '\\-]')

export const slugPattern = inputPattern(slugSource)

export const slugTitle = 'Lower case letters, digits and hyphens, starting with a letter or digit'

export const changeSummary = (summary: {
  add: number
  update: number
  remove: number
  deployments: number
}) =>
  [
    `${summary.add} added`,
    `${summary.update} changed`,
    `${summary.remove} removed`,
    ...(summary.deployments ? [`starts ${plural(summary.deployments, 'deployment')}`] : []),
  ].join(' · ')

export const repositoryName = (url: string) => {
  const parts = url
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean)

  return parts.length >= 2 ? parts.slice(-2).join('/') : url
}

export const shortAgo = (value: string | null | undefined, now = new Date()) => {
  const date = parsed(value)

  if (!date) {
    return ''
  }

  const seconds = Math.max(0, differenceInSeconds(now, date))

  if (seconds < 60) {
    return 'now'
  }

  const minutes = Math.floor(seconds / 60)

  if (minutes < 60) {
    return `${minutes}m`
  }

  const hours = Math.floor(minutes / 60)

  if (hours < 24) {
    return `${hours}h`
  }

  const days = Math.floor(hours / 24)

  return days < 7 ? `${days}d` : `${Math.floor(days / 7)}w`
}
