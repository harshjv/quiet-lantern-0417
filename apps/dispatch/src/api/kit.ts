import { principalCache } from '../auth/principal.ts'
import { callOf, type Deps } from './context.ts'
import type { CommitResult } from './changes.ts'
import { fail } from './errors.ts'
import { parseFields, project, type FieldTree } from './fields.ts'
import { createRedaction, createSandboxRedaction } from './redaction.ts'
import type { Static } from '@sinclair/typebox'
import type { Staged } from './shapes.ts'
import { createViews } from './views.ts'
import { createLiveHub } from '../net/live.ts'
import { createProbeLimits } from '../net/probe.ts'

export const createKit = (deps: Deps) => {
  const principal = principalCache(deps.db, deps.auth)
  const views = createViews(deps.db)
  return {
    deps,
    views,
    redaction: createRedaction(deps.db, deps.keyring),
    sandboxRedaction: createSandboxRedaction(deps.db, deps.keyring),
    live: createLiveHub(deps.stations),
    probeLimit: createProbeLimits(),
    principal,
    call: async (request: Request) => callOf(request, await principal(request)),
    fields: (text: string | undefined): FieldTree | undefined => parseFields(text),
    stagedBody: (result: Extract<CommitResult, { applied: false }>, set: { status?: number | string }) => {
      set.status = 202
      return project(views.staged, result.staged, parseFields('changes,refs,deployments')) as Static<typeof Staged>
    }
  }
}

export type Kit = ReturnType<typeof createKit>

export const slugPattern = '^[a-z0-9][a-z0-9-]{0,62}$'

const durationUnits: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

const rfc3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/

export const parseTime = (value: string | undefined, path: string) => {
  if (value === undefined) return undefined
  const relative = /^-?(\d+)([smhd])$/.exec(value)
  if (relative) return new Date(Date.now() - Number(relative[1]) * durationUnits[relative[2]!]!)
  const date = new Date(value)
  if (!rfc3339.test(value) || Number.isNaN(date.getTime())) return fail('VALIDATION_FAILED', `${path} must be RFC 3339 or a relative duration such as 15m or -15m.`, undefined, { issues: [{ path, message: 'invalid time' }] })
  return date
}

export const csv = (value: string | undefined) => (value === undefined ? undefined : value.split(',').map(v => v.trim()).filter(Boolean))

export const warning = (code: string, explanation: string) => ({ code, explanation })
