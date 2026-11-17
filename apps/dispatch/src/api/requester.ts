import type { Principal } from '../auth/principal.ts'
import type { Db } from '../db/client.ts'
import { activeAdminIds } from '../team/members.ts'

import { fail } from './errors.ts'

export const requesterOf = (principal: Principal) =>
  principal.actor.type === 'user' || principal.actor.type === 'token' ? principal.user_id : null

export const requesterDecides = (db: Db, requester: string | null) =>
  requester !== null && activeAdminIds(db).every((id) => id === requester)

export const requireRequesterRule = (
  db: Db,
  approval: { requester: string | null },
  decider: Principal,
) => {
  if (approval.requester === null || decider.user_id !== approval.requester) {
    return false
  }

  if (!requesterDecides(db, approval.requester)) {
    fail(
      'FORBIDDEN_SCOPE',
      'Another admin approves this, because you asked for it.',
      'Ask another admin to approve it, or reject it yourself to withdraw it.',
      {
        reason: 'requester',
      },
    )
  }

  return true
}
