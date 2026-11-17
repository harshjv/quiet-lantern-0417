import { scopeTargetValues, tokenLevelValues } from '@stationly/protocol'

export type Level = (typeof tokenLevelValues)[number]

export type Scope = { project_id: string; target: string; preview_id?: string; level: Level }

export type Target = { project_id: string; target: string; preview_id?: string }

export const anyTarget: Target = {
  project_id: '*',
  target: '*',
}

export const isScopeTarget = (value: string): value is (typeof scopeTargetValues)[number] =>
  (scopeTargetValues as readonly string[]).includes(value)

const rank = (level: Level) => tokenLevelValues.indexOf(level)

const covers = (granted: string, wanted: string) => granted === '*' || granted === wanted

export const levelAt = (scopes: Scope[], target: Target): Level | null => {
  let best: Level | null = null

  for (const scope of scopes) {
    if (
      !covers(scope.project_id, target.project_id) ||
      !covers(scope.target, target.target) ||
      (scope.preview_id !== undefined && scope.preview_id !== target.preview_id)
    ) {
      continue
    }

    if (best === null || rank(scope.level) > rank(best)) {
      best = scope.level
    }
  }

  return best
}

export const atLeast = (have: Level | null, need: Level) =>
  have !== null && rank(have) >= rank(need)

export const isInstanceAdmin = (scopes: Scope[]) => atLeast(levelAt(scopes, anyTarget), 'admin')

export const scopeWithin = (scopes: Scope[], wanted: Scope) =>
  atLeast(
    levelAt(scopes, {
      project_id: wanted.project_id,
      target: wanted.target,
      preview_id: wanted.preview_id,
    }),
    'admin',
  )

export const fullAdmin: Scope[] = [
  {
    project_id: '*',
    target: '*',
    level: 'admin',
  },
]
