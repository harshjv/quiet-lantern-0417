import type { StandardSchemaWithJSON, ToolAnnotations } from '@modelcontextprotocol/server'

import { tokenLevelValues } from '@stationly/protocol'

export type Level = (typeof tokenLevelValues)[number]

export type RouteLevel = 'public' | 'any' | Level | 'instance read' | 'instance admin'

export type Outcome = { ok: true; body: unknown } | { ok: false; envelope: unknown }

export type ToolDef = {
  name: string
  title: string
  description: string
  method: string
  path: string
  level: RouteLevel
  params: string[]
  query: string[]
  body: boolean
  poll: string | null
  alwaysLoad: boolean
  annotations: ToolAnnotations
  inputSchema: StandardSchemaWithJSON<Record<string, unknown>, Record<string, unknown>>
  outputSchema: StandardSchemaWithJSON<Record<string, unknown>, Record<string, unknown>> | undefined
}

export const atLeast = (have: Level | null, need: Level) =>
  have !== null && tokenLevelValues.indexOf(have) >= tokenLevelValues.indexOf(need)

export type Caller = { level: Level | null; instanceAdmin: boolean }

const allowed: Record<RouteLevel, (caller: Caller) => boolean> = {
  public: () => true,
  any: () => true,
  read: (caller) => atLeast(caller.level, 'read'),
  deploy: (caller) => atLeast(caller.level, 'deploy'),
  admin: (caller) => atLeast(caller.level, 'admin'),
  'instance read': (caller) => caller.instanceAdmin,
  'instance admin': (caller) => caller.instanceAdmin,
}

export const visibleTo = (caller: Caller, tool: ToolDef) => allowed[tool.level](caller)
