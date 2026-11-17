import { and, eq } from 'drizzle-orm'

import { networkLayout } from '@stationly/protocol'

import type { Db } from '../db/client.ts'
import { ipam_allocation, server, virtual_ip } from '../db/schema.ts'
import { readSetting } from '../db/settings.ts'
import { hostAt, slash24sFrom } from '../net/cidr.ts'

import { fail } from './errors.ts'

export const ensureNetwork = (db: Db, targetId: string, stationId: string) => {
  const existing = db
    .select()
    .from(ipam_allocation)
    .where(and(eq(ipam_allocation.target_id, targetId), eq(ipam_allocation.server_id, stationId)))
    .get()

  if (existing) {
    return existing
  }

  const pool = readSetting(db, 'ipam.pool')
  const reserved = db
    .select({
      registry: server.registry_subnet,
      machine: server.machine_subnet,
    })
    .from(server)
    .where(eq(server.id, stationId))
    .get()
  const taken = new Set([
    ...db
      .select({
        subnet: ipam_allocation.subnet,
      })
      .from(ipam_allocation)
      .where(eq(ipam_allocation.server_id, stationId))
      .all()
      .map((r) => r.subnet),
    reserved?.registry,
    reserved?.machine,
  ])

  for (const { subnet, gateway } of slash24sFrom(pool, networkLayout.firstEnvironmentIndex)) {
    if (taken.has(subnet)) {
      continue
    }

    return db
      .insert(ipam_allocation)
      .values({
        target_id: targetId,
        server_id: stationId,
        subnet,
        gateway,
      })
      .returning()
      .get()
  }

  return fail(
    'SUBNET_EXHAUSTED',
    `ipam.pool ${pool} has no free /24 for another production or preview on server ${stationId}.`,
    'Delete unused previews on this server.',
    {
      server_id: stationId,
    },
  )
}

export const ensureMachineNetwork = (db: Db, stationId: string) => {
  const row = db
    .select({
      subnet: server.machine_subnet,
      registry: server.registry_subnet,
    })
    .from(server)
    .where(eq(server.id, stationId))
    .get()

  if (row?.subnet) {
    return row.subnet
  }

  const pool = readSetting(db, 'ipam.pool')
  const taken = new Set([
    ...db
      .select({
        subnet: ipam_allocation.subnet,
      })
      .from(ipam_allocation)
      .where(eq(ipam_allocation.server_id, stationId))
      .all()
      .map((r) => r.subnet),
    row?.registry,
  ])

  for (const { subnet } of slash24sFrom(pool, networkLayout.firstEnvironmentIndex)) {
    if (taken.has(subnet)) {
      continue
    }

    db.update(server)
      .set({
        machine_subnet: subnet,
      })
      .where(eq(server.id, stationId))
      .run()

    return subnet
  }

  return fail(
    'SUBNET_EXHAUSTED',
    `ipam.pool ${pool} has no free /24 for the machine network on server ${stationId}.`,
    'Delete unused previews on this server.',
    {
      server_id: stationId,
    },
  )
}

export const dispatchVirtualIp = (prefix: string) =>
  hostAt(prefix, networkLayout.dispatchVirtualHost)

export const ensureVirtualIp = (db: Db, appId: string, targetId: string) => {
  const existing = db.select().from(virtual_ip).where(eq(virtual_ip.app_id, appId)).get()

  if (existing) {
    return existing
  }

  const prefix = readSetting(db, 'ipam.virtual_prefix')
  const taken = new Set(
    db
      .select({
        address: virtual_ip.address,
      })
      .from(virtual_ip)
      .all()
      .map((r) => r.address),
  )

  for (let n = networkLayout.firstServiceVirtualHost; n < 65534; n++) {
    const address = hostAt(prefix, n)

    if ((n & 255) === 0 || (n & 255) === 255 || taken.has(address)) {
      continue
    }

    return db
      .insert(virtual_ip)
      .values({
        app_id: appId,
        target_id: targetId,
        address,
      })
      .returning()
      .get()
  }

  return fail(
    'SUBNET_EXHAUSTED',
    `ipam.virtual_prefix ${prefix} has no free address left; virtual IPs are unique across the instance.`,
    'Delete unused apps or previews.',
    {
      target_id: targetId,
    },
  )
}
