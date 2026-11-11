import { volumeDockerName } from '@stationly/protocol'

import type { Db } from '../db/client.ts'
import { newId } from '../db/ids.ts'
import { service, service_port, volume } from '../db/schema.ts'

import { ensureNetwork, ensureVirtualIp } from './ipam.ts'

type ServiceInsert = typeof service.$inferInsert
type PortInsert = typeof service_port.$inferInsert

const exportNames = (kind: string) => (kind === 'web' ? ['HOST', 'PORT', 'URL'] : ['HOST', 'PORT'])

export const createService = (db: Db, values: Omit<ServiceInsert, 'id' | 'exports' | 'status'>) => {
  const id = newId('service')

  db.insert(service)
    .values({
      ...values,
      id,
      exports: exportNames(values.kind),
      status: values.desired_state === 'stopped' ? 'stopped' : 'amber',
    })
    .run()
  ensureNetwork(db, values.environment_id, values.station_id)
  ensureVirtualIp(db, id, values.environment_id)

  return id
}

export const createServicePort = (
  db: Db,
  serviceId: string,
  port: Pick<PortInsert, 'port' | 'protocol' | 'grpc'>,
) => {
  const id = newId('service_port')

  db.insert(service_port)
    .values({
      id,
      service_id: serviceId,
      port: port.port,
      protocol: port.protocol,
      grpc: port.grpc,
    })
    .run()

  return id
}

export const createVolume = (
  db: Db,
  owner: { id: string; station_id: string; project_id: string },
  mountPath: string,
) => {
  const id = newId('volume')

  db.insert(volume)
    .values({
      id,
      owner: 'service',
      service_id: owner.id,
      project_id: owner.project_id,
      mount_path: mountPath,
      station_id: owner.station_id,
      docker_name: volumeDockerName(id),
    })
    .run()

  return id
}
