import { randomBytes } from 'node:crypto'

import type { Db } from './client.ts'
import { audit_event } from './schema.ts'

type AuditRow = typeof audit_event.$inferInsert

export type AuditRecord = {
  actor: AuditRow['actor']
  action: string
  target: AuditRow['target']
  requestId?: string
  idempotencyKey?: string | null
  purpose?: string | null
  before?: AuditRow['before']
  after?: AuditRow['after']
}

export const mintRequestId = () => `req_${randomBytes(12).toString('hex')}`

export const recordAudit = (db: Pick<Db, 'insert'>, record: AuditRecord) =>
  db
    .insert(audit_event)
    .values({
      actor: record.actor,
      action: record.action,
      target: record.target,
      request_id: record.requestId ?? mintRequestId(),
      idempotency_key: record.idempotencyKey ?? null,
      purpose: record.purpose ?? null,
      before: record.before ?? null,
      after: record.after ?? null,
    })
    .run()
