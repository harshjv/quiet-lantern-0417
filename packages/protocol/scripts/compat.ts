import { isDeepStrictEqual } from 'node:util'

type Node = { [key: string]: unknown }
type Schema = Node | boolean

type MessageEntry = { from: string; body: string; capability: string | null; outboxed: boolean }
type ErrorEntry = { code: string; http: number | null; area: string; close: number | null }

export type Snapshot = {
  protocol: { $defs: Record<string, Node> }
  messages: Record<string, MessageEntry>
  errors: { errors: ErrorEntry[]; warnings: string[] }
}

export type Break = { at: string; change: string }

const refPrefix = '#/$defs/'
const defPath = (name: string) => `protocol.json${refPrefix}${name}`

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const show = (value: unknown) => JSON.stringify(value)

const refName = (schema: Node) =>
  typeof schema.$ref === 'string' ? schema.$ref.slice(refPrefix.length) : undefined

const typesOf = (schema: Node) =>
  schema.type === undefined
    ? undefined
    : Array.isArray(schema.type)
      ? (schema.type as string[])
      : [schema.type as string]

const valuesOf = (schema: Node) =>
  schema.const !== undefined
    ? [schema.const]
    : Array.isArray(schema.enum)
      ? (schema.enum as unknown[])
      : undefined

const lowerBounds = ['minimum', 'exclusiveMinimum', 'minLength', 'minItems', 'minProperties']
const upperBounds = ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems', 'maxProperties']
const exactMatches = ['pattern', 'format']

const typeAccepts = (types: string[], type: string) =>
  types.includes(type) || (type === 'integer' && types.includes('number'))

const keywordBreaks = (base: Node, head: Node): string[] => {
  const baseTypes = typesOf(base)
  const headTypes = typesOf(head)
  const baseValues = valuesOf(base)
  const headValues = valuesOf(head)

  return [
    ...(headTypes === undefined
      ? []
      : baseTypes === undefined
        ? [`type narrowed to ${show(head.type)}`]
        : baseTypes
            .filter((type) => !typeAccepts(headTypes, type))
            .map((type) => `type ${type} is no longer accepted`)),
    ...(headValues === undefined
      ? []
      : base.const !== undefined &&
          head.const !== undefined &&
          !isDeepStrictEqual(base.const, head.const)
        ? [`const changed from ${show(base.const)} to ${show(head.const)}`]
        : baseValues === undefined
          ? [`restricted to ${show(headValues)}`]
          : baseValues
              .filter((value) => !headValues.some((v) => isDeepStrictEqual(v, value)))
              .map((value) => `value ${show(value)} is no longer accepted`)),
    ...lowerBounds.flatMap((key) =>
      typeof head[key] === 'number' && !((base[key] as number) >= head[key])
        ? [`${key} raised from ${show(base[key])} to ${head[key]}`]
        : [],
    ),
    ...upperBounds.flatMap((key) =>
      typeof head[key] === 'number' && !((base[key] as number) <= head[key])
        ? [`${key} lowered from ${show(base[key])} to ${head[key]}`]
        : [],
    ),
    ...exactMatches.flatMap((key) =>
      head[key] !== undefined && head[key] !== base[key]
        ? [`${key} changed from ${show(base[key])} to ${show(head[key])}`]
        : [],
    ),
  ]
}

export const schemaBreaks = (
  baseDefs: Record<string, Node>,
  headDefs: Record<string, Node>,
  base: Node,
  head: Node,
  at: string,
) => {
  const memo = new Map<string, Break[]>()

  const diffRef = (base: Node, head: Node, at: string): Break[] => {
    const baseRef = refName(base)
    const headRef = refName(head)
    const baseNode = baseRef === undefined ? base : baseDefs[baseRef]!
    const headNode = headRef === undefined ? head : headDefs[headRef]!
    const nodeAt = baseRef === undefined ? at : defPath(baseRef)

    if (baseRef === undefined || headRef === undefined) {
      return diff(baseNode, headNode, nodeAt)
    }

    const key = `${baseRef}>${headRef}`
    const cached = memo.get(key)

    if (cached) {
      return cached
    }

    memo.set(key, [])
    const result = diff(baseNode, headNode, nodeAt)

    memo.set(key, result)

    return result
  }

  const diffSchema = (base: Schema, head: Schema, at: string): Break[] =>
    base === false || head === true
      ? []
      : head === false
        ? [
            {
              at,
              change: 'no longer accepts any value',
            },
          ]
        : base === true
          ? [
              {
                at,
                change: 'narrowed from any value',
              },
            ]
          : diffRef(base, head, at)

  const diff = (base: Node, head: Node, at: string): Break[] => {
    const baseMembers = Array.isArray(base.anyOf) ? (base.anyOf as Node[]) : undefined
    const headMembers = Array.isArray(head.anyOf) ? (head.anyOf as Node[]) : undefined

    if (baseMembers || headMembers) {
      return (baseMembers ?? [base]).flatMap((member, index) => {
        const memberAt = baseMembers ? `${at}/anyOf/${index}` : at
        const candidates = (headMembers ?? [head]).map((h) => diffRef(member, h, memberAt))

        return candidates.reduce((best, next) => (next.length < best.length ? next : best))
      })
    }

    const baseProperties = (isNode(base.properties) ? base.properties : {}) as Record<string, Node>
    const headProperties = (isNode(head.properties) ? head.properties : {}) as Record<string, Node>
    const baseRequired = new Set((base.required as string[] | undefined) ?? [])
    const baseAdditional = (base.additionalProperties ?? true) as Schema
    const headAdditional = (head.additionalProperties ?? true) as Schema

    return [
      ...keywordBreaks(base, head).map((change) => ({
        at,
        change,
      })),
      ...Object.entries(baseProperties).flatMap(([name, schema]) => {
        const next = headProperties[name]

        return next
          ? diffRef(schema, next, `${at}/properties/${name}`)
          : [
              {
                at: `${at}/properties/${name}`,
                change: 'property removed',
              },
            ]
      }),
      ...((head.required as string[] | undefined) ?? [])
        .filter((name) => !baseRequired.has(name))
        .map((name) => ({
          at: `${at}/properties/${name}`,
          change: 'property became required',
        })),
      ...diffSchema(baseAdditional, headAdditional, `${at}/additionalProperties`),
      ...(isNode(head.items)
        ? isNode(base.items)
          ? diffRef(base.items, head.items, `${at}/items`)
          : [
              {
                at: `${at}/items`,
                change: 'items narrowed',
              },
            ]
        : []),
    ]
  }

  return diffRef(base, head, at)
}

const referencedDefs = (defs: Record<string, Node>) =>
  new Set(
    [...JSON.stringify(defs).matchAll(/"\$ref":"#\/\$defs\/([^"]+)"/g)].map((match) => match[1]!),
  )

export const breakingChanges = (base: Snapshot, head: Snapshot): Break[] => {
  const baseDefs = base.protocol.$defs
  const headDefs = head.protocol.$defs
  const ref = (name: string) => ({
    $ref: `${refPrefix}${name}`,
  })
  const referenced = referencedDefs(baseDefs)
  const bodies = new Set(Object.values(base.messages).map((entry) => entry.body))
  const headErrors = new Map(head.errors.errors.map((entry) => [entry.code, entry]))

  const breaks = [
    ...Object.entries(base.messages).flatMap(([type, entry]): Break[] => {
      const at = `messages.json#/${type}`
      const next = head.messages[type]

      if (!next) {
        return [
          {
            at,
            change: 'message type removed',
          },
        ]
      }

      return [
        ...(['from', 'capability', 'outboxed'] as const)
          .filter((key) => entry[key] !== next[key])
          .map((key) => ({
            at: `${at}/${key}`,
            change: `changed from ${show(entry[key])} to ${show(next[key])}`,
          })),
        ...schemaBreaks(baseDefs, headDefs, ref(entry.body), ref(next.body), at),
      ]
    }),
    ...Object.keys(baseDefs)
      .filter((name) => !referenced.has(name) && !bodies.has(name))
      .flatMap((name) =>
        headDefs[name]
          ? schemaBreaks(baseDefs, headDefs, ref(name), ref(name), defPath(name))
          : [
              {
                at: defPath(name),
                change: 'root schema removed',
              },
            ],
      ),
    ...base.errors.errors.flatMap((entry): Break[] => {
      const at = `errors.json#/errors/${entry.code}`
      const next = headErrors.get(entry.code)

      if (!next) {
        return [
          {
            at,
            change: 'error code removed',
          },
        ]
      }

      return (['http', 'area', 'close'] as const)
        .filter((key) => entry[key] !== next[key])
        .map((key) => ({
          at: `${at}/${key}`,
          change: `changed from ${show(entry[key])} to ${show(next[key])}`,
        }))
    }),
    ...base.errors.warnings
      .filter((code) => !head.errors.warnings.includes(code))
      .map((code) => ({
        at: `errors.json#/warnings/${code}`,
        change: 'warning code removed',
      })),
  ]

  const seen = new Set<string>()

  return breaks.filter((item) => {
    const key = `${item.at} ${item.change}`

    if (seen.has(key)) {
      return false
    }

    seen.add(key)

    return true
  })
}
