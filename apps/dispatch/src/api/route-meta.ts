import { Elysia, type DocumentDecoration } from 'elysia'

import type { Principal } from '../auth/principal.ts'
import { anyTarget, type Level, type Target } from '../auth/scopes.ts'
import type { Db } from '../db/client.ts'

import { authorize, requireInstance, requireLevel } from './access.ts'
import { targets, type TargetEntity } from './lookup.ts'

export type RouteLevel = 'public' | 'any' | Level | 'instance read' | 'instance admin'

export type Mcp = false | { destructive?: true; always_load?: true; poll?: true }

export type Cli = false | { path?: string[]; args?: string[]; render?: string }

export type TargetInput = {
  params: Record<string, string>
  query: Record<string, string | undefined>
  body: unknown
  headers: Headers
}

export type Operation = {
  id: string
  level: RouteLevel
  mcp?: Mcp
  cli?: Cli
  stream?: true
  target?: (input: TargetInput) => Target
}

const collections: Record<string, TargetEntity> = {
  projects: 'project',
  environments: 'environment',
  services: 'service',
  ports: 'service_port',
  domains: 'domain',
  'port-allocations': 'port_allocation',
  deployments: 'deployment',
  builds: 'build',
  runs: 'run',
  volumes: 'volume',
  variables: 'variable',
  'secret-values': 'secret_value',
  'staged-changes': 'staged_change',
  sandboxes: 'sandbox',
  'sandbox-snapshots': 'sandbox_snapshot',
}

const instanceLevels: Partial<Record<RouteLevel, Level>> = {
  'instance read': 'read',
  'instance admin': 'admin',
}

const targetOf = (db: Db, route: string, params: Record<string, string>) => {
  const segments = route.split('/')
  const at = segments.findIndex((segment) => segment.startsWith(':'))
  if (at < 0) return null
  const entity = collections[segments[at - 1]!]
  if (!entity) throw new Error(`No target lookup for the entity parameter of ${route}`)
  return targets[entity](db, params[segments[at]!.slice(1)]!).target
}

export const routeMeta = (db: Db, principalOf: (request: Request) => Promise<Principal>) =>
  new Elysia({
    name: 'stationly.route-meta',
  }).macro({
    operation: ({ id, level, mcp, cli, stream, target: targetFrom }: Operation) => ({
      detail: {
        operationId: id,
        'x-stationly': {
          level,
          ...(mcp === undefined
            ? {}
            : {
                mcp,
              }),
          ...(cli === undefined
            ? {}
            : {
                cli,
              }),
          ...(stream
            ? {
                stream,
              }
            : {}),
        },
      } as DocumentDecoration,
      beforeHandle: async (context: {
        request: Request
        params: Record<string, string>
        query: Record<string, string | undefined>
        body: unknown
        route: string
      }) => {
        if (level === 'public') return
        const principal = await principalOf(context.request)
        if (level === 'any') return
        const instance = instanceLevels[level]
        if (instance) return requireInstance(principal, instance)
        const target = targetFrom
          ? targetFrom({
              params: context.params,
              query: context.query,
              body: context.body,
              headers: context.request.headers,
            })
          : targetOf(db, context.route, context.params)
        if (target) authorize(principal, target, level as Level)
        else requireLevel(principal, anyTarget, level as Level)
      },
    }),
  })
