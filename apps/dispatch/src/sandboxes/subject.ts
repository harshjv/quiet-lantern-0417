import type { sandbox } from '../db/schema.ts'

type SandboxRow = typeof sandbox.$inferSelect

export const sandboxSubject = (row: Pick<SandboxRow, 'id' | 'project_id' | 'environment_id'>) => ({
  entity: 'sandbox',
  id: row.id,
  sandbox_id: row.id,
  project_id: row.project_id,
  environment_id: row.environment_id,
})
