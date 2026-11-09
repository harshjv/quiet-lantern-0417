import type { Command } from 'commander'
import { usage } from './errors.ts'
import type { Globals } from './kit.ts'
import { fail } from './output.ts'

export type Options = Globals & Record<string, unknown>

export const action =
  (fn: (options: Options, ...args: string[]) => Promise<number>) =>
  async (...args: unknown[]) => {
    const command = args.at(-1) as Command
    const options = command.optsWithGlobals() as Options
    const positionals = args.slice(0, -2).flat() as string[]
    try {
      process.exitCode = await fn(options, ...positionals)
    } catch (error) {
      process.exitCode = fail(options, error)
    }
  }

const units: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 }

export const seconds = (value: string) => {
  const match = /^(\d+)([smhd]?)$/.exec(value.trim())
  if (!match) throw usage(`${value} is not a duration.`, 'Use seconds or a number with s, m, h or d, such as 30d.')
  return Number(match[1]) * units[match[2] || 's']!
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
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value as Record<string, unknown>
  } catch {
    throw usage(`${what} is not a JSON object.`, `Pass ${what} as a JSON object.`)
  }
}

