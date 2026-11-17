import type { Db } from '../db/client.ts'

import type { ApprovalRow } from './lookup.ts'
import { requesterDecides } from './requester.ts'

export const approvalItem = (db: Db, row: ApprovalRow) => {
  const changes = row.changes as { op: string; entity: string }[]

  return {
    id: row.id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
    project_id: row.project_id,
    task_id: row.task_id,
    title: row.title,
    status: row.status,
    source: row.source,
    requested_by: row.requested_by,
    requester: row.requester,
    requester_decides: requesterDecides(db, row.requester),
    decided_by: row.decided_by,
    decided_at: row.decided_at?.toISOString() ?? null,
    self_approved: row.self_approved,
    reason: row.reason,
    ship: row.ship,
    summary: {
      add: changes.filter((c) => c.op === 'add' && c.entity !== 'deployment').length,
      update: changes.filter((c) => c.op === 'update').length,
      remove: changes.filter((c) => c.op === 'remove').length,
      deployments: changes.filter((c) => c.op === 'add' && c.entity === 'deployment').length,
    },
  }
}
