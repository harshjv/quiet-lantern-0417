import { Kind, type TSchema } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'

type Json = Record<string, any>

const kindOf = (node: Json) => {
  if (node.anyOf) return 'Union'
  if (node.allOf) return 'Intersect'
  if ('const' in node) return 'Literal'
  if (node.patternProperties) return 'Record'
  if (Array.isArray(node.enum)) return 'Union'
  switch (node.type) {
    case 'object':
      return 'Object'
    case 'array':
      return 'Array'
    case 'string':
      return 'String'
    case 'number':
      return 'Number'
    case 'integer':
      return 'Integer'
    case 'boolean':
      return 'Boolean'
    case 'null':
      return 'Null'
    default:
      return 'Any'
  }
}

const inline = (node: unknown, components: Json, seen: string[]): unknown => {
  if (Array.isArray(node)) return node.map((item) => inline(item, components, seen))
  if (node === null || typeof node !== 'object') return node
  const source = node as Json
  if (typeof source.$ref === 'string') {
    const name = source.$ref.replace('#/components/schemas/', '')
    if (seen.includes(name)) throw new Error(`recursive schema ${name}`)
    return inline(components[name], components, [...seen, name])
  }
  const out: Json = {}
  for (const [key, value] of Object.entries(source))
    out[key] =
      key === 'properties' || key === 'patternProperties'
        ? Object.fromEntries(
            Object.entries(value as Json).map(([k, v]) => [k, inline(v, components, seen)]),
          )
        : inline(value, components, seen)
  return out
}

const brand = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(brand)
  if (node === null || typeof node !== 'object') return node
  const source = node as Json
  if (Array.isArray(source.type)) {
    const { type, ...rest } = source
    return brand({
      anyOf: (type as string[]).map((t) =>
        t === 'null'
          ? {
              type: 'null',
            }
          : {
              ...rest,
              type: t,
            },
      ),
    })
  }
  const out: Json = {}
  for (const [key, value] of Object.entries(source)) {
    if (key === 'properties' || key === 'patternProperties')
      out[key] = Object.fromEntries(Object.entries(value as Json).map(([k, v]) => [k, brand(v)]))
    else if (key === 'required' || key === 'enum' || key === 'type') out[key] = value
    else out[key] = brand(value)
  }
  if (Array.isArray(source.enum) && !source.anyOf) {
    out.anyOf = source.enum.map((v) => ({
      [Kind]: 'Literal',
      const: v,
      type: typeof v,
    }))
    delete out.enum
  }
  ;(out as Record<symbol, unknown>)[Kind] = kindOf(out)
  return out
}

export const compileResponse = (schema: unknown, components: Json) => {
  const flat = brand(inline(schema, components, [])) as TSchema
  return {
    check: (value: unknown) => Value.Check(flat, value),
    errors: (value: unknown) =>
      [...Value.Errors(flat, value)].slice(0, 5).map((e) => `${e.path}: ${e.message}`),
  }
}
