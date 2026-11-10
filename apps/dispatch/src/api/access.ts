import type { Principal } from '../auth/principal.ts'
import { anyTarget, atLeast, levelAt, type Level, type Target } from '../auth/scopes.ts'

import { fail } from './errors.ts'

const describe = (target: Target) =>
  `project ${target.project_id === '*' ? '*' : target.project_id}, environment ${target.environment_id === '*' ? '*' : target.environment_id}`

export const can = (principal: Principal, target: Target, level: Level) =>
  atLeast(levelAt(principal.scopes, target), level)

export const requireLevel = (principal: Principal, target: Target, level: Level) => {
  if (can(principal, target, level)) return
  const have = levelAt(principal.scopes, target)
  fail(
    'FORBIDDEN_SCOPE',
    `This credential has ${have ?? 'no access'} on ${describe(target)} but the operation needs ${level}.`,
    `Create a token with ${level} on ${describe(target)}, or ask the admin to run this.`,
    {
      required: {
        ...target,
        level,
      },
    },
  )
}

export const requireInstance = (principal: Principal, level: Level) => {
  if (can(principal, anyTarget, level)) return
  fail(
    'INSTANCE_SCOPE_REQUIRED',
    `This operation is instance-level and needs ${level} on every project and environment.`,
    `Use a personal token, a signed-in session, or a scoped token with ${level} on project * and environment *.`,
    {
      required: {
        ...anyTarget,
        level,
      },
    },
  )
}

export const requireHuman = (
  principal: Principal,
  what: string,
  required: Record<string, unknown> = {},
) => {
  if (principal.human) return
  fail(
    'PROTECTED_ENVIRONMENT',
    `${what} needs a human actor; tokens and OAuth clients are never human.`,
    'Ask the admin to do this from the dashboard or an interactive sly session.',
    {
      reason: 'human_required',
      required,
    },
  )
}

export const seesProject = (principal: Principal, projectId: string) =>
  principal.scopes.some((scope) => scope.project_id === '*' || scope.project_id === projectId)

export const authorize = (principal: Principal, target: Target, level: Level) => {
  if (target.project_id === '*' && target.environment_id === '*')
    return requireInstance(principal, level)
  if (
    level === 'read' &&
    target.environment_id === '*' &&
    seesProject(principal, target.project_id)
  )
    return
  requireLevel(principal, target, level)
}

export const seesEnvironment = (principal: Principal, target: Target) =>
  can(principal, target, 'read')
