import type { TSchema } from '@sinclair/typebox'
import { Value, ValueErrorType, type ValueError } from '@sinclair/typebox/value'
import {
  isMap,
  isPair,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  type Document,
  type Node,
} from 'yaml'

import { Manifest, Service, type ManifestDoc, type ServiceDoc } from './schema.ts'

export type Issue = { path: string; code: string; message: string; line?: number; column?: number }

export type Parsed = {
  value: unknown
  issues: Issue[]
  locate: (issue: Issue, at?: 'key' | 'value') => Issue
}

const unescape = (segment: string) => segment.replaceAll('~1', '/').replaceAll('~0', '~')

export const pointer = (segments: (string | number)[]) =>
  segments.map((s) => `/${String(s).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('')

export const segmentsOf = (path: string) =>
  path === '' || path === '/' ? [] : path.split('/').slice(1).map(unescape)

const locator =
  (doc: Document | null, counter: LineCounter | null) =>
  (issue: Issue, at: 'key' | 'value' = 'value'): Issue => {
    if (!doc || !counter || issue.line !== undefined) {
      return issue
    }

    let node: unknown = doc.contents
    let keyNode: Node | null = null
    let best: Node | null = doc.contents ?? null

    for (const segment of segmentsOf(issue.path)) {
      keyNode = null

      if (isMap(node)) {
        const pair = node.items.find(
          (item) => isPair(item) && isScalar(item.key) && String(item.key.value) === segment,
        )

        if (!pair) {
          break
        }

        keyNode = pair.key as Node
        node = pair.value
      } else if (isSeq(node)) {
        node = node.items[Number(segment)]
      } else {
        break
      }

      if (node && typeof node === 'object' && 'range' in node) {
        best = node as Node
      } else if (keyNode) {
        best = keyNode
      }
    }

    const target = at === 'key' && keyNode ? keyNode : best
    const offset = target?.range?.[0]

    if (offset === undefined) {
      return issue
    }

    const { line, col } = counter.linePos(offset)

    return {
      ...issue,
      line,
      column: col,
    }
  }

export const parseText = (text: string): Parsed => {
  const counter = new LineCounter()
  const doc = parseDocument(text, {
    lineCounter: counter,
    prettyErrors: true,
    uniqueKeys: true,
    version: '1.2',
  })
  const locate = locator(doc, counter)

  if (doc.errors.length) {
    return {
      value: undefined,
      locate,
      issues: doc.errors.map((error) => ({
        path: '',
        code: 'YAML_SYNTAX',
        message: error.message.split('\n')[0]!,
        ...(error.linePos
          ? {
              line: error.linePos[0].line,
              column: error.linePos[0].col,
            }
          : {}),
      })),
    }
  }

  return {
    value: doc.toJS({
      maxAliasCount: 100,
    }),
    issues: [],
    locate,
  }
}

export const parseInput = (input: unknown): Parsed =>
  typeof input === 'string'
    ? parseText(input)
    : {
        value: input,
        issues: [],
        locate: (issue) => issue,
      }

const aliases: Record<string, string> = {
  timetable: 'schedule',
  env: 'variables',
  vars: 'variables',
  image: 'source',
  replicas: '',
  dockerfile_path: 'source.dockerfile',
}

const distance = (a: string, b: string) => {
  const row = Array.from(
    {
      length: b.length + 1,
    },
    (_, i) => i,
  )

  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!

    row[0] = i

    for (let j = 1; j <= b.length; j++) {
      const temp = row[j]!

      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = temp
    }
  }

  return row[b.length]!
}

const suggest = (key: string, known: string[]) => {
  if (key in aliases) {
    return aliases[key] ? `; did you mean ${aliases[key]}?` : ''
  }

  const ranked = known.map((k) => [k, distance(key, k)] as const).sort((x, y) => x[1] - y[1])
  const nearest = ranked[0]

  return nearest && nearest[1] <= Math.max(2, Math.floor(key.length / 3))
    ? `; did you mean ${nearest[0]}?`
    : ''
}

type Schema = TSchema & {
  properties?: Record<string, TSchema>
  patternProperties?: Record<string, TSchema>
  anyOf?: TSchema[]
  const?: unknown
  type?: string
  required?: string[]
}

const rangeTypes = new Set([
  ValueErrorType.IntegerMaximum,
  ValueErrorType.IntegerMinimum,
  ValueErrorType.IntegerExclusiveMaximum,
  ValueErrorType.IntegerExclusiveMinimum,
  ValueErrorType.NumberMaximum,
  ValueErrorType.NumberMinimum,
  ValueErrorType.NumberExclusiveMaximum,
  ValueErrorType.NumberExclusiveMinimum,
  ValueErrorType.ArrayMaxItems,
  ValueErrorType.ArrayMinItems,
  ValueErrorType.StringMaxLength,
  ValueErrorType.StringMinLength,
])

const isLiteralUnion = (schema: Schema) =>
  Array.isArray(schema.anyOf) &&
  schema.anyOf.every((member) => (member as Schema).const !== undefined)

const typeName = (value: unknown) =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value

const pickMember = (schema: Schema, value: unknown): Schema | null => {
  const members = (schema.anyOf ?? []) as Schema[]
  const discriminated = members.filter((m) => m.properties?.type?.const !== undefined)

  if (discriminated.length && value && typeof value === 'object' && !Array.isArray(value)) {
    const tag = (value as { type?: unknown }).type

    return discriminated.find((m) => (m.properties!.type as Schema).const === tag) ?? null
  }

  const objects = members.filter((m) => m.type === 'object')

  if (value && typeof value === 'object' && !Array.isArray(value) && objects.length === 1) {
    return objects[0]!
  }

  const arrays = members.filter((m) => m.type === 'array')

  if (Array.isArray(value) && arrays.length === 1) {
    return arrays[0]!
  }

  return null
}

const describeUnion = (schema: Schema) =>
  ((schema.anyOf ?? []) as Schema[])
    .map((m) =>
      m.properties?.type?.const !== undefined
        ? `type ${String(m.properties.type.const)}`
        : (m.type ?? 'value'),
    )
    .join(', ')

const bound = (schema: Schema) => {
  const s = schema as Partial<
    Record<
      | 'minimum'
      | 'exclusiveMinimum'
      | 'minItems'
      | 'minLength'
      | 'maximum'
      | 'exclusiveMaximum'
      | 'maxItems'
      | 'maxLength',
      number
    >
  >
  const low = s.minimum ?? s.exclusiveMinimum ?? s.minItems ?? s.minLength
  const high = s.maximum ?? s.exclusiveMaximum ?? s.maxItems ?? s.maxLength

  return low !== undefined && high !== undefined
    ? `outside ${low} to ${high}`
    : low !== undefined
      ? `below the minimum ${low}`
      : `above the maximum ${high}`
}

const convert = (error: ValueError): Issue[] => {
  const schema = error.schema as Schema
  const path = error.path

  switch (error.type) {
    case ValueErrorType.ObjectRequiredProperty:
      return [
        {
          path,
          code: 'REQUIRED',
          message: `${segmentsOf(path).at(-1)} is required.`,
        },
      ]
    case ValueErrorType.StringPattern:
      return [
        {
          path,
          code: 'PATTERN',
          message: `${JSON.stringify(error.value)} does not match ${schema.pattern as string}.`,
        },
      ]
    case ValueErrorType.Literal:
      return [
        {
          path,
          code: 'ENUM',
          message: `must be ${JSON.stringify(schema.const)}.`,
        },
      ]
    case ValueErrorType.Union:
      if (isLiteralUnion(schema)) {
        return [
          {
            path,
            code: 'ENUM',
            message: `${JSON.stringify(error.value)} is not one of ${(schema.anyOf as Schema[]).map((m) => JSON.stringify(m.const)).join(', ')}.`,
          },
        ]
      }

      return [
        {
          path,
          code: 'TYPE',
          message: `expected ${describeUnion(schema)}, got ${typeName(error.value)}.`,
        },
      ]
    default:
      if (rangeTypes.has(error.type)) {
        return [
          {
            path,
            code: 'RANGE',
            message: `${JSON.stringify(error.value)} is ${bound(schema)}.`,
          },
        ]
      }

      return [
        {
          path,
          code: 'TYPE',
          message: `expected ${schema.type ?? 'another type'}, got ${typeName(error.value)}.`,
        },
      ]
  }
}

const resolveAt = (root: Schema, path: string): Schema | null => {
  let schema: Schema | null = root

  for (const segment of segmentsOf(path)) {
    if (!schema) {
      return null
    }

    if (schema.anyOf) {
      return null
    }

    if (schema.properties && segment in schema.properties) {
      schema = schema.properties[segment] as Schema
    } else if (schema.patternProperties) {
      schema = Object.values(schema.patternProperties)[0] as Schema
    } else if ((schema as { items?: Schema }).items) {
      schema = (schema as { items?: Schema }).items!
    } else {
      return null
    }
  }

  return schema
}

const walk = (schema: Schema, value: unknown, prefix: string, root: Schema): Issue[] => {
  const out: Issue[] = []
  const missing = new Set<string>()

  for (const error of Value.Errors(schema, value)) {
    if (error.type === ValueErrorType.ObjectRequiredProperty) {
      missing.add(error.path)
    } else if (error.value === undefined && missing.has(error.path)) {
      continue
    }

    const absolute = {
      ...error,
      path: prefix + error.path,
    }

    if (error.type === ValueErrorType.Union && !isLiteralUnion(error.schema)) {
      const member = pickMember(error.schema, error.value)

      if (member) {
        out.push(...walk(member, error.value, absolute.path, root))
        continue
      }

      const tag =
        error.value && typeof error.value === 'object'
          ? (error.value as { type?: unknown }).type
          : undefined

      if (
        tag !== undefined &&
        (error.schema as Schema).anyOf?.some((m) => (m as Schema).properties?.type)
      ) {
        const allowed = ((error.schema as Schema).anyOf as Schema[])
          .map((m) => JSON.stringify((m.properties!.type as Schema).const))
          .join(', ')

        out.push({
          path: `${absolute.path}/type`,
          code: 'ENUM',
          message: `${JSON.stringify(tag)} is not one of ${allowed}.`,
        })
        continue
      }
    }

    if (error.type === ValueErrorType.ObjectAdditionalProperties) {
      const segments = segmentsOf(absolute.path)
      const key = segments.at(-1) ?? ''
      const parentPath = prefix + error.path.slice(0, error.path.lastIndexOf('/'))
      const schema = error.schema as Schema
      const parent: Schema = schema.patternProperties
        ? schema
        : (resolveAt(root, parentPath) ?? schema)

      if (parent.patternProperties) {
        const pattern = Object.keys(parent.patternProperties)[0]!

        out.push({
          path: absolute.path,
          code: 'PATTERN',
          message: `${JSON.stringify(key)} does not match ${pattern}.`,
        })
        continue
      }

      const known = Object.keys(parent.properties ?? {})

      if (/^\/environments\/[^/]+\/services\/[^/]+$/.test(parentPath)) {
        out.push({
          path: absolute.path,
          code: 'OVERRIDE_KEY',
          message: `${key} cannot be overridden per environment; only ${known.join(', ')} can.`,
        })
        continue
      }

      out.push({
        path: absolute.path,
        code: 'UNKNOWN_KEY',
        message: `Unknown key ${key}${suggest(key, known)}`,
      })
      continue
    }

    out.push(...convert(absolute))
  }

  return out
}

export const schemaIssues = (value: unknown): Issue[] => {
  const seen = new Set<string>()

  return walk(Manifest as Schema, value, '', Manifest as Schema).filter((issue) => {
    const id = `${issue.path}|${issue.code}`

    if (seen.has(id)) {
      return false
    }

    seen.add(id)

    return true
  })
}

export const serviceWithDefaults = (value: ServiceDoc): ServiceDoc =>
  Value.Default(Service, structuredClone(value)) as ServiceDoc

export const validateSchema = (input: unknown) => {
  const parsed = parseInput(input)

  if (parsed.issues.length) {
    return {
      value: undefined,
      issues: parsed.issues,
      locate: parsed.locate,
    }
  }

  const issues = schemaIssues(parsed.value).map((issue) =>
    parsed.locate(
      issue,
      issue.code === 'UNKNOWN_KEY' || issue.code === 'OVERRIDE_KEY' || issue.code === 'PATTERN'
        ? 'key'
        : 'value',
    ),
  )

  return {
    value: issues.length ? undefined : (parsed.value as ManifestDoc),
    issues,
    locate: parsed.locate,
  }
}
