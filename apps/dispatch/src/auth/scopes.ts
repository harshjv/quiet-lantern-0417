export const levels = ['read', 'deploy', 'admin'] as const

export type Level = (typeof levels)[number]

export type Scope = { project_id: string; environment_id: string; level: Level }

export type Target = { project_id: string; environment_id: string }

export const anyTarget: Target = { project_id: '*', environment_id: '*' }

const rank = (level: Level) => levels.indexOf(level)

const covers = (granted: string, wanted: string) => granted === '*' || granted === wanted

export const levelAt = (scopes: Scope[], target: Target): Level | null => {
  let best: Level | null = null
  for (const scope of scopes) {
    if (!covers(scope.project_id, target.project_id) || !covers(scope.environment_id, target.environment_id)) continue
    if (best === null || rank(scope.level) > rank(best)) best = scope.level
  }
  return best
}

export const atLeast = (have: Level | null, need: Level) => have !== null && rank(have) >= rank(need)

export const isInstanceAdmin = (scopes: Scope[]) => atLeast(levelAt(scopes, anyTarget), 'admin')

export const scopeWithin = (scopes: Scope[], wanted: Scope) =>
  atLeast(levelAt(scopes, { project_id: wanted.project_id, environment_id: wanted.environment_id }), 'admin')

export const fullAdmin: Scope[] = [{ project_id: '*', environment_id: '*', level: 'admin' }]
