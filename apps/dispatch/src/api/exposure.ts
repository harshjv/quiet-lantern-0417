import { eq } from 'drizzle-orm'

import { gatewayHostAlias } from '@stationly/protocol'

import type { Db } from '../db/client.ts'
import { server } from '../db/schema.ts'
import { readSetting } from '../db/settings.ts'
import { effectivePins, readLockfile } from '../platform/lockfile.ts'

import { fail } from './errors.ts'

export const generatedHostname = (db: Db, appName: string, targetName: string) => {
  const zone = readSetting(db, 'domains.zone')

  return zone ? `${appName}-${targetName}.${zone}` : null
}

export const tunnelRouteOf = (db: Db, hostname: string) => {
  const zone = readSetting(db, 'domains.zone')

  return zone && hostname.endsWith(`.${zone}`)
    ? null
    : {
        hostname,
        service: `http://${gatewayHostAlias}`,
      }
}

export const requireGatewayPin = (db: Db, stationId: string) => {
  const arch = db
    .select({
      arch: server.arch,
    })
    .from(server)
    .where(eq(server.id, stationId))
    .get()?.arch
  const lockfile = readLockfile(db)

  if (effectivePins(db, arch).gateway?.digest) {
    return
  }

  fail(
    'GATEWAY_NOT_PINNED',
    lockfile
      ? `The lockfile pins release ${lockfile.release}, which has no gateway component, so no Gateway runs on this server and a domain would never be served.`
      : 'No lockfile is written yet, so no Gateway runs on this server and a domain would never be served.',
    lockfile
      ? 'Upgrade to a release that pins the Gateway (sly platform upgrade --version <release>), then add the domain.'
      : 'Run sly setup on the server host first, then add the domain.',
    {
      release: lockfile?.release ?? null,
      server_id: stationId,
    },
  )
}
