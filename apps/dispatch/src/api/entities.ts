import { volumeDockerName } from '@stationly/protocol'

import type { Db } from '../db/client.ts'
import { newId } from '../db/ids.ts'
import { app, app_port, volume } from '../db/schema.ts'

import { appStatusOf } from './app-status.ts'
import { ensureNetwork, ensureVirtualIp } from './ipam.ts'

type AppInsert = typeof app.$inferInsert
type PortInsert = typeof app_port.$inferInsert

const exportNames = (kind: string) => (kind === 'web' ? ['HOST', 'PORT', 'URL'] : ['HOST', 'PORT'])

export const createApp = (
  db: Db,
  values: Omit<AppInsert, 'id' | 'exports' | 'status' | 'status_reason'>,
) => {
  const id = newId('app')

  db.insert(app)
    .values({
      ...values,
      id,
      exports: exportNames(values.kind),
      ...appStatusOf(db, {
        id,
        desired_state: values.desired_state ?? 'running',
        server_id: values.server_id,
        current_deployment_id: null,
      }),
    })
    .run()
  ensureNetwork(db, values.target_id, values.server_id)
  ensureVirtualIp(db, id, values.target_id)

  return id
}

export const createAppPort = (
  db: Db,
  appId: string,
  port: Pick<PortInsert, 'port' | 'protocol' | 'grpc'>,
) => {
  const id = newId('app_port')

  db.insert(app_port)
    .values({
      id,
      app_id: appId,
      port: port.port,
      protocol: port.protocol,
      grpc: port.grpc,
    })
    .run()

  return id
}

export const createVolume = (
  db: Db,
  owner: { id: string; server_id: string; project_id: string },
  mountPath: string,
) => {
  const id = newId('volume')

  db.insert(volume)
    .values({
      id,
      owner: 'service',
      app_id: owner.id,
      project_id: owner.project_id,
      mount_path: mountPath,
      server_id: owner.server_id,
      docker_name: volumeDockerName(id),
    })
    .run()

  return id
}
