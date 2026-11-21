import type { Static } from '@sinclair/typebox'
import { sql } from 'drizzle-orm'

import type { MachineEgress } from '@stationly/protocol'

import { requireHuman } from '../api/access.ts'
import type { Principal } from '../auth/principal.ts'
import type { Db } from '../db/client.ts'
import { machine } from '../db/schema.ts'

type Egress = Static<typeof MachineEgress>
type Entry = Egress['domains'][number]

const wildcardDepth = 3

const covers = (allowed: Entry, wanted: Entry) => {
  if (!wanted.ports.every((port) => allowed.ports.includes(port))) {
    return false
  }

  if (wanted.domain === allowed.domain) {
    return wanted.wildcard === allowed.wildcard
  }

  if (!allowed.wildcard || wanted.wildcard || !wanted.domain.endsWith(`.${allowed.domain}`)) {
    return false
  }

  const below = wanted.domain.slice(0, -allowed.domain.length - 1).split('.').length

  return below <= wildcardDepth
}

export const egressWithin = (wanted: Egress, policy: Egress) => {
  if (policy.mode === 'open') {
    return true
  }

  return (
    wanted.mode === 'allowlist' &&
    wanted.domains.every((entry) => policy.domains.some((allowed) => covers(allowed, entry)))
  )
}

export const workspaceHeldBy = (db: Db, principal: Principal) =>
  principal.token_id
    ? db
        .select()
        .from(machine)
        .where(sql`json_extract(${machine.workspace}, '$.token_id') = ${principal.token_id}`)
        .get()
    : undefined

export const requireHumanToWiden = (
  principal: Principal,
  held: typeof machine.$inferSelect | undefined,
  what: string | null,
) => {
  if (held && what) {
    requireHuman(principal, `A workspace token ${what}`, {
      workspace_id: held.id,
    })
  }
}
