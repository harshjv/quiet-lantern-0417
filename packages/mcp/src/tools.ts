import type { ServerContext, ToolAnnotations } from '@modelcontextprotocol/server'
import type { Schema, StaticOf } from './schema.ts'

export const levels = ['read', 'deploy', 'admin'] as const

export type Level = (typeof levels)[number]

export type Family = 'read' | 'write' | 'destroy'

export type Outcome = { ok: true; body: unknown } | { ok: false; envelope: unknown }

export type ToolRun<C> = (context: C, input: Record<string, unknown>, request: ServerContext) => Promise<Outcome>

export type ToolDef<C> = {
  name: string
  title: string
  description: string
  family: Family
  level: Level
  instance: boolean
  alwaysLoad: boolean
  input: Schema
  run: ToolRun<C>
}

export type ToolSpec<S extends Schema, C> = {
  name: string
  title: string
  description: string
  family: Family
  level: Level
  instance?: boolean
  alwaysLoad?: boolean
  input: S
  run: (context: C, input: StaticOf<S> & { idempotency_key?: string }, request: ServerContext) => Promise<Outcome>
}

const idempotencyKey = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  description: 'Repeat a mutation safely: the same key and input return the stored result for 24 hours'
}

const withIdempotency = (schema: Schema): Schema => {
  const object = schema as unknown as { properties?: Record<string, unknown> }
  return { ...object, properties: { ...object.properties, idempotency_key: idempotencyKey } } as unknown as Schema
}

export const defineTool = <S extends Schema, C>(spec: ToolSpec<S, C>): ToolDef<C> => ({
  name: spec.name,
  title: spec.title,
  description: spec.description,
  family: spec.family,
  level: spec.level,
  instance: spec.instance ?? false,
  alwaysLoad: spec.alwaysLoad ?? false,
  input: spec.family === 'read' ? spec.input : withIdempotency(spec.input),
  run: spec.run as ToolRun<C>
})

export const annotationsOf = (family: Family, title: string): ToolAnnotations =>
  family === 'read'
    ? { title, readOnlyHint: true, openWorldHint: false }
    : { title, readOnlyHint: false, destructiveHint: family === 'destroy', idempotentHint: true, openWorldHint: false }

export const atLeast = (have: Level | null, need: Level) => have !== null && levels.indexOf(have) >= levels.indexOf(need)

export type Caller = { level: Level | null; instanceAdmin: boolean }

export const visibleTo = <C>(caller: Caller, tool: ToolDef<C>) => atLeast(caller.level, tool.level) && (!tool.instance || caller.instanceAdmin)
