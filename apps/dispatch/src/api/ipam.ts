import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client.ts'
import { ipam_allocation, setting, station, virtual_ip } from '../db/schema.ts'
import { fail } from './errors.ts'

const firstEnvironmentIndex = 16

const settingOf = (db: Db, key: string, fallback: string) => (db.select().from(setting).where(eq(setting.key, key)).get()?.value as string | undefined) ?? fallback

const octets = (cidr: string) => cidr.split('/')[0]!.split('.').map(Number)

export const ensureNetwork = (db: Db, environmentId: string, stationId: string) => {
  const existing = db
    .select()
    .from(ipam_allocation)
    .where(and(eq(ipam_allocation.environment_id, environmentId), eq(ipam_allocation.station_id, stationId)))
    .get()
  if (existing) return existing
  const pool = settingOf(db, 'ipam.pool', '10.200.0.0/16')
  const [a, b, c] = octets(pool)
  const reserved = db.select({ registry: station.registry_subnet, sandbox: station.sandbox_subnet }).from(station).where(eq(station.id, stationId)).get()
  const taken = new Set([...db.select({ subnet: ipam_allocation.subnet }).from(ipam_allocation).where(eq(ipam_allocation.station_id, stationId)).all().map(r => r.subnet), reserved?.registry, reserved?.sandbox])
  for (let i = firstEnvironmentIndex; c! + i < 256; i++) {
    const subnet = `${a}.${b}.${c! + i}.0/24`
    if (taken.has(subnet)) continue
    return db.insert(ipam_allocation).values({ environment_id: environmentId, station_id: stationId, subnet, gateway: `${a}.${b}.${c! + i}.1` }).returning().get()
  }
  return fail('SUBNET_EXHAUSTED', `ipam.pool ${pool} has no free /24 for another environment on station ${stationId}.`, 'Delete unused environments on this station.', { station_id: stationId })
}

export const ensureSandboxNetwork = (db: Db, stationId: string) => {
  const row = db.select({ subnet: station.sandbox_subnet, registry: station.registry_subnet }).from(station).where(eq(station.id, stationId)).get()
  if (row?.subnet) return row.subnet
  const pool = settingOf(db, 'ipam.pool', '10.200.0.0/16')
  const [a, b, c] = octets(pool)
  const taken = new Set([...db.select({ subnet: ipam_allocation.subnet }).from(ipam_allocation).where(eq(ipam_allocation.station_id, stationId)).all().map(r => r.subnet), row?.registry])
  for (let i = firstEnvironmentIndex; c! + i < 256; i++) {
    const subnet = `${a}.${b}.${c! + i}.0/24`
    if (taken.has(subnet)) continue
    db.update(station).set({ sandbox_subnet: subnet }).where(eq(station.id, stationId)).run()
    return subnet
  }
  return fail('SUBNET_EXHAUSTED', `ipam.pool ${pool} has no free /24 for the sandbox network on station ${stationId}.`, 'Delete unused environments on this station.', { station_id: stationId })
}

export const dispatchPort = 7900

export const dispatchVirtualIp = (prefix: string) => {
  const [a, b] = octets(prefix)
  return `${a}.${b}.0.1`
}

export const ensureVirtualIp = (db: Db, serviceId: string, environmentId: string) => {
  const existing = db.select().from(virtual_ip).where(eq(virtual_ip.service_id, serviceId)).get()
  if (existing) return existing
  const prefix = settingOf(db, 'ipam.virtual_prefix', '100.64.0.0/16')
  const [a, b] = octets(prefix)
  const taken = new Set(db.select({ address: virtual_ip.address }).from(virtual_ip).all().map(r => r.address))
  for (let n = 2; n < 65534; n++) {
    const address = `${a}.${b}.${n >> 8}.${n & 255}`
    if ((n & 255) === 0 || (n & 255) === 255 || taken.has(address)) continue
    return db.insert(virtual_ip).values({ service_id: serviceId, environment_id: environmentId, address }).returning().get()
  }
  return fail('SUBNET_EXHAUSTED', `ipam.virtual_prefix ${prefix} has no free address left; virtual IPs are unique across the instance.`, 'Delete unused services or environments.', { environment_id: environmentId })
}
