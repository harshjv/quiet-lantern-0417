import { DryRun, Exit, exitCodes, type Envelope } from './errors.ts'
import type { Globals, Sent } from './kit.ts'

const scalar = (value: unknown) => value === null || ['string', 'number', 'boolean'].includes(typeof value)

const cell = (value: unknown) => (value === null || value === undefined ? '-' : typeof value === 'object' ? JSON.stringify(value) : String(value))

export const table = (rows: Record<string, unknown>[], width = 60) => {
  if (rows.length === 0) return '(none)'
  const columns = Object.keys(rows[0]!).filter(key => rows.some(row => scalar(row[key]))).slice(0, 7)
  const cells = rows.map(row => columns.map(column => cell(row[column]).slice(0, width)))
  const widths = columns.map((column, i) => Math.max(column.length, ...cells.map(r => r[i]!.length)))
  const line = (values: string[]) => values.map((v, i) => v.padEnd(widths[i]!)).join('  ').trimEnd()
  return [line(columns.map(c => c.toUpperCase())), ...cells.map(line)].join('\n')
}

const tree = (value: unknown, indent = ''): string => {
  if (Array.isArray(value)) {
    if (value.length === 0) return `${indent}(none)`
    if (value.every(v => v !== null && typeof v === 'object' && !Array.isArray(v))) return table(value as Record<string, unknown>[]).split('\n').map(l => indent + l).join('\n')
    return value.map(v => `${indent}- ${cell(v)}`).join('\n')
  }
  if (value === null || typeof value !== 'object') return `${indent}${cell(value)}`
  return Object.entries(value as Record<string, unknown>)
    .map(([key, v]) => (scalar(v) ? `${indent}${key}: ${cell(v)}` : `${indent}${key}:\n${tree(v, `${indent}  `)}`))
    .join('\n')
}

export const human = (data: unknown) => {
  if (data !== null && typeof data === 'object' && 'items' in data && Array.isArray((data as { items: unknown }).items)) {
    const { items, next_cursor } = data as { items: Record<string, unknown>[]; next_cursor?: string | null }
    return next_cursor ? `${table(items)}\n\nmore: --cursor ${next_cursor}` : table(items)
  }
  return tree(data)
}

export const progress = (message: string) => process.stderr.write(`${message}\n`)

const isStaged = (sent: Sent) => sent.status === 202

export const print = (globals: Globals, sent: Sent, render: (data: unknown) => string = human) => {
  process.stdout.write(globals.json ? `${JSON.stringify(sent.data, null, 2)}\n` : `${render(sent.data)}\n`)
  if (isStaged(sent)) {
    const id = (sent.data as { id?: string }).id
    progress(`staged: nothing was applied; ${id ?? 'the staged change'} waits for acceptance (sly staged accept ${id ?? '<id>'})`)
    return exitCodes.staged
  }
  return exitCodes.ok
}

const printEnvelope = (globals: Globals, envelope: Envelope) => {
  if (globals.json) process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`)
  else {
    process.stderr.write(`error: ${envelope.error.explanation}\n`)
    if (envelope.error.fix) process.stderr.write(`fix: ${envelope.error.fix}\n`)
    if (envelope.error.details) process.stderr.write(`details: ${JSON.stringify(envelope.error.details)}\n`)
    if (envelope.error.request_id) process.stderr.write(`request: ${envelope.error.request_id}\n`)
  }
  process.stderr.write(`${envelope.error.code}\n`)
}

export const fail = (globals: Globals, error: unknown) => {
  if (error instanceof DryRun) {
    process.stdout.write(`${JSON.stringify(error.request, null, 2)}\n`)
    progress('dry run: the request above was not sent')
    return exitCodes.ok
  }
  if (error instanceof Exit) {
    if (error.envelope) printEnvelope(globals, error.envelope)
    return error.code
  }
  printEnvelope(globals, { error: { code: 'INTERNAL_ERROR', explanation: error instanceof Error ? error.message : String(error), fix: 'Report this sly failure with the command you ran.' } })
  return exitCodes.api
}
