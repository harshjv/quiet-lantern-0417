import { Elysia, type DocumentDecoration } from 'elysia'

import type { CliMeta } from '@stationly/mcp'

import { chargeTokenWindow, type AuthenticateOptions, type Principal } from '../auth/principal.ts'
import { anyTarget, type Level, type Target } from '../auth/scopes.ts'
import type { Db } from '../db/client.ts'

import { authorize, requireInstance, requireLevel } from './access.ts'
import { targets } from './lookup.ts'

export type RouteLevel = 'public' | 'any' | Level | 'instance read' | 'instance admin'

export type Mcp = false | { destructive?: true; always_load?: true; poll?: true }

export type TargetInput = {
  params: Record<string, string>
  query: Record<string, string | undefined>
  body: unknown
  headers: Headers
}

export type Operation = {
  id: string
  summary: string
  level: RouteLevel
  mcp?: Mcp
  cli?: CliMeta
  stream?: true
  target?: (input: TargetInput) => Target
}

type EntityOperation = Omit<Operation, 'level' | 'target'> & {
  level: Level
  deferTokenWindow?: true
  humanForWorkspaceToken?: string
}

type RouteContext = {
  request: Request
  params: Record<string, string>
  query: Record<string, string | undefined>
  body: unknown
  route: string
}

const documented = (
  operation: Operation | EntityOperation,
): DocumentDecoration & { 'x-stationly': object } => {
  const { id, summary, level, mcp, cli, stream } = operation
  const human = 'humanForWorkspaceToken' in operation ? operation.humanForWorkspaceToken : undefined

  return {
    operationId: id,
    summary,
    ...(human
      ? {
          description: `${summary}. A workspace token needs a human actor to ${human}.`,
        }
      : {}),
    'x-stationly': {
      level,
      human_for_workspace_token: human,
      mcp,
      cli,
      stream,
    },
  }
}

const entityParameter = (route: string) => {
  const segment = route.split('/').find((part) => part.startsWith(':'))

  if (!segment) {
    throw new Error(`${route} has no entity parameter`)
  }

  return segment.slice(1)
}

export const routeMeta = (
  db: Db,
  principalOf: (request: Request, options?: AuthenticateOptions) => Promise<Principal>,
) => {
  const onEntity =
    <Found extends { target: Target }>(lookup: (db: Db, id: string) => Found) =>
    (operation: EntityOperation) => ({
      detail: documented(operation),
      resolve: async (context: RouteContext) => {
        const principal = await principalOf(context.request, {
          deferTokenWindow: operation.deferTokenWindow === true,
        })

        let ctx: Found

        try {
          ctx = lookup(db, context.params[entityParameter(context.route)]!)
          authorize(principal, ctx.target, operation.level)
        } catch (error) {
          if (operation.deferTokenWindow) {
            chargeTokenWindow(principal)
          }

          throw error
        }

        return {
          ctx,
        }
      },
    })

  return new Elysia({
    name: 'stationly.route-meta',
  }).macro({
    operation: (operation: Operation) => ({
      detail: documented(operation),
      beforeHandle: async (context: RouteContext) => {
        const { level, target: targetFrom } = operation

        if (level === 'public') {
          return
        }

        const principal = await principalOf(context.request)

        if (level === 'any') {
          return
        }

        if (level === 'instance read' || level === 'instance admin') {
          return requireInstance(principal, level === 'instance read' ? 'read' : 'admin')
        }

        if (targetFrom) {
          return authorize(
            principal,
            targetFrom({
              params: context.params,
              query: context.query,
              body: context.body,
              headers: context.request.headers,
            }),
            level,
          )
        }

        if (context.route.includes('/:')) {
          throw new Error(
            `${context.route} authorizes on its path entity; declare it with that entity's key`,
          )
        }

        requireLevel(principal, anyTarget, level)
      },
    }),
    project: onEntity(targets.project),
    environment: onEntity(targets.environment),
    service: onEntity(targets.service),
    service_port: onEntity(targets.service_port),
    domain: onEntity(targets.domain),
    port_allocation: onEntity(targets.port_allocation),
    deployment: onEntity(targets.deployment),
    build: onEntity(targets.build),
    run: onEntity(targets.run),
    volume: onEntity(targets.volume),
    variable: onEntity(targets.variable),
    secret_value: onEntity(targets.secret_value),
    staged_change: onEntity(targets.staged_change),
    sandbox: onEntity(targets.sandbox),
    sandbox_snapshot: onEntity(targets.sandbox_snapshot),
  })
}
