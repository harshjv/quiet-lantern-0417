import type { JsonSchemaType, ToolAnnotations } from '@modelcontextprotocol/server'

import { pollTimeout } from './invoke.ts'
import {
  componentRef,
  endpoints,
  isObject,
  slugPaths,
  type Endpoint,
  type Json,
  type McpFlags,
  type OpenApiDocument,
} from './operations.ts'
import { jsonSchema } from './schema.ts'
import type { ToolDef } from './tools.ts'

const waitParameters = ['wait_s', 'timeout_s']

const idempotencyKey = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  description:
    'Repeat a mutation safely: the same key and input return the stored result for 24 hours',
}

const timeout = {
  type: 'integer',
  minimum: 0,
  maximum: pollTimeout.max,
  default: pollTimeout.default,
  description: 'How long to keep repeating the call until done is true, in seconds',
}

const local = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(local)
  }

  if (!isObject(value)) {
    return value
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, item]) =>
          !(key === '$id' && typeof item === 'string' && item.startsWith(componentRef)),
      )
      .map(([key, item]) => [
        key,
        key === '$ref' && typeof item === 'string'
          ? item.replace(componentRef, '#/$defs/')
          : local(item),
      ]),
  )
}

const withDefinitions = (schema: Json, components: Record<string, Json>): JsonSchemaType => {
  const names = new Set<string>()
  const visit = (value: unknown) => {
    if (Array.isArray(value)) {
      return value.forEach(visit)
    }

    if (!isObject(value)) {
      return
    }

    const ref = value.$ref

    if (typeof ref === 'string' && ref.startsWith(componentRef)) {
      const name = ref.slice(componentRef.length)

      if (names.has(name)) {
        return
      }

      if (!components[name]) {
        throw new Error(`${ref} is not a component of the OpenAPI document`)
      }

      names.add(name)
      visit(components[name])
    }

    Object.values(value).forEach(visit)
  }

  visit(schema)
  const definitions = Object.fromEntries([...names].map((name) => [name, local(components[name])]))

  return {
    ...(local(schema) as Json),
    ...(names.size
      ? {
          $defs: definitions,
        }
      : {}),
  } as JsonSchemaType
}

const annotationsOf = (method: string, title: string, flags: McpFlags): ToolAnnotations =>
  method === 'GET'
    ? {
        title,
        readOnlyHint: true,
        openWorldHint: false,
      }
    : {
        title,
        readOnlyHint: false,
        destructiveHint: method === 'DELETE' || flags.destructive === true,
        idempotentHint: true,
        openWorldHint: false,
      }

export const pollParameter = ({ name, meta, parameters }: Endpoint) => {
  if (!(meta.mcp || {}).poll) {
    return null
  }

  const wait = parameters.find((p) => p.in === 'query' && waitParameters.includes(p.name))?.name

  if (!wait) {
    throw new Error(`${name} polls but its route takes none of ${waitParameters.join(', ')}`)
  }

  return wait
}

const toolOf = (endpoint: Endpoint): ToolDef => {
  const { name, method, path, operation, meta, parameters, body, components } = endpoint
  const flags = meta.mcp || {}
  const poll = pollParameter(endpoint)
  const properties: Json = {}
  const required: string[] = []
  const claim = (key: string, schema: unknown, needed: boolean) => {
    if (key in properties) {
      throw new Error(`${name}: the input property ${key} is declared twice`)
    }

    properties[key] = schema

    if (needed) {
      required.push(key)
    }
  }

  for (const parameter of parameters) {
    if (parameter.name === poll) {
      continue
    }

    const description =
      parameter.description ??
      (parameter.in === 'path' && slugPaths[parameter.name]
        ? `An id, or the names ${slugPaths[parameter.name]}`
        : undefined)

    claim(
      parameter.name,
      {
        ...parameter.schema,
        ...(description
          ? {
              description,
            }
          : {}),
      },
      parameter.in === 'path' || parameter.required === true,
    )
  }

  for (const [key, schema] of Object.entries((body?.properties as Json | undefined) ?? {})) {
    claim(
      key,
      schema,
      operation.requestBody?.required !== false &&
        ((body?.required as string[] | undefined) ?? []).includes(key),
    )
  }

  if (method !== 'GET') {
    claim('idempotency_key', idempotencyKey, false)
  }

  if (poll) {
    claim('timeout_s', timeout, false)
  }

  const open =
    body &&
    (body.patternProperties ||
      (body.additionalProperties !== undefined && body.additionalProperties !== false))
  const input = {
    type: 'object',
    properties,
    ...(required.length
      ? {
          required,
        }
      : {}),
    ...(open
      ? {
          patternProperties: body.patternProperties,
          additionalProperties: body.additionalProperties ?? true,
        }
      : {
          additionalProperties: false,
        }),
  }
  const successes = Object.entries(operation.responses ?? {})
    .filter(([status]) => status.startsWith('2'))
    .map(([, response]) => response.content?.['application/json']?.schema)
    .filter((schema): schema is Json => schema !== undefined)
  const output =
    successes.length === 0
      ? undefined
      : successes.length === 1
        ? successes[0]!
        : {
            anyOf: successes,
          }
  const title = operation.summary ?? name

  return {
    name,
    title,
    description: operation.description ?? title,
    method,
    path,
    level: meta.level,
    params: parameters.map((p) => p.name),
    query: parameters.filter((p) => p.in === 'query').map((p) => p.name),
    body: operation.requestBody !== undefined,
    poll,
    alwaysLoad: flags.always_load === true,
    annotations: annotationsOf(method, title, flags),
    inputSchema: jsonSchema(withDefinitions(input, components)),
    outputSchema: output ? jsonSchema(withDefinitions(output, components)) : undefined,
  }
}

export const generateTools = (document: OpenApiDocument): ToolDef[] =>
  endpoints(document)
    .filter((endpoint) => endpoint.meta.mcp !== false)
    .map(toolOf)
