import { slugPattern, variableKeyPattern } from '@stationly/protocol'

import { SecretsError } from './errors.ts'

export type Target =
  | { type: 'service'; service: string; key: string }
  | { type: 'project'; key: string }
  | { type: 'global'; key: string }
  | { type: 'shared'; alias: string; key: string }
  | { type: 'generator'; bytes: number }

export type Segment =
  | { type: 'text'; text: string }
  | { type: 'reference'; offset: number; raw: string; target: Target }

export const keyPattern = new RegExp(variableKeyPattern)
const slug = new RegExp(slugPattern)
const generatorPattern = /^secret\((\d{1,3})\)$/

const invalid = (value: string, offset: number, reason: string) =>
  new SecretsError('VARIABLE_REFERENCE_INVALID', `${reason} at offset ${offset}`, {
    offset,
    value_length: value.length,
    reason,
  })

const parseTarget = (value: string, text: string, offset: number): Target => {
  const generator = generatorPattern.exec(text)
  if (generator) {
    const bytes = Number(generator[1])
    if (bytes < 16 || bytes > 128)
      throw invalid(value, offset, `secret(${bytes}) needs between 16 and 128 bytes`)
    return {
      type: 'generator',
      bytes,
    }
  }
  const parts = text.split('.')
  const checkKey = (key: string | undefined, at: number) => {
    if (key === undefined || !keyPattern.test(key))
      throw invalid(value, at, `"${key ?? ''}" is not a variable key (${variableKeyPattern})`)
    return key
  }
  const keyOffset = offset + text.lastIndexOf('.') + 1
  if (parts.length === 2 && parts[0] === 'project')
    return {
      type: 'project',
      key: checkKey(parts[1], keyOffset),
    }
  if (parts.length === 2 && parts[0] === 'global')
    return {
      type: 'global',
      key: checkKey(parts[1], keyOffset),
    }
  if (parts.length === 3 && parts[0] === 'shared') {
    if (!slug.test(parts[1]!))
      throw invalid(value, offset + 'shared.'.length, `"${parts[1]}" is not an attachment alias`)
    return {
      type: 'shared',
      alias: parts[1]!,
      key: checkKey(parts[2], keyOffset),
    }
  }
  if (parts.length === 2) {
    if (!slug.test(parts[0]!)) throw invalid(value, offset, `"${parts[0]}" is not a service name`)
    return {
      type: 'service',
      service: parts[0]!,
      key: checkKey(parts[1], keyOffset),
    }
  }
  throw invalid(value, offset, `"${text}" is not a known reference target`)
}

export const parseValue = (value: string): Segment[] => {
  const segments: Segment[] = []
  let text = ''
  let i = 0
  const flush = () => {
    if (text)
      segments.push({
        type: 'text',
        text,
      })
    text = ''
  }
  while (i < value.length) {
    if (value.startsWith('$${{', i)) {
      text += '${{'
      i += 4
      continue
    }
    if (!value.startsWith('${{', i)) {
      text += value[i]
      i += 1
      continue
    }
    const start = i
    let j = i + 3
    while (value[j] === ' ') j++
    const targetStart = j
    while (j < value.length && value[j] !== ' ' && value[j] !== '}' && !value.startsWith('${{', j))
      j++
    const targetText = value.slice(targetStart, j)
    while (value[j] === ' ') j++
    if (!value.startsWith('}}', j)) throw invalid(value, j, 'reference has no closing "}}"')
    if (!targetText) throw invalid(value, targetStart, 'reference names no target')
    const target = parseTarget(value, targetText, targetStart)
    flush()
    segments.push({
      type: 'reference',
      offset: start,
      raw: value.slice(start, j + 2),
      target,
    })
    i = j + 2
  }
  flush()
  const generator = segments.find((s) => s.type === 'reference' && s.target.type === 'generator')
  if (generator && segments.length > 1)
    throw invalid(
      value,
      (generator as { offset: number }).offset,
      'secret(N) must be the entire value',
    )
  return segments
}

export const hasReference = (segments: Segment[]) => segments.some((s) => s.type === 'reference')
