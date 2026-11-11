import type { RouteLevel } from './tools.ts'

export type Json = Record<string, unknown>

export type Parameter = {
  name: string
  in: string
  required?: boolean
  description?: string
  schema?: Json
}

type Content = Record<string, { schema?: Json }>

export type McpFlags = { destructive?: true; always_load?: true; poll?: true }

export type CliMeta =
  false | { path?: string[]; args?: string[]; render?: string; wait?: string; exclusive?: string[] }

export type Meta = { level: RouteLevel; mcp?: false | McpFlags; cli?: CliMeta; stream?: true }

export type Operation = {
  operationId?: string
  summary?: string
  description?: string
  tags?: string[]
  parameters?: Parameter[]
  requestBody?: { required?: boolean; content?: Content }
  responses?: Record<string, { content?: Content }>
  'x-stationly'?: Meta
}

export type Tag = { name: string; description?: string }

export type OpenApiDocument = {
  paths: Record<string, Record<string, Operation>>
  components?: { schemas?: Record<string, Json> }
  tags?: Tag[]
}

export type Endpoint = {
  name: string
  method: string
  path: string
  operation: Operation
  meta: Meta
  parameters: Parameter[]
  body: Json | undefined
  components: Record<string, Json>
}

export type Route = {
  method: string
  path: string
  params: string[]
  query: string[]
  body: boolean
}

type Input = Record<string, unknown>

const methods = ['get', 'put', 'post', 'patch', 'delete']

export const componentRef = '#/components/schemas/'

export const slugPaths: Record<string, string> = {
  project: 'project',
  environment: 'project/environment',
  service: 'project/environment/service',
  sandbox: 'project/environment/sandbox',
}

const parents = ['projects', 'environments']

export const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export const resolved = (
  schema: Json | undefined,
  components: Record<string, Json>,
): Json | undefined => {
  const ref = schema?.$ref

  return typeof ref === 'string' && ref.startsWith(componentRef)
    ? components[ref.slice(componentRef.length)]
    : schema
}

export const endpoints = (document: OpenApiDocument): Endpoint[] => {
  const components = document.components?.schemas ?? {}

  return Object.entries(document.paths).flatMap(([path, item]) =>
    Object.entries(item)
      .filter(([method, operation]) => methods.includes(method) && operation['x-stationly'])
      .map(([method, operation]) => {
        const name = operation.operationId

        if (!name) {
          throw new Error(`${method.toUpperCase()} ${path} has no operationId`)
        }

        return {
          name,
          method: method.toUpperCase(),
          path,
          operation,
          meta: operation['x-stationly']!,
          parameters: (operation.parameters ?? []).filter(
            (p) => p.in === 'path' || p.in === 'query',
          ),
          body: resolved(operation.requestBody?.content?.['application/json']?.schema, components),
          components,
        }
      }),
  )
}

export const pathOf = (template: string, input: Input) =>
  template.replace(/\/([^/]+)\/\{([^}]+)\}/g, (_, collection: string, name: string) => {
    const value = String(input[name])
    const segments = slugPaths[name] ? value.split('/') : [value]

    return segments
      .map(
        (segment, i) =>
          `/${i === segments.length - 1 ? collection : (parents[i] ?? collection)}/${encodeURIComponent(segment)}`,
      )
      .join('')
  })

export const requestOf = (route: Route, input: Input) => {
  const { idempotency_key: key, ...rest } = input
  const query = new URLSearchParams()

  for (const name of route.query) {
    const value = rest[name] as string | number | boolean | undefined

    if (value !== undefined) {
      query.set(name, String(value))
    }
  }

  const body = Object.fromEntries(
    Object.entries(rest).filter(([name]) => !route.params.includes(name)),
  )
  const search = query.size ? `?${query.toString()}` : ''
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(typeof key === 'string'
      ? {
          'idempotency-key': key,
        }
      : {}),
  }
  const init: RequestInit = route.body
    ? {
        method: route.method,
        headers: {
          ...headers,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      }
    : {
        method: route.method,
        headers,
      }

  return {
    path: `${pathOf(route.path, rest)}${search}`,
    init,
  }
}
