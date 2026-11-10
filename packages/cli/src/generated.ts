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

import { action, parseJson, seconds, type Program } from './command.ts'
import { connect, environmentId, isId, projectRef, type Globals, type Run } from './kit.ts'
import { openApiDocument } from './openapi.gen.ts'
import { human } from './output.ts'
import { need } from './prompt.ts'
import { renderer, type Render } from './renderers/index.ts'
import { follow, reply, waitUntilDone } from './respond.ts'

type Scalar = 'string' | 'integer' | 'number' | 'boolean'

type Kind = { scalar: Scalar; choices?: string[]; many: boolean }

type Target = 'project' | 'environment' | 'service' | 'sandbox'

export type Generated = { endpoint: Endpoint; path: string[] }

const scalars: string[] = ['string', 'integer', 'number', 'boolean']

const plural = (word: string) =>
  word.endsWith('y')
    ? `${word.slice(0, -1)}ies`
    : /(s|x|ch|sh)$/.test(word)
      ? `${word}es`
      : `${word}s`

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

const scalarOf = (
  schema: Json | undefined,
  components: Record<string, Json>,
): Omit<Kind, 'many'> | null => {
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
    const known = kinds as Omit<Kind, 'many'>[]
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

const kindOf = (schema: Json | undefined, components: Record<string, Json>): Kind | null => {
  const s = resolved(schema, components)
  const types: unknown[] = Array.isArray(s?.type) ? s.type : [s?.type]
  if (types.includes('array')) {
    const item = isObject(s?.items) ? scalarOf(s.items, components) : null
    return item && item.scalar !== 'boolean'
      ? {
          ...item,
          many: true,
        }
      : null
  }
  const one = scalarOf(s, components)
  return one
    ? {
        ...one,
        many: false,
      }
    : null
}

const invalid = (value: string, what: string) =>
  new InvalidArgumentError(`${value} is not ${what}.`)

const parserOf = (kind: Kind) => (value: string) => {
  if (kind.choices && !kind.choices.includes(value))
    throw invalid(value, `one of ${kind.choices.join(', ')}`)
  if (kind.scalar === 'string') return value
  const n = Number(value)
  if (value.trim() === '' || !Number.isFinite(n)) throw invalid(value, 'a number')
  if (kind.scalar === 'integer' && !Number.isInteger(n)) throw invalid(value, 'an integer')
  return n
}

type Binding = { attribute: string; property: string }

const optionsOf = (
  property: string,
  where: string,
  schema: Json | undefined,
  components: Record<string, Json>,
  required: boolean,
): Option[] => {
  const kind = kindOf(schema, components)
  if (!kind) return []
  const flag = `--${property.replaceAll('_', '-')}`
  const description = [
    typeof schema?.description === 'string' ? schema.description : `${where} ${property}`,
    ...(kind.many ? ['repeatable'] : []),
    ...(required ? ['required'] : []),
  ].join('; ')
  if (kind.scalar === 'boolean')
    return [
      new Option(flag, description),
      new Option(`--no-${flag.slice(2)}`, `send ${property} false`),
    ]
  const option = new Option(`${flag} <${kind.choices ? 'choice' : kind.scalar}>`, description)
  if (kind.choices) option.choices(kind.choices)
  const parse = parserOf(kind)
  return [
    kind.many
      ? option.argParser((value: string, previous: unknown) => [
          ...((previous as unknown[] | undefined) ?? []),
          parse(value),
        ])
      : option.argParser(parse),
  ]
}

const scoped = async (run: Run, entity: 'service' | 'sandbox', ref: string) =>
  isId(entity, ref)
    ? ref
    : [await projectRef(run), run.selection.environment ?? (await environmentId(run)), ref].join(
        '/',
      )

const targets: Record<Target, (run: Run) => Promise<string>> = {
  project: projectRef,
  environment: async (run) => {
    const ref = run.selection.environment
    return ref === undefined || isId('environment', ref)
      ? environmentId(run, ref)
      : `${await projectRef(run)}/${ref}`
  },
  service: async (run) =>
    scoped(
      run,
      'service',
      await need(run.selection.service, {
        what: 'Service',
        flag: '--service <id or name>',
      }),
    ),
  sandbox: async (run) =>
    scoped(
      run,
      'sandbox',
      await need(run.selection.sandbox, {
        what: 'Sandbox',
        flag: '--sandbox <id or name>',
      }),
    ),
}

const isTarget = (name: string): name is Target => name in targets

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

export const renderOf = (endpoint: Endpoint): Render => {
  const name = (endpoint.meta.cli || {}).render
  if (name) {
    const registered = renderer(name)
    if (!registered)
      throw new Error(`${endpoint.name} renders with ${name}, which is not registered`)
    return registered
  }
  const columns = summaryColumns(endpoint)
  return (data) => human(data, columns)
}

type Flow = { wait?: true; timeout?: number; follow?: true }

const flowsOf = (command: Command, endpoint: Endpoint) => {
  const wait = pollParameter(endpoint)
  if (wait)
    command
      .option('--wait', 'repeat the call until done is true')
      .option(
        '--timeout <duration>',
        `how long --wait repeats it, such as 90s or 10m (default ${pollTimeout.default} s, at most ${pollTimeout.max} s)`,
        seconds,
      )
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

const commandOf = (word: string, { endpoint }: Generated, reserved: Set<string>) => {
  const { name, method, path, operation, meta, parameters, body, components } = endpoint
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
  const args =
    (meta.cli || {}).args ?? pathParameters.map((p) => p.name).filter((n) => !isTarget(n))
  for (const arg of args)
    command.addArgument(
      new Argument(
        `<${arg}>`,
        pathParameters.find((p) => p.name === arg)?.description ?? `the ${arg} of the target`,
      ),
    )
  const flows = flowsOf(command, endpoint)
  const bindings: Binding[] = []
  const fromGlobals: Target[] = []
  const required = (body?.required as string[] | undefined) ?? []
  const inputs: [string, string, Json | undefined, boolean][] = [
    ...parameters
      .filter((p) => p.in === 'query')
      .map((p): [string, string, Json | undefined, boolean] => [
        p.name,
        'query parameter',
        {
          ...p.schema,
          ...(p.description
            ? {
                description: p.description,
              }
            : {}),
        },
        p.required === true,
      ]),
    ...Object.entries((body?.properties as Record<string, Json> | undefined) ?? {}).map(
      ([property, schema]): [string, string, Json | undefined, boolean] => [
        property,
        'body field',
        schema,
        operation.requestBody?.required !== false && required.includes(property),
      ],
    ),
  ]
  for (const [property, where, schema, needed] of inputs) {
    if (isTarget(property)) {
      fromGlobals.push(property)
      continue
    }
    if (property === flows.wait) continue
    if (flows.follow && property === 'follow') {
      bindings.push({
        attribute: property,
        property,
      })
      continue
    }
    for (const option of optionsOf(property, where, schema, components, needed)) {
      if (reserved.has(option.attributeName())) continue
      command.addOption(option)
      if (!option.negate)
        bindings.push({
          attribute: option.attributeName(),
          property,
        })
    }
  }
  const hasBody = operation.requestBody !== undefined
  if (hasBody)
    command.option('--body <json>', 'other fields of the request body as a JSON object, or @file')
  const route = {
    method,
    path,
    params: parameters.map((p) => p.name),
    query: parameters.filter((p) => p.in === 'query').map((p) => p.name),
    body: hasBody,
  }
  command.action(
    action<string[], Record<string, unknown>, Globals>(async (options, ...positional) => {
      const run = await connect(options)
      const input: Record<string, unknown> = {
        ...extraBody(options.body),
      }
      for (const { attribute, property } of bindings)
        if (options[attribute] !== undefined) input[property] = options[attribute]
      for (const target of fromGlobals)
        if (run.selection[target] !== undefined) input[target] = run.selection[target]
      args.forEach((arg, i) => {
        input[arg] = positional[i]
      })
      for (const target of contextual) input[target] = await targets[target](run)
      const render = renderOf(endpoint)
      const { wait, timeout, follow: following } = options as Flow
      const send = (next: Record<string, unknown>) => {
        const request = requestOf(route, next)
        return run.request(request.path, request.init)
      }
      if (flows.wait && wait)
        return waitUntilDone(
          options,
          {
            label: positional[0] ?? name,
            wait: flows.wait,
            input: {
              ...input,
              ...(timeout === undefined
                ? {}
                : {
                    timeout_s: timeout,
                  }),
            },
          },
          send,
          render,
        )
      const request = requestOf(route, input)
      if (following)
        return follow(
          options,
          (headers) =>
            run.request(request.path, {
              ...request.init,
              headers: {
                ...(request.init.headers as Record<string, string>),
                ...headers,
              },
            }),
          render,
        )
      return reply(options, await send(input), render)
    }),
  )
  return command
}

const childOf = (parent: CommandUnknownOpts, name: string) =>
  parent.commands.find((c) => c.name() === name)

export const registerGenerated = (program: Program) => {
  const reserved = new Set(program.options.map((o) => o.attributeName()))
  reserved.add('body')
  const created = new Set<CommandUnknownOpts>()
  const clashes: string[] = []
  for (const generated of generatedCommands()) {
    const words = generated.path
    let parent: CommandUnknownOpts = program
    let clash = false
    for (const word of words.slice(0, -1)) {
      const child = childOf(parent, word)
      if (child && !child.commands.length) {
        clash = true
        break
      }
      if (child) {
        parent = child
        continue
      }
      const group = new Command(word).description(`API operations tagged ${word}`)
      parent.addCommand(group)
      created.add(group)
      parent = group
    }
    const leaf = words.at(-1)!
    const existing = clash ? undefined : childOf(parent, leaf)
    if (existing && created.has(existing))
      throw new Error(
        `${generated.endpoint.name} and another operation both derive sly ${words.join(' ')}`,
      )
    if (clash || existing) {
      clashes.push(generated.endpoint.name)
      continue
    }
    const command = commandOf(leaf, generated, reserved)
    parent.addCommand(command)
    created.add(command)
  }
  return clashes
}
