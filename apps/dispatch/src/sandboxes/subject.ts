import type { machine } from '../db/schema.ts'

type MachineRow = typeof machine.$inferSelect

export const machineSubject = (row: Pick<MachineRow, 'id' | 'project_id'>) => ({
  entity: 'machine',
  id: row.id,
  machine_id: row.id,
  project_id: row.project_id,
})
