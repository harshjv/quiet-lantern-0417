import type { Static } from '@sinclair/typebox'
import { Elysia } from 'elysia'

import { parseDuration } from '@stationly/protocol/format'

import { principalCache } from '../auth/principal.ts'
import { createLiveHub } from '../net/live.ts'
import { createProbeLimits } from '../net/probe.ts'

import type { CommitResult } from './changes.ts'
import { callOf, type Deps } from './context.ts'
import { fail } from './errors.ts'
import { parseFields, project, type FieldTree } from './fields.ts'
import { createRedaction, createSandboxRedaction } from './redaction.ts'
import { routeMeta } from './route-meta.ts'
import { models, type Staged } from './shapes.ts'
import { createViews } from './views.ts'

export const createKit = (deps: Deps) => {
  const principal = principalCache(deps.db, deps.auth)
  const views = createViews(deps.db)
  const operations = routeMeta(deps.db, principal)

  return {
    deps,
    views,
    redaction: createRedaction(deps.db, deps.keyring),
    sandboxRedaction: createSandboxRedaction(deps.db, deps.keyring),
    live: createLiveHub(deps.stations),
    probeLimit: createProbeLimits(),
    principal,
    router: <const Prefix extends string>(tag: string, prefix: Prefix) =>
      new Elysia({
        prefix,
        normalize: false,
        tags: [tag],
      })
        .use(models())
        .use(operations),
    call: async (request: Request) => callOf(request, await principal(request)),
    fields: (text: string | undefined): FieldTree | undefined => parseFields(text),
    stagedBody: (
      result: Extract<CommitResult, { applied: false }>,
      set: { status?: number | string },
    ) => {
      set.status = 202

      return project(
        views.staged,
        result.staged,
        parseFields('changes,refs,deployments'),
      ) as Static<typeof Staged>
    },
  }
}

export type Kit = ReturnType<typeof createKit>

const rfc3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/

export const parseTime = (value: string | undefined, path: string) => {
  if (value === undefined) {
    return undefined
  }

  const relative = parseDuration(value.replace(/^-/, ''))

  if (relative !== null) {
    return new Date(Date.now() - relative * 1000)
  }

  const date = new Date(value)

  if (!rfc3339.test(value) || Number.isNaN(date.getTime())) {
    return fail(
      'VALIDATION_FAILED',
      `${path} must be RFC 3339 or a relative duration such as 15m or -15m.`,
      undefined,
      {
        issues: [
          {
            path,
            message: 'invalid time',
          },
        ],
      },
    )
  }

  return date
}

export const csv = (value: string | undefined) =>
  value === undefined
    ? undefined
    : value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)

export const warning = (code: string, explanation: string) => ({
  code,
  explanation,
})
