import { networkLayout } from '@stationly/protocol'
import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client.ts'
import { ipam_allocation, station, virtual_ip } from '../db/schema.ts'
import { readSetting } from '../db/settings.ts'
import { hostAt, slash24sFrom } from '../net/cidr.ts'
import { fail } from './errors.ts'

export const ensureNetwork = (db: Db, environmentId: string, stationId: string) => {
  const existing = db
    .select()
    .from(ipam_allocation)
    .where(and(eq(ipam_allocation.environment_id, environmentId), eq(ipam_allocation.station_id, stationId)))
    .get()
  if (existing) return existing
  const pool = readSetting(db, 'ipam.pool')
  const reserved = db.select({ registry: station.registry_subnet, sandbox: station.sandbox_subnet }).from(station).where(eq(station.id, stationId)).get()
  const taken = new Set([...db.select({ subnet: ipam_allocation.subnet }).from(ipam_allocation).where(eq(ipam_allocation.station_id, stationId)).all().map(r => r.subnet), reserved?.registry, reserved?.sandbox])
  for (const { subnet, gateway } of slash24sFrom(pool, networkLayout.firstEnvironmentIndex)) {
    if (taken.has(subnet)) continue
    return db.insert(ipam_allocation).values({ environment_id: environmentId, station_id: stationId, subnet, gateway }).returning().get()
  }
  return fail('SUBNET_EXHAUSTED', `ipam.pool ${pool} has no free /24 for another environment on station ${stationId}.`, 'Delete unused environments on this station.', { station_id: stationId })
}

export const ensureSandboxNetwork = (db: Db, stationId: string) => {
  const row = db.select({ subnet: station.sandbox_subnet, registry: station.registry_subnet }).from(station).where(eq(station.id, stationId)).get()
  if (row?.subnet) return row.subnet
  const pool = readSetting(db, 'ipam.pool')
  const taken = new Set([...db.select({ subnet: ipam_allocation.subnet }).from(ipam_allocation).where(eq(ipam_allocation.station_id, stationId)).all().map(r => r.subnet), row?.registry])
  for (const { subnet } of slash24sFrom(pool, networkLayout.firstEnvironmentIndex)) {
    if (taken.has(subnet)) continue
    db.update(station).set({ sandbox_subnet: subnet }).where(eq(station.id, stationId)).run()
    return subnet
  }
  return fail('SUBNET_EXHAUSTED', `ipam.pool ${pool} has no free /24 for the sandbox network on station ${stationId}.`, 'Delete unused environments on this station.', { station_id: stationId })
}

export const dispatchVirtualIp = (prefix: string) => hostAt(prefix, networkLayout.dispatchVirtualHost)

export const ensureVirtualIp = (db: Db, serviceId: string, environmentId: string) => {
  const existing = db.select().from(virtual_ip).where(eq(virtual_ip.service_id, serviceId)).get()
  if (existing) return existing
  const prefix = readSetting(db, 'ipam.virtual_prefix')
  const taken = new Set(db.select({ address: virtual_ip.address }).from(virtual_ip).all().map(r => r.address))
  for (let n = networkLayout.firstServiceVirtualHost; n < 65534; n++) {
    const address = hostAt(prefix, n)
    if ((n & 255) === 0 || (n & 255) === 255 || taken.has(address)) continue
    return db.insert(virtual_ip).values({ service_id: serviceId, environment_id: environmentId, address }).returning().get()
  }
  return fail('SUBNET_EXHAUSTED', `ipam.virtual_prefix ${prefix} has no free address left; virtual IPs are unique across the instance.`, 'Delete unused services or environments.', { environment_id: environmentId })
}
