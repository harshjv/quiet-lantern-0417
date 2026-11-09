import { eq } from 'drizzle-orm'
import type { Db } from '../db/client.ts'
import { service } from '../db/schema.ts'
import { emitEvent, serviceSubject } from './events.ts'

export type Signal = (typeof service.$inferSelect)['status']

export const setServiceStatus = (db: Db, serviceId: string, status: Signal, details: Record<string, unknown>) => {
  const row = db.select({ status: service.status, desired: service.desired_state }).from(service).where(eq(service.id, serviceId)).get()
  if (!row) return false
  const next = row.desired === 'stopped' ? 'stopped' : status
  if (row.status === next) return false
  db.update(service).set({ status: next }).where(eq(service.id, serviceId)).run()
  emitEvent(db, 'health.changed', serviceSubject(db, serviceId), { from: row.status, to: next, ...details })
  return true
}

export const signalFromHeartbeat = (hint: string, health: string): Signal => {
  if (health === 'passing') return 'green'
  if (health === 'failed') return 'red'
  if (health === 'failing') return 'amber'
  if (hint === 'running') return 'green'
  if (hint === 'stopped') return 'red'
  return 'amber'
}
