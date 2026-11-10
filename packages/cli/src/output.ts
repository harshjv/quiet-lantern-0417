import { DryRun, Exit, exitCodes, type Envelope } from './errors.ts'
import type { Globals, Sent } from './kit.ts'

const scalar = (value: unknown) =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value)

const cell = (value: unknown) =>
  value === null || value === undefined
    ? '-'
    : typeof value === 'string'
      ? value
      : JSON.stringify(value)

const present = (value: unknown) => value !== null && value !== undefined && value !== ''

const fitting = (widths: number[]) => {
  const limit = process.stdout.isTTY ? process.stdout.columns : Infinity
  let used = -2
  return widths.findIndex((width) => (used += width + 2) > limit)
}

export const table = (
  rows: Record<string, unknown>[],
  width = 60,
  columns = Object.keys(rows[0] ?? {})
    .filter((key) => rows.some((row) => scalar(row[key])))
    .slice(0, 7),
) => {
  if (rows.length === 0) return '(none)'
  const shown = columns.filter((column) => rows.some((row) => present(row[column])))
  const headers = shown.map((column) => column.replaceAll('_', ' ').toUpperCase())
  const cells = rows.map((row) => shown.map((column) => cell(row[column]).slice(0, width)))
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...cells.map((r) => r[i]!.length)),
  )
  const cut = fitting(widths)
  const line = (values: string[]) =>
    values
      .slice(0, cut < 1 ? undefined : cut)
      .map((v, i) => v.padEnd(widths[i]!))
      .join('  ')
      .trimEnd()
  return [line(headers), ...cells.map(line)].join('\n')
}

const tree = (value: unknown, indent = ''): string => {
  if (Array.isArray(value)) {
    if (value.length === 0) return `${indent}(none)`
    if (value.every((v) => v !== null && typeof v === 'object' && !Array.isArray(v)))
      return table(value as Record<string, unknown>[])
        .split('\n')
        .map((l) => indent + l)
        .join('\n')
    return value.map((v) => `${indent}- ${cell(v)}`).join('\n')
  }
  if (value === null || typeof value !== 'object') return `${indent}${cell(value)}`
  const entries = Object.entries(value as Record<string, unknown>)
  const key = Math.max(0, ...entries.filter(([, v]) => scalar(v)).map(([k]) => k.length))
  return entries
    .map(([k, v]) =>
      scalar(v)
        ? `${indent}${k.padEnd(key)}  ${cell(v)}`
        : `${indent}${k}\n${tree(v, `${indent}  `)}`,
    )
    .join('\n')
}

const isPage = (
  data: unknown,
): data is { items: Record<string, unknown>[]; next_cursor?: string | null } =>
  data !== null && typeof data === 'object' && 'items' in data && Array.isArray(data.items)

export const human = (data: unknown, columns?: string[]) => {
  if (isPage(data)) {
    const rows = table(data.items, 60, columns)
    return data.next_cursor ? `${rows}\n\nmore: --cursor ${data.next_cursor}` : rows
  }
  return tree(data)
}

export const progress = (message: string) => process.stderr.write(`${message}\n`)

export const json = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)

export const staged = (sent: Sent, outcome: string) => {
  const id = (sent.data as { id?: string }).id
  progress(
    `staged: nothing was ${outcome}; ${id ?? 'the staged change'} waits for acceptance (sly staged accept ${id ?? '<id>'})`,
  )
  return exitCodes.staged
}

export const print = <T>(globals: Globals, sent: Sent<T>, render: (data: T) => string = human) => {
  if (globals.json) json(sent.data)
  else process.stdout.write(`${render(sent.data)}\n`)
  return sent.status === 202 ? staged(sent, 'applied') : exitCodes.ok
}

const printEnvelope = (globals: Globals, envelope: Envelope) => {
  if (globals.json) json(envelope)
  else {
    process.stderr.write(`error: ${envelope.error.explanation}\n`)
    if (envelope.error.fix) process.stderr.write(`fix: ${envelope.error.fix}\n`)
    if (envelope.error.details)
      process.stderr.write(`details: ${JSON.stringify(envelope.error.details)}\n`)
    if (envelope.error.request_id) process.stderr.write(`request: ${envelope.error.request_id}\n`)
  }
  process.stderr.write(`${envelope.error.code}\n`)
}

export const fail = (globals: Globals, error: unknown) => {
  if (error instanceof DryRun) {
    json(error.request)
    progress('dry run: the request above was not sent')
    return exitCodes.ok
  }
  if (error instanceof Exit) {
    if (error.envelope) printEnvelope(globals, error.envelope)
    return error.code
  }
  printEnvelope(globals, {
    error: {
      code: 'INTERNAL_ERROR',
      explanation: error instanceof Error ? error.message : String(error),
      fix: 'Report this sly failure with the command you ran.',
    },
  })
  return exitCodes.api
}
