import { Command, type CommandUnknownOpts, type OptionValues } from '@commander-js/extra-typings'

import { usage } from './errors.ts'
import { connect, send, type Globals, type Reply, type Run } from './kit.ts'
import { fail, human, print } from './output.ts'
import { tagSummary } from './tags.ts'

export const createProgram = () =>
  new Command('sly')
    .description('Stationly CLI: a thin client over the Dispatch API')
    .option('--json', 'print the API response unmodified as one JSON document')
    .option('--dry-run', 'print the request a mutating command would send, and send nothing')
    .option('--instance <url>', 'instance to use instead of the current one')
    .option('--project <project>', 'project id or name (default from .stationly/context.json)')
    .option('--environment <environment>', 'environment id or name (default: the project default)')
    .option('--service <service>', 'service id or name')
    .option('--sandbox <sandbox>', 'sandbox id or name')
    .exitOverride()
    .configureOutput({
      writeErr: (text) => process.stderr.write(text),
    })

export type Program = ReturnType<typeof createProgram>

export type ProgramOptions = ReturnType<Program['opts']>

export const group = (parent: CommandUnknownOpts, name: string) =>
  (parent.commands.find((c) => c.name() === name) ??
    parent.command(name).description(tagSummary(name))) as Command<[], {}, ProgramOptions>

export const action =
  <A extends unknown[], O extends OptionValues, G extends Globals>(
    fn: (options: O & G, ...args: A) => Promise<number>,
  ) =>
  async (...args: [...A, O, Command<A, O, G>]) => {
    const options = (args.at(-1) as Command<A, O, G>).optsWithGlobals() as O & G
    try {
      process.exitCode = await fn(options, ...(args.slice(0, -2) as A))
    } catch (error) {
      process.exitCode = fail(options, error)
    }
  }

type Leaf<A extends unknown[], O, G, R> = (run: Run, options: O & G, ...args: A) => Promise<R>

type Replying<D> = (Extract<Reply, { error: null }> & { data: D }) | Extract<Reply, { data: null }>

export function call<
  A extends unknown[],
  O extends OptionValues,
  G extends Globals,
  R extends Reply,
>(fn: Leaf<A, O, G, R>): ReturnType<typeof action<A, O, G>>
export function call<A extends unknown[], O extends OptionValues, G extends Globals, D>(
  fn: Leaf<A, O, G, Replying<D>>,
  render: (data: D) => string,
): ReturnType<typeof action<A, O, G>>
export function call<A extends unknown[], O extends OptionValues, G extends Globals>(
  fn: Leaf<A, O, G, Reply>,
  render: (data: unknown) => string = human,
) {
  return action<A, O, G>(async (options, ...args) =>
    print(options, await send(fn(await connect(options), options, ...args)), render),
  )
}

const units: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
}

export const seconds = (value: string) => {
  const match = /^(\d+)([smhd]?)$/.exec(value.trim())
  if (!match)
    throw usage(
      `${value} is not a duration.`,
      'Use seconds or a number with s, m, h or d, such as 30d.',
    )
  return Number(match[1]) * units[match[2] || 's']!
}

const sizes: Record<string, number> = {
  '': 1,
  b: 1,
  k: 1024,
  kb: 1024,
  kib: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
  t: 1024 ** 4,
  tb: 1024 ** 4,
  tib: 1024 ** 4,
}

export const bytes = (value: string) => {
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(value.trim())
  const unit = sizes[match?.[2]?.toLowerCase() ?? '-']
  if (!match || unit === undefined)
    throw usage(
      `${value} is not a size.`,
      'Pass bytes, or a number with KiB, MiB, GiB or TiB, such as 8GiB.',
    )
  return Math.round(Number(match[1]) * unit)
}

export const integer = (value: string) => {
  const n = Number(value)
  if (!Number.isInteger(n)) throw usage(`${value} is not an integer.`, 'Pass a whole number.')
  return n
}

export const collect = (value: string, previous: string[] = []) => [...previous, value]

export const parseJson = (text: string, what: string): Record<string, unknown> => {
  try {
    const value = JSON.parse(text) as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      throw new Error('not an object')
    return value as Record<string, unknown>
  } catch {
    throw usage(`${what} is not a JSON object.`, `Pass ${what} as a JSON object.`)
  }
}
