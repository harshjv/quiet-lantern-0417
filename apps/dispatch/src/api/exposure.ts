import { and, eq } from 'drizzle-orm'
import type { Db } from '../db/client.ts'
import { port_allocation, station } from '../db/schema.ts'
import { effectivePins, readLockfile } from '../platform/lockfile.ts'
import { fail } from './errors.ts'
import { readSetting } from '../db/settings.ts'

const sslipHost = (address: string) => (address.includes(':') ? address.replaceAll(':', '-') : address.replaceAll('.', '-'))

export const generatedHostname = (db: Db, serviceName: string, environmentName: string, stationId: string) => {
  const zone = readSetting(db, 'domains.zone')
  const label = `${serviceName}-${environmentName}`
  if (zone) return `${label}.${zone}`
  const address = db.select({ public_address: station.public_address }).from(station).where(eq(station.id, stationId)).get()?.public_address
  return address ? `${label}.${sslipHost(address)}.sslip.io` : null
}

export const hostPortPicker = (db: Db, stationId: string) => {
  const [low, high] = readSetting(db, 'exposure.port_range').split('-').map(Number) as [number, number]
  const used = new Set(
    db
      .select({ host_port: port_allocation.host_port })
      .from(port_allocation)
      .where(and(eq(port_allocation.station_id, stationId), eq(port_allocation.status, 'active')))
      .all()
      .map(a => a.host_port)
  )
  return {
    range: `${low}-${high}`,
    next: () => {
      for (let candidate = low; candidate <= high; candidate++) {
        if (!used.has(candidate)) {
          used.add(candidate)
          return candidate
        }
      }
      return null
    }
  }
}

export const requireGatewayPin = (db: Db, stationId: string) => {
  const arch = db.select({ arch: station.arch }).from(station).where(eq(station.id, stationId)).get()?.arch
  const lockfile = readLockfile(db)
  if (effectivePins(db, arch).gateway?.digest) return
  fail(
    'GATEWAY_NOT_PINNED',
    lockfile
      ? `The lockfile pins release ${lockfile.release}, which has no gateway component, so no Gateway runs on this station and a domain would never be served.`
      : 'No lockfile is written yet, so no Gateway runs on this station and a domain would never be served.',
    lockfile ? 'Upgrade to a release that pins the Gateway (sly platform upgrade --version <release>), then add the domain.' : 'Run sly setup on the station host first, then add the domain.',
    { release: lockfile?.release ?? null, station_id: stationId }
  )
}
