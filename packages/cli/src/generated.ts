import { readFileSync } from 'node:fs'

import {
  Argument,
  Command,
  InvalidArgumentError,
  Option,
  type CommandUnknownOpts,
} from '@commander-js/extra-typings'

import {
  endpoints,
  isObject,
  pollParameter,
  pollTimeout,
  requestOf,
  resolved,
  type Endpoint,
  type Json,
  type OpenApiDocument,
} from '@stationly/mcp'

import { action, bytes, group, parseJson, seconds, type Program } from './command.ts'
import { Exit } from './errors.ts'
import {
  connect,
  environmentId,
  isId,
  projectId,
  projectRef,
  sandboxId,
  serviceId,
  type Globals,
  type Run,
} from './kit.ts'
import { openApiDocument } from './openapi.gen.ts'
import { human } from './output.ts'
import { need } from './prompt.ts'
import { renderer, type Renderer } from './renderers/index.ts'
import { follow, reply, replyThen, waitUntilDone } from './respond.ts'

type Scalar = 'string' | 'integer' | 'number' | 'boolean'

type Kind = { scalar: Scalar; choices?: string[] }

type Shape =
  (Kind & { fields?: never }) | { scalar?: never; choices?: never; fields: Record<string, Json> }

type Input = Record<string, unknown>

type Target = 'project' | 'environment' | 'service' | 'sandbox'

export type Generated = { endpoint: Endpoint; path: string[] }

const scalars: string[] = ['string', 'integer', 'number', 'boolean']

const plural = (word: string) =>
  word.endsWith('y')
    ? `${word.slice(0, -1)}ies`
    : /(s|x|ch|sh)$/.test(word)
      ? `${word}es`
      : `${word}s`

const singular = (word: string) =>
  word.endsWith('ies') ? `${word.slice(0, -3)}y` : word.replace(/s$/, '')

export const derivedPath = (operationId: string, tag: string) => {
  const words = operationId.split('_')
  if (words.length === 1) return words
  const nouns = tag.split('-')
  return [
    tag,
    words.filter((word) => !nouns.includes(word) && !nouns.includes(plural(word))).join('-'),
  ]
}

export const generatedCommands = (document: OpenApiDocument = openApiDocument): Generated[] =>
  endpoints(document).flatMap((endpoint) => {
    const cli = endpoint.meta.cli
    if (cli === false) return []
    const tag = endpoint.operation.tags?.[0]
    if (!cli?.path && !tag) throw new Error(`${endpoint.name} has no tag to name its command group`)
    return [
      {
        endpoint,
        path: cli?.path ?? derivedPath(endpoint.name, tag!),
      },
    ]
  })

export const endpointNamed = (name: string) => {
  const endpoint = endpoints(openApiDocument).find((e) => e.name === name)
  if (!endpoint) throw new Error(`The OpenAPI document sly embeds has no operation ${name}`)
  return endpoint
}

const scalarOf = (schema: Json | undefined, components: Record<string, Json>): Kind | null => {
  const s = resolved(schema, components)
  if (!s) return null
  if (Array.isArray(s.enum))
    return {
      scalar: 'string',
      choices: s.enum.map(String),
    }
  if (typeof s.const === 'string')
    return {
      scalar: 'string',
      choices: [s.const],
    }
  const branches = (s.anyOf ?? s.oneOf) as Json[] | undefined
  if (branches) {
    const kinds = branches
      .filter((branch) => branch.type !== 'null')
      .map((branch) => scalarOf(branch, components))
    if (kinds.some((kind) => kind === null)) return null
    const known = kinds as Kind[]
    if (known.every((kind) => kind.choices))
      return {
        scalar: 'string',
        choices: known.flatMap((kind) => kind.choices!),
      }
    const typed = [...new Set(known.map((kind) => kind.scalar))].filter((t) => t !== 'string')
    if (typed.length > 1) return null
    return {
      scalar: typed[0] ?? 'string',
    }
  }
  const types = (Array.isArray(s.type) ? s.type : [s.type]).filter((t) => t !== 'null')
  return types.length === 1 && scalars.includes(String(types[0]))
    ? {
        scalar: types[0] as Scalar,
      }
    : null
}

const fieldsOf = (
  schema: Json | undefined,
  components: Record<string, Json>,
): Record<string, Json> | null => {
  const s = resolved(schema, components)
  if (!s) return null
  const branches = (s.anyOf ?? s.oneOf) as Json[] | undefined
  if (branches) {
    const objects = branches
      .filter((branch) => resolved(branch, components)?.type !== 'null')
      .map((branch) => fieldsOf(branch, components))
    if (!objects.length || !objects.every(Boolean)) return null
    const merged: Record<string, Json[]> = {}
    for (const object of objects as Record<string, Json>[])
      for (const [key, field] of Object.entries(object)) (merged[key] ??= []).push(field)
    return Object.fromEntries(
      Object.entries(merged).map(([key, fields]) => [
        key,
        fields.length === 1
          ? fields[0]!
          : {
              anyOf: fields,
            },
      ]),
    )
  }
  return s.type === 'object' || isObject(s.properties)
    ? ((s.properties ?? {}) as Record<string, Json>)
    : null
}

const shapeOf = (schema: Json | undefined, components: Record<string, Json>): Shape | null => {
  const kind = scalarOf(schema, components)
  if (kind) return kind
  const fields = fieldsOf(schema, components)
  return fields
    ? {
        fields,
      }
    : null
}

const listOf = (schema: Json | undefined, components: Record<string, Json>) => {
  const s = resolved(schema, components)
  const types: unknown[] = Array.isArray(s?.type) ? s.type : [s?.type]
  return types.includes('array') && isObject(s?.items) ? s.items : null
}

const invalid = (value: string, what: string) =>
  new InvalidArgumentError(`${value} is not ${what}.`)

const asArgument =
  <T>(parse: (value: string) => T) =>
  (value: string) => {
    try {
      return parse(value)
    } catch (error) {
      if (error instanceof Exit) throw new InvalidArgumentError(error.message)
      throw error
    }
  }

type Unit = { placeholder: string; hint: string; parse: (value: string) => number }

const units: [RegExp, Unit][] = [
  [
    /_bytes$/,
    {
      placeholder: 'size',
      hint: 'bytes, or a size such as 512MiB or 8GiB',
      parse: asArgument(bytes),
    },
  ],
  [
    /(^|_)(s|seconds)$/,
    {
      placeholder: 'duration',
      hint: 'seconds, or a duration such as 90s, 10m or 24h',
      parse: asArgument(seconds),
    },
  ],
]

const unitOf = (property: string, kind: Kind) =>
  kind.scalar === 'integer' ? units.find(([pattern]) => pattern.test(property))?.[1] : undefined

const parserOf = (property: string, kind: Kind) => {
  const unit = unitOf(property, kind)
  return (value: string): unknown => {
    if (kind.choices && !kind.choices.includes(value))
      throw invalid(value, `one of ${kind.choices.join(', ')}`)
    if (kind.scalar === 'string') return value
    if (kind.scalar === 'boolean') {
      if (value !== 'true' && value !== 'false') throw invalid(value, 'true or false')
      return value === 'true'
    }
    if (unit) return unit.parse(value)
    const n = Number(value)
    if (value.trim() === '' || !Number.isFinite(n)) throw invalid(value, 'a number')
    if (kind.scalar === 'integer' && !Number.isInteger(n)) throw invalid(value, 'an integer')
    return n
  }
}

const jsonOf = (value: string, flag: string) => {
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new InvalidArgumentError(`${flag} is not valid JSON.`)
  }
}

const shorthandOf =
  (flag: string, fields: Record<string, Json>, components: Record<string, Json>) =>
  (value: string) => {
    if (/^\s*[[{]/.test(value)) return jsonOf(value, flag)
    return Object.fromEntries(
      value.split(',').map((pair) => {
        const at = pair.indexOf('=')
        if (at < 1) throw invalid(pair, 'key=value')
        const key = pair.slice(0, at)
        const kind = scalarOf(fields[key], components)
        const raw = pair.slice(at + 1)
        return [key, kind ? parserOf(key, kind)(raw) : raw]
      }),
    )
  }

type Binding = { attribute: string; property: string }

type Field = { property: string; where: string; schema: Json | undefined; required: boolean }

const optionsOf = (
  { property, where, schema, required }: Field,
  components: Record<string, Json>,
): Option[] => {
  const item = listOf(schema, components)
  const shape = shapeOf(item ?? schema, components)
  if (!shape || (item && shape.scalar === 'boolean')) return []
  const flag = `--${property.replaceAll('_', '-')}`
  const unit = shape.scalar ? unitOf(property, shape) : undefined
  const description = [
    typeof schema?.description === 'string' ? schema.description : `${where} ${property}`,
    ...(unit ? [unit.hint] : []),
    ...(shape.fields ? ['key=value pairs separated by commas, or JSON'] : []),
    ...(item ? ['repeatable'] : []),
    ...(required ? ['required'] : []),
  ].join('; ')
  if (shape.scalar === 'boolean')
    return [
      new Option(flag, description),
      new Option(`--no-${flag.slice(2)}`, `send ${property} false`),
    ]
  const placeholder = shape.fields
    ? 'key=value,...'
    : shape.choices
      ? 'choice'
      : (unit?.placeholder ?? shape.scalar)
  const option = new Option(`${flag} <${placeholder}>`, description)
  if (shape.choices) option.choices(shape.choices)
  const parse = shape.fields
    ? shorthandOf(flag, shape.fields, components)
    : parserOf(property, shape)
  return [
    item
      ? option.argParser((value: string, previous: unknown) => [
          ...((previous as unknown[] | undefined) ?? []),
          parse(value),
        ])
      : option.argParser(parse),
  ]
}

const selected = (run: Run, target: 'service' | 'sandbox') =>
  need(run.selection[target], {
    what: target === 'service' ? 'Service' : 'Sandbox',
    flag: `--${target} <id or name>`,
  })

const scoped = async (run: Run, entity: 'service' | 'sandbox', ref: string) =>
  isId(entity, ref)
    ? ref
    : [await projectRef(run), run.selection.environment ?? (await environmentId(run)), ref].join(
        '/',
      )

const paths: Record<Target, (run: Run) => Promise<string>> = {
  project: projectRef,
  environment: async (run) => {
    const ref = run.selection.environment
    return ref === undefined || isId('environment', ref)
      ? environmentId(run, ref)
      : `${await projectRef(run)}/${ref}`
  },
  service: async (run) => scoped(run, 'service', await selected(run, 'service')),
  sandbox: async (run) => scoped(run, 'sandbox', await selected(run, 'sandbox')),
}

const ids: Record<Target, (run: Run) => Promise<string>> = {
  project: async (run) => {
    const ref = await projectRef(run)
    return isId('project', ref) ? ref : projectId(run, ref)
  },
  environment: (run) => environmentId(run),
  service: serviceId,
  sandbox: async (run) => sandboxId(run, await selected(run, 'sandbox')),
}

export const targetId = (run: Run, target: Target) => ids[target](run)

const isTarget = (name: string): name is Target => name in paths

const successSchema = ({ operation, components }: Endpoint) =>
  resolved(
    Object.entries(operation.responses ?? {}).find(([status]) => status.startsWith('2'))?.[1]
      .content?.['application/json']?.schema,
    components,
  )

export const summaryColumns = (endpoint: Endpoint) => {
  const items = (successSchema(endpoint)?.properties as Json | undefined)?.items
  if (!isObject(items) || !isObject(items.items)) return undefined
  const entity = resolved(items.items, endpoint.components)
  const properties = (entity?.properties ?? {}) as Record<string, Json>
  return ((entity?.required as string[] | undefined) ?? []).filter(
    (name) => scalarOf(properties[name], endpoint.components) !== null,
  )
}

const cliOf = (endpoint: Endpoint) => endpoint.meta.cli || {}

export const renderOf = (endpoint: Endpoint): Renderer => {
  const name = cliOf(endpoint).render
  if (name) {
    const registered = renderer(name)
    if (!registered)
      throw new Error(`${endpoint.name} renders with ${name}, which is not registered`)
    return registered
  }
  const columns = summaryColumns(endpoint)
  return {
    text: (data) => human(data, columns),
  }
}

export const waitedBy = (endpoint: Endpoint) => {
  const name = cliOf(endpoint).wait
  if (!name) return null
  const waited = endpointNamed(name)
  const wait = pollParameter(waited)
  if (!wait || !waited.parameters.some((p) => p.in === 'path' && p.name === 'id'))
    throw new Error(`${endpoint.name} waits with ${name}, which does not poll one entity by id`)
  return {
    endpoint: waited,
    wait,
  }
}

const routeOf = ({ method, path, parameters, operation }: Endpoint) => ({
  method,
  path,
  params: parameters.map((p) => p.name),
  query: parameters.filter((p) => p.in === 'query').map((p) => p.name),
  body: operation.requestBody !== undefined,
})

const sender = (run: Run, endpoint: Endpoint) => {
  const route = routeOf(endpoint)
  return (input: Input, headers: Record<string, string> = {}) => {
    const request = requestOf(route, input)
    return run.request(request.path, {
      ...request.init,
      headers: {
        ...(request.init.headers as Record<string, string>),
        ...headers,
      },
    })
  }
}

export type Flow = { wait?: true; timeout?: number; follow?: true }

export const runOperation = async (
  globals: Globals,
  run: Run,
  endpoint: Endpoint,
  input: Input,
  { wait, timeout, follow: following }: Flow = {},
) => {
  const send = sender(run, endpoint)
  const render = renderOf(endpoint)
  const limit =
    timeout === undefined
      ? {}
      : {
          timeout_s: timeout,
        }
  const polled = pollParameter(endpoint)
  if (polled && wait)
    return waitUntilDone(
      globals,
      {
        label: typeof input.id === 'string' ? input.id : endpoint.name,
        wait: polled,
        input: {
          ...input,
          ...limit,
        },
      },
      send,
      render,
    )
  const waited = wait ? waitedBy(endpoint) : null
  if (waited)
    return replyThen(globals, await send(input), render, (data) =>
      waitUntilDone(
        globals,
        {
          label: typeof data.id === 'string' ? data.id : waited.endpoint.name,
          wait: waited.wait,
          input: {
            id: data.id,
            ...limit,
          },
        },
        sender(run, waited.endpoint),
        renderOf(waited.endpoint),
      ),
    )
  if (following) return follow(globals, (headers) => send(input, headers), render)
  return reply(globals, await send(input), render)
}

export const waitOptions = (command: CommandUnknownOpts, endpoint: Endpoint) => {
  const wait = pollParameter(endpoint)
  const then = cliOf(endpoint).wait
  if (wait || then)
    command
      .option(
        '--wait',
        then ? `then repeat ${then} until done is true` : 'repeat the call until done is true',
      )
      .option(
        '--timeout <duration>',
        `how long --wait waits, such as 90s or 10m (default ${pollTimeout.default} s, at most ${pollTimeout.max} s)`,
        asArgument(seconds),
      )
  return wait
}

const flowsOf = (command: Command, endpoint: Endpoint) => {
  const wait = waitOptions(command, endpoint)
  const follow = endpoint.meta.stream === true
  if (follow) command.option('-f, --follow', 'follow the event stream until it ends')
  return {
    wait,
    follow,
  }
}

const extraBody = (value: unknown) =>
  typeof value === 'string'
    ? parseJson(value.startsWith('@') ? readFileSync(value.slice(1), 'utf8') : value, '--body')
    : {}

const describedParameter = (path: string, name: string) => {
  const collection = /\/([^/]+)\/\{([^}]+)\}/g
  for (const [, segment, parameter] of path.matchAll(collection))
    if (parameter === name)
      return name === 'id'
        ? `${singular(segment!).replaceAll('-', ' ')} id`
        : `${name.replaceAll('_', ' ')} id or name`
  return name.replaceAll('_', ' ')
}

const fieldsOfEndpoint = ({ parameters, body, operation }: Endpoint): Field[] => {
  const required = (body?.required as string[] | undefined) ?? []
  return [
    ...parameters
      .filter((p) => p.in === 'query')
      .map((p) => ({
        property: p.name,
        where: 'query parameter',
        schema: {
          ...p.schema,
          ...(p.description
            ? {
                description: p.description,
              }
            : {}),
        },
        required: p.required === true,
      })),
    ...Object.entries((body?.properties as Record<string, Json> | undefined) ?? {}).map(
      ([property, schema]) => ({
        property,
        where: 'body field',
        schema,
        required: operation.requestBody?.required !== false && required.includes(property),
      }),
    ),
  ]
}

const commandOf = (word: string, { endpoint }: Generated, reserved: Set<string>) => {
  const { name, path, operation, parameters, components } = endpoint
  const cli = cliOf(endpoint)
  const summary = operation.summary ?? name
  const pathParameters = parameters.filter((p) => p.in === 'path')
  const contextual = pathParameters.map((p) => p.name).filter(isTarget)
  const command = new Command(word)
    .summary(summary)
    .description(
      contextual.length
        ? `${summary}\n\nTarget: ${contextual.map((t) => `--${t} <id or name>`).join(', ')}. Names resolve within --project and --environment, with defaults from .stationly/context.json.`
        : summary,
    )
  const fields = fieldsOfEndpoint(endpoint)
  const args = cli.args ?? pathParameters.map((p) => p.name).filter((n) => !isTarget(n))
  for (const arg of args) {
    const field = fields.find((f) => f.property === arg)
    const kind = field ? scalarOf(field.schema, components) : null
    const required = !field || field.required
    const argument = new Argument(
      required ? `<${arg}>` : `[${arg}]`,
      typeof field?.schema?.description === 'string'
        ? field.schema.description
        : describedParameter(path, arg),
    )
    if (kind) argument.argParser(parserOf(arg, kind))
    command.addArgument(argument)
  }
  const flows = flowsOf(command, endpoint)
  const bindings: Binding[] = []
  const fromGlobals: Target[] = []
  for (const field of fields) {
    const { property } = field
    if (isTarget(property)) {
      fromGlobals.push(property)
      continue
    }
    if (property === flows.wait || args.includes(property)) continue
    if (flows.follow && property === 'follow') {
      bindings.push({
        attribute: property,
        property,
      })
      continue
    }
    for (const option of optionsOf(field, components)) {
      if (reserved.has(option.attributeName())) continue
      command.addOption(option)
      if (!option.negate)
        bindings.push({
          attribute: option.attributeName(),
          property,
        })
    }
  }
  if (operation.requestBody !== undefined)
    command.option('--body <json>', 'other fields of the request body as a JSON object, or @file')
  const exclusive = cli.exclusive ?? []
  command.action(
    action<unknown[], Record<string, unknown>, Globals>(async (options, ...positional) => {
      const run = await connect(options)
      const input: Input = {
        ...extraBody(options.body),
      }
      for (const { attribute, property } of bindings)
        if (options[attribute] !== undefined) input[property] = options[attribute]
      args.forEach((arg, i) => {
        if (positional[i] !== undefined) input[arg] = positional[i]
      })
      const chosen = exclusive.some((n) => !isTarget(n) && input[n] !== undefined)
      for (const target of fromGlobals) {
        if (input[target] !== undefined || run.selection[target] === undefined) continue
        if (chosen && exclusive.includes(target)) continue
        input[target] = await ids[target](run)
      }
      for (const target of contextual) input[target] = await paths[target](run)
      return runOperation(options, run, endpoint, input, options as Flow)
    }),
  )
  return command
}

const childOf = (parent: CommandUnknownOpts, name: string) =>
  parent.commands.find((c) => c.name() === name)

const parentOf = (program: Program, words: string[]) =>
  words.reduce<CommandUnknownOpts | null>((parent, word) => {
    const child = parent && childOf(parent, word)
    if (child && !child.commands.length) return null
    return parent && group(parent, word)
  }, program)

export const registerGenerated = (program: Program) => {
  const reserved = new Set(program.options.map((o) => o.attributeName()))
  reserved.add('body')
  const clashes: string[] = []
  for (const generated of generatedCommands()) {
    const words = generated.path
    const parent = parentOf(program, words.slice(0, -1))
    const leaf = words.at(-1)!
    if (!parent || childOf(parent, leaf)) {
      clashes.push(`sly ${words.join(' ')} (${generated.endpoint.name})`)
      continue
    }
    parent.addCommand(commandOf(leaf, generated, reserved))
  }
  if (clashes.length)
    throw new Error(
      `${clashes.join(', ')} clash with hand-written commands; give the routes cli: false or another cli.path`,
    )
}
