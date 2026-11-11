import type { Static, TSchema } from '@sinclair/typebox'

export type FieldTree = Map<string, FieldTree>

export const all: FieldTree = new Map([['*', new Map()]])

export const parseFields = (text: string | undefined): FieldTree | undefined => {
  if (text === undefined || text.trim() === '') {
    return undefined
  }

  const root: FieldTree = new Map()

  for (const raw of text.split(',')) {
    const path = raw.trim()

    if (!path) {
      continue
    }

    let node = root

    for (const part of path.split('.')) {
      let next = node.get(part)

      if (!next) {
        next = new Map()
        node.set(part, next)
      }

      node = next
    }
  }

  return root
}

export type Row = Record<string, unknown>

export type View<R, S extends TSchema = TSchema> = {
  schema: S
  full: (row: R) => Row
  summary: string[]
  expand?: Record<string, (row: R, sub: FieldTree | undefined) => unknown>
}

const setPath = (out: Row, path: string[], value: unknown) => {
  let node = out

  for (const part of path.slice(0, -1)) {
    if (typeof node[part] !== 'object' || node[part] === null) {
      node[part] = {}
    }

    node = node[part] as Row
  }

  node[path.at(-1)!] = value
}

const getPath = (row: Row, path: string[]) =>
  path.reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Row)[part] : undefined),
    row,
  )

export const project = <R, S extends TSchema>(
  view: View<R, S>,
  row: R,
  fields: FieldTree | undefined,
): Static<S> => {
  const full = view.full(row)
  const out: Row = {}

  for (const field of view.summary) {
    const path = field.split('.')
    const value = getPath(full, path)

    if (value !== undefined) {
      setPath(out, path, value)
    }
  }

  if (!fields) {
    return out
  }

  const everything = fields.has('*')

  if (everything) {
    Object.assign(out, full)
  }

  const expansions = view.expand ?? {}

  for (const [name, loader] of Object.entries(expansions)) {
    if (everything || fields.has(name)) {
      out[name] = loader(row, everything ? (fields.get(name) ?? all) : fields.get(name))
    }
  }

  for (const key of fields.keys()) {
    if (key === '*' || key in expansions) {
      continue
    }

    const value = full[key]

    if (value !== undefined) {
      out[key] = value
    }
  }

  return out
}

export const projectAll = <R, S extends TSchema>(
  view: View<R, S>,
  rows: R[],
  fields: FieldTree | undefined,
) => rows.map((row) => project(view, row, fields))
