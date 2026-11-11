import { and, eq, inArray, isNull, ne } from 'drizzle-orm'

import type { LockfileDoc, SettingKey } from '@stationly/protocol'

import type { Db } from '../db/client.ts'
import { newId } from '../db/ids.ts'
import {
  domain,
  environment,
  ipam_allocation,
  port_allocation,
  run,
  sandbox,
  sandbox_snapshot,
  secret_value,
  service,
  service_port,
  staged_change,
  staged_value,
  variable,
  virtual_ip,
  volume,
} from '../db/schema.ts'
import { deleteSetting, storedSetting, writeSetting } from '../db/settings.ts'
import { startUpgrade } from '../platform/upgrade.ts'
import { requestDeletion, systemActor } from '../sandboxes/lifecycle.ts'
import { setVariable, type VariableWrite } from '../secrets/variables.ts'
import type { BackupTarget } from '../volumes/backups.ts'

import { audit, emit, type Call, type Deps } from './context.ts'
import { configFields, createDeploymentRecord, type TriggerType } from './deployments.ts'
import { createService, createServicePort, createVolume } from './entities.ts'
import { fail } from './errors.ts'
import { ensureNetwork } from './ipam.ts'
import type { EnvironmentRow, StagedRow } from './lookup.ts'
import { refreshStale, settleVariableWrites } from './stale.ts'
import { applyStationField, stationFields, type StationField } from './station-fields.ts'

export type Store = Pick<Deps, 'db' | 'keyring'>

export type Entity =
  | 'sandbox_storage'
  | 'service'
  | 'service_port'
  | 'volume'
  | 'volume_snapshot'
  | 'volume_restore'
  | 'domain'
  | 'port_allocation'
  | 'variable'
  | 'deployment'
  | 'environment'
  | 'setting'
  | 'run'
  | 'network_probe'
  | 'lockfile'
  | 'station'

type Json = Record<string, unknown>

export type AddChange = {
  op: 'add'
  entity: Entity
  ref: string
  parent: string | null
  after: Json
  before: null
}
export type UpdateChange = {
  op: 'update'
  entity: Entity
  id: string
  path: string
  before: unknown
  after: unknown
}
export type RemoveChange = { op: 'remove'; entity: Entity; id: string; before: Json; after: null }
export type Change = AddChange | UpdateChange | RemoveChange

export const isRef = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith('new:')

export class ChangeSet {
  private readonly removes: RemoveChange[] = []
  private readonly adds: AddChange[] = []
  private readonly updates: UpdateChange[] = []
  private readonly deploys: AddChange[] = []
  private readonly counters = new Map<Entity, number>()
  readonly values = new Map<string, string>()

  private nextRef(entity: Entity) {
    const n = (this.counters.get(entity) ?? 0) + 1

    this.counters.set(entity, n)

    return `new:${entity}:${n}`
  }

  add(entity: Exclude<Entity, 'deployment'>, parent: string | null, after: Json) {
    const ref = this.nextRef(entity)

    this.adds.push({
      op: 'add',
      entity,
      ref,
      parent,
      after,
      before: null,
    })

    return ref
  }

  update(entity: Entity, id: string, path: string, before: unknown, after: unknown) {
    this.updates.push({
      op: 'update',
      entity,
      id,
      path,
      before,
      after,
    })
  }

  remove(entity: Entity, id: string, before: Json) {
    this.removes.push({
      op: 'remove',
      entity,
      id,
      before,
      after: null,
    })
  }

  deploy(parent: string, trigger: TriggerType, extra: Json = {}) {
    if (this.deploys.some((d) => d.parent === parent)) {
      return
    }

    this.deploys.push({
      op: 'add',
      entity: 'deployment',
      ref: this.nextRef('deployment'),
      parent,
      after: {
        trigger: {
          type: trigger,
        },
        ...extra,
      },
      before: null,
    })
  }

  hasDeployFor(parent: string) {
    return this.deploys.some((d) => d.parent === parent)
  }

  secret(plaintext: string) {
    const id = newId('secret_value')

    this.values.set(id, plaintext)

    return id
  }

  get changes(): Change[] {
    return [...this.removes, ...this.adds, ...this.updates, ...this.deploys]
  }

  get empty() {
    return this.changes.length === 0
  }
}

export const leafDiff = (
  set: ChangeSet,
  entity: Entity,
  id: string,
  path: string,
  before: unknown,
  after: unknown,
) => {
  if (
    before !== null &&
    after !== null &&
    typeof before === 'object' &&
    typeof after === 'object' &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])

    for (const key of keys) {
      leafDiff(
        set,
        entity,
        id,
        `${path}/${key}`,
        (before as Json)[key] ?? null,
        (after as Json)[key] ?? null,
      )
    }

    return
  }

  if (JSON.stringify(before ?? null) !== JSON.stringify(after ?? null)) {
    set.update(entity, id, path, before ?? null, after ?? null)
  }
}

const setPointer = (target: Json, path: string, value: unknown) => {
  const parts = path.split('/').slice(1)

  if (parts.length === 1) {
    target[parts[0]!] = value

    return
  }

  const [head, ...rest] = parts
  const inner = {
    ...(target[head!] as Json | null),
  }

  setPointer(inner, `/${rest.join('/')}`, value)
  target[head!] = inner
}

const retention = (env: EnvironmentRow | undefined) =>
  new Date(Date.now() + (env?.ephemeral ? 24 : 7 * 24) * 3600 * 1000)

const serviceColumns = new Set<string>([...configFields, 'desired_state', 'status'])

const portDependents = (db: Db, portId: string) => ({
  domains: db
    .select({
      id: domain.id,
      hostname: domain.hostname,
    })
    .from(domain)
    .where(eq(domain.service_port_id, portId))
    .all()
    .map((d) => ({
      entity: 'domain',
      id: d.id,
      hostname: d.hostname,
    })),
  allocations: db
    .select({
      id: port_allocation.id,
      host_port: port_allocation.host_port,
    })
    .from(port_allocation)
    .where(and(eq(port_allocation.service_port_id, portId), eq(port_allocation.status, 'active')))
    .all()
    .map((a) => ({
      entity: 'port_allocation',
      id: a.id,
      host_port: a.host_port,
    })),
})

const portNumber = (db: Db, portId: string) =>
  db
    .select({
      port: service_port.port,
    })
    .from(service_port)
    .where(eq(service_port.id, portId))
    .get()?.port ?? portId

export const requireNoPortDependents = (db: Db, portId: string) => {
  const { domains, allocations } = portDependents(db, portId)

  if (!domains.length && !allocations.length) {
    return
  }

  fail(
    'DELETE_HAS_DEPENDENTS',
    `Port ${portNumber(db, portId)} is used by a domain or a TCP exposure.`,
    'Remove the domains and port allocations first.',
    {
      dependents: [...domains, ...allocations],
    },
  )
}

export const requireProtocolChangeAllowed = (db: Db, portId: string, protocol: 'http' | 'tcp') => {
  const { domains, allocations } = portDependents(db, portId)
  const blocking = protocol === 'tcp' ? domains : allocations

  if (!blocking.length) {
    return
  }

  const port = portNumber(db, portId)

  if (protocol === 'tcp') {
    fail(
      'DELETE_HAS_DEPENDENTS',
      `Port ${port} cannot become tcp while a domain routes to it.`,
      'Remove its domains (DELETE /v1/domains/{id}) first, then change the protocol.',
      {
        dependents: blocking,
      },
    )
  }

  fail(
    'DELETE_HAS_DEPENDENTS',
    `Port ${port} cannot become http while a TCP exposure publishes it.`,
    'Remove its port allocations (DELETE /v1/port-allocations/{id}) first, then change the protocol.',
    {
      dependents: blocking,
    },
  )
}

const removePort = (db: Db, portId: string) => {
  requireNoPortDependents(db, portId)
  db.delete(port_allocation)
    .where(and(eq(port_allocation.service_port_id, portId), eq(port_allocation.status, 'removed')))
    .run()
  db.delete(service_port).where(eq(service_port.id, portId)).run()
}

const removeService = (db: Db, serviceId: string) => {
  const svc = db.select().from(service).where(eq(service.id, serviceId)).get()

  if (!svc) {
    return fail('NOT_FOUND', `service ${serviceId} does not exist.`)
  }

  const env = db.select().from(environment).where(eq(environment.id, svc.environment_id)).get()
  const ports = db
    .select({
      id: service_port.id,
    })
    .from(service_port)
    .where(eq(service_port.service_id, svc.id))
    .all()
    .map((p) => p.id)

  if (ports.length) {
    db.delete(domain).where(inArray(domain.service_port_id, ports)).run()
    db.delete(port_allocation).where(inArray(port_allocation.service_port_id, ports)).run()
    db.delete(service_port).where(eq(service_port.service_id, svc.id)).run()
  }

  const retainUntil = retention(env)

  db.update(volume)
    .set({
      status: 'retained',
      retain_until: retainUntil,
      service_id: null,
    })
    .where(and(eq(volume.service_id, svc.id), eq(volume.owner, 'service')))
    .run()
  const vars = db
    .select({
      id: variable.id,
    })
    .from(variable)
    .where(eq(variable.service_id, svc.id))
    .all()
    .map((v) => v.id)

  if (vars.length) {
    db.delete(secret_value).where(inArray(secret_value.variable_id, vars)).run()
    db.delete(variable).where(inArray(variable.id, vars)).run()
  }

  db.delete(virtual_ip).where(eq(virtual_ip.service_id, svc.id)).run()
  db.delete(service).where(eq(service.id, svc.id)).run()

  return retainUntil
}

export const requireNoSandboxes = (
  db: Db,
  env: { id: string; name: string; ephemeral: boolean },
) => {
  const boxes = db
    .select({
      id: sandbox.id,
      name: sandbox.name,
    })
    .from(sandbox)
    .where(and(eq(sandbox.environment_id, env.id), ne(sandbox.status, 'deleting')))
    .all()

  if (boxes.length && !env.ephemeral) {
    fail(
      'DELETE_HAS_DEPENDENTS',
      `Environment ${env.name} still holds ${boxes.length} sandboxes.`,
      'Delete its sandboxes first; an ephemeral environment deletes them with itself.',
      {
        dependents: boxes.map((b) => ({
          entity: 'sandbox',
          ...b,
        })),
      },
    )
  }
}

export const removeEnvironment = (db: Db, environmentId: string) => {
  const env = db.select().from(environment).where(eq(environment.id, environmentId)).get()

  if (!env) {
    return fail('NOT_FOUND', `environment ${environmentId} does not exist.`)
  }

  requireNoSandboxes(db, env)

  for (const box of db.select().from(sandbox).where(eq(sandbox.environment_id, env.id)).all()) {
    requestDeletion(db, box, {
      actor: systemActor,
      reason: 'environment',
    })
  }

  db.update(sandbox_snapshot)
    .set({
      status: 'deleting',
    })
    .where(and(eq(sandbox_snapshot.environment_id, env.id), ne(sandbox_snapshot.status, 'failed')))
    .run()
  db.delete(sandbox_snapshot)
    .where(and(eq(sandbox_snapshot.environment_id, env.id), eq(sandbox_snapshot.status, 'failed')))
    .run()
  let retainUntil: Date | null = null

  for (const svc of db
    .select({
      id: service.id,
    })
    .from(service)
    .where(eq(service.environment_id, env.id))
    .all()) {
    retainUntil = removeService(db, svc.id)
  }

  db.delete(ipam_allocation).where(eq(ipam_allocation.environment_id, env.id)).run()
  db.delete(virtual_ip).where(eq(virtual_ip.environment_id, env.id)).run()
  db.delete(secret_value).where(eq(secret_value.environment_id, env.id)).run()
  db.delete(environment).where(eq(environment.id, env.id)).run()

  return retainUntil
}

export type StagedBackup = { volume_id: string; target: BackupTarget; quiesce: boolean }

export type StagedRestore = { volume_id: string; snapshot_id: string; station_id?: string }

export type StagedGrow = { station_id: string; size_bytes: number }

export type StagedProbe = {
  service_id: string
  kind: 'tcp' | 'dns'
  to: string
  port: number | null
  timeout_s: number
}

type ApplyResult = {
  refs: Record<string, string>
  deployments: string[]
  retained_until: Date | null
  lockfile: { before: LockfileDoc; after: LockfileDoc } | null
  backups: StagedBackup[]
  restores: StagedRestore[]
  probes: StagedProbe[]
  grows: StagedGrow[]
}

const applyChanges = (
  deps: Store,
  call: Call,
  changes: Change[],
  plaintext: (valueId: string) => string,
): ApplyResult => {
  const { db, keyring } = deps
  const refs: Record<string, string> = {}
  const deployments: string[] = []
  const backups: StagedBackup[] = []
  const restores: StagedRestore[] = []
  const probes: StagedProbe[] = []
  const grows: StagedGrow[] = []
  let retained_until: Date | null = null
  const resolve = (value: string) =>
    refs[value] ??
    (isRef(value)
      ? fail('VALIDATION_FAILED', `${value} is not defined earlier in this change.`)
      : value)
  const resolveAll = (after: Json) =>
    Object.fromEntries(Object.entries(after).map(([k, v]) => [k, isRef(v) ? resolve(v) : v]))
  let variablesChanged = false
  const writes: VariableWrite[] = []
  const touched = new Set<string>()
  let lockfileBefore: LockfileDoc | null = null

  for (const change of changes) {
    if (change.op === 'add') {
      const parent = change.parent === null ? null : resolve(change.parent)
      const after = resolveAll(change.after)

      switch (change.entity) {
        case 'service': {
          refs[change.ref] = createService(db, {
            environment_id: parent!,
            name: after.name as string,
            kind: after.kind as 'web' | 'worker' | 'cron' | 'one_off',
            station_id: after.station_id as string,
            source: after.source as Json,
            command: (after.command as string[] | null) ?? null,
            build_args: (after.build_args as Record<string, string> | null) ?? null,
            limits: after.limits as { cpu_millis: number; memory_bytes: number },
            health: (after.health as Json | null) ?? null,
            strategy: after.strategy as 'overlap' | 'replace',
            multi_writer_safe: Boolean(after.multi_writer_safe),
            drain_timeout_s: (after.drain_timeout_s as number | undefined) ?? 30,
            readonly_rootfs: Boolean(after.readonly_rootfs),
            secrets_owner: (after.secrets_owner as { uid: number; gid: number } | null) ?? null,
            pre_deploy: (after.pre_deploy as string[] | null) ?? null,
            schedule:
              (after.schedule as {
                cron: string
                timezone: string
                concurrency: 'skip' | 'allow'
              } | null) ?? null,
            desired_state: (after.desired_state as 'running' | 'stopped' | undefined) ?? 'running',
          })
          break
        }

        case 'service_port': {
          refs[change.ref] = createServicePort(db, parent!, {
            port: after.port as number,
            protocol: after.protocol as 'http' | 'tcp',
            grpc: Boolean(after.grpc),
          })
          break
        }

        case 'volume': {
          const owner =
            db.select().from(service).where(eq(service.id, parent!)).get() ??
            fail('NOT_FOUND', `service ${parent} does not exist.`)
          const env = db
            .select()
            .from(environment)
            .where(eq(environment.id, owner.environment_id))
            .get()!

          refs[change.ref] = createVolume(
            db,
            {
              id: owner.id,
              station_id: owner.station_id,
              project_id: env.project_id,
            },
            after.mount_path as string,
          )
          break
        }

        case 'domain': {
          const id = newId('domain')

          db.insert(domain)
            .values({
              id,
              service_port_id: parent!,
              hostname: after.hostname as string,
              kind: after.kind as 'generated' | 'custom',
              ingress: after.ingress as 'direct' | 'tunnel',
              certificate: {
                resolver: 'letsencrypt',
                status: 'pending',
                not_before: null,
                expires_at: null,
              },
            })
            .run()
          refs[change.ref] = id
          break
        }

        case 'port_allocation': {
          const id = newId('port_allocation')

          db.insert(port_allocation)
            .values({
              id,
              service_port_id: parent!,
              station_id: after.station_id as string,
              host_port: after.host_port as number,
            })
            .run()
          refs[change.ref] = id
          break
        }

        case 'variable': {
          const scope = after.scope as 'global' | 'project' | 'service' | 'sandbox'
          const kind = after.kind as 'literal' | 'reference' | 'sealed'
          const value =
            typeof after.value_id === 'string'
              ? plaintext(after.value_id)
              : ((after.reference as string | null) ?? '')
          const result = setVariable(db, keyring, {
            scope,
            project_id: scope === 'project' ? parent! : undefined,
            service_id: scope === 'service' ? parent! : undefined,
            sandbox_id: scope === 'sandbox' ? parent! : undefined,
            environment_id: (after.environment_id as string | null | undefined) ?? null,
            key: after.key as string,
            value,
            sealed: kind === 'sealed',
            injection: after.injection as 'env' | 'file' | undefined,
            build: after.build as boolean | undefined,
            allow_unresolved: Boolean(after.allow_unresolved),
            actor: call.principal.actor,
            request_id: call.request_id,
          })

          refs[change.ref] = result.variable_id

          if (result.write) {
            writes.push(result.write)
          }

          variablesChanged = true
          break
        }

        case 'deployment': {
          const created = createDeploymentRecord(db, {
            service_id: parent!,
            trigger: (after.trigger as { type: TriggerType }).type,
            actor: call.principal.actor,
            supersede: Boolean(after.supersede),
            source_sha: (after.source_sha as string | undefined) ?? null,
            image: (after.image as string | undefined) ?? null,
            blob_id: (after.blob_id as string | undefined) ?? null,
            rebuild: after.reason === 'rebuild',
            pin_env: after.reason === 'restart',
            rollback_of: (after.rollback_of as string | undefined) ?? null,
          })

          refs[change.ref] = created.id
          deployments.push(created.id)
          touched.add(parent!)
          break
        }

        case 'run': {
          const owner =
            db.select().from(service).where(eq(service.id, parent!)).get() ??
            fail('NOT_FOUND', `service ${parent} does not exist.`)

          if (!owner.current_deployment_id) {
            fail(
              'NO_CURRENT_DEPLOYMENT',
              `${owner.name} has no current deployment to run the command in.`,
              'Deploy the service first.',
            )
          }

          const id = newId('run')

          db.insert(run)
            .values({
              id,
              service_id: owner.id,
              deployment_id: owner.current_deployment_id,
              kind: (after.kind as 'one_off' | 'shell' | undefined) ?? 'one_off',
              command: (after.command as string[] | undefined) ?? [],
              status: 'queued',
              log_ref: `logs/${owner.id}/${owner.current_deployment_id}/${id}`,
              tty: Boolean(after.tty),
              actor: call.principal.actor,
            })
            .run()
          refs[change.ref] = id
          break
        }

        case 'network_probe': {
          const owner =
            db
              .select({
                id: service.id,
              })
              .from(service)
              .where(eq(service.id, parent!))
              .get() ?? fail('NOT_FOUND', `service ${parent} does not exist.`)

          probes.push({
            service_id: owner.id,
            kind: after.kind === 'dns' ? 'dns' : 'tcp',
            to: String(after.to),
            port: typeof after.port === 'number' ? after.port : null,
            timeout_s: Number(after.timeout_s),
          })
          break
        }

        case 'sandbox_storage':
          grows.push({
            station_id: parent!,
            size_bytes: Number(after.size_bytes),
          })
          break

        case 'volume_snapshot': {
          const vol =
            db.select().from(volume).where(eq(volume.id, parent!)).get() ??
            fail('NOT_FOUND', `volume ${parent} does not exist.`)

          backups.push({
            volume_id: vol.id,
            target: after.target as StagedBackup['target'],
            quiesce: after.quiesce !== false,
          })
          break
        }

        case 'volume_restore': {
          const vol =
            db.select().from(volume).where(eq(volume.id, parent!)).get() ??
            fail('NOT_FOUND', `volume ${parent} does not exist.`)

          restores.push({
            volume_id: vol.id,
            snapshot_id: after.snapshot_id as string,
            ...(typeof after.station_id === 'string'
              ? {
                  station_id: after.station_id,
                }
              : {}),
          })
          break
        }

        default:
          fail(
            'VALIDATION_FAILED',
            `adding ${change.entity} through a staged change is not supported.`,
          )
      }

      continue
    }

    const id = resolve(change.id)

    if (change.op === 'update') {
      switch (change.entity) {
        case 'service': {
          const row =
            db.select().from(service).where(eq(service.id, id)).get() ??
            fail('NOT_FOUND', `service ${id} does not exist.`)
          const column = change.path.split('/')[1]!

          if (!serviceColumns.has(column)) {
            fail(
              'VALIDATION_FAILED',
              `service field ${column} cannot change through a staged change.`,
            )
          }

          const holder: Json = {
            [column]: (row as Json)[column],
          }

          setPointer(holder, change.path, change.after)
          const update: Json = {
            [column]: holder[column],
          }

          if (column === 'desired_state') {
            update.status = change.after === 'stopped' ? 'stopped' : 'amber'
          }

          db.update(service).set(update).where(eq(service.id, id)).run()
          touched.add(id)

          if (column === 'station_id') {
            ensureNetwork(db, row.environment_id, change.after as string)
          }

          break
        }

        case 'service_port':
          if (change.path === '/grpc') {
            db.update(service_port)
              .set({
                grpc: Boolean(change.after),
              })
              .where(eq(service_port.id, id))
              .run()
          } else if (change.path === '/protocol') {
            const protocol = change.after === 'tcp' ? 'tcp' : 'http'

            requireProtocolChangeAllowed(db, id, protocol)
            db.update(service_port)
              .set({
                protocol,
              })
              .where(eq(service_port.id, id))
              .run()
          } else {
            fail(
              'VALIDATION_FAILED',
              `service_port field ${change.path.slice(1)} cannot change in place.`,
              'Remove the port and add it again.',
              {
                issues: [
                  {
                    path: change.path,
                    message: 'cannot change in place',
                  },
                ],
              },
            )
          }

          break

        case 'volume': {
          const column = change.path.slice(1)
          const value =
            column === 'retain_until' && typeof change.after === 'string'
              ? new Date(change.after)
              : isRef(change.after)
                ? resolve(change.after)
                : change.after

          db.update(volume)
            .set({
              [column]: value,
            })
            .where(eq(volume.id, id))
            .run()
          break
        }

        case 'port_allocation':
          db.update(port_allocation)
            .set({
              status: change.after as 'active' | 'removed',
            })
            .where(eq(port_allocation.id, id))
            .run()
          break

        case 'variable': {
          const row =
            db.select().from(variable).where(eq(variable.id, id)).get() ??
            fail('NOT_FOUND', `variable ${id} does not exist.`)
          const after = change.after as Json
          const kind = after.kind as 'literal' | 'reference' | 'sealed'

          if (kind === 'sealed' && typeof after.value_id !== 'string' && !after.reference) {
            db.update(variable)
              .set({
                injection: (after.injection as 'env' | 'file' | undefined) ?? row.injection,
                build: (after.build as boolean | undefined) ?? row.build,
              })
              .where(eq(variable.id, id))
              .run()
            variablesChanged = true
            break
          }

          const value =
            typeof after.value_id === 'string'
              ? plaintext(after.value_id)
              : ((after.reference as string | null) ?? '')
          const result = setVariable(db, keyring, {
            scope: row.scope,
            project_id: row.project_id ?? undefined,
            service_id: row.service_id ?? undefined,
            sandbox_id: row.sandbox_id ?? undefined,
            environment_id: (after.environment_id as string | null | undefined) ?? null,
            key: row.key,
            value,
            sealed: kind === 'sealed',
            injection: after.injection as 'env' | 'file' | undefined,
            build: after.build as boolean | undefined,
            allow_unresolved: Boolean(after.allow_unresolved),
            actor: call.principal.actor,
            request_id: call.request_id,
          })

          if (result.write) {
            writes.push(result.write)
          }

          variablesChanged = true
          break
        }

        case 'setting': {
          if (change.after === null) {
            deleteSetting(db, id as SettingKey)
          } else {
            writeSetting(db, id as SettingKey, change.after, call.principal.actor)
          }

          break
        }

        case 'lockfile': {
          const stored = storedSetting(db, 'platform.lockfile')

          if (stored === undefined) {
            fail(
              'VALIDATION_FAILED',
              'There is no platform.lockfile to change; install a release first.',
            )
          }

          lockfileBefore ??= structuredClone(stored!)
          let value = structuredClone(stored!) as Json

          if (change.path === '/') {
            value = structuredClone(change.after) as Json
          } else {
            const overrides = {
              ...(value.overrides as Json | undefined),
            }
            const name = change.path.replace(/^\/overrides\//, '')

            if (change.after === null) {
              delete overrides[name]
            } else {
              overrides[name] = change.after
            }

            value.overrides = overrides
          }

          value.updated_at = new Date().toISOString().replace(/\.\d+Z$/, 'Z')
          writeSetting(db, 'platform.lockfile', value, call.principal.actor)
          break
        }

        case 'environment':
          db.update(environment)
            .set({
              [change.path.slice(1)]: change.after,
            })
            .where(eq(environment.id, id))
            .run()
          break

        case 'station': {
          const field = change.path.slice(1)

          if (!(stationFields as readonly string[]).includes(field)) {
            fail(
              'VALIDATION_FAILED',
              `station field ${field} cannot change through a staged change.`,
            )
          }

          applyStationField(db, id, field as StationField, change.after)
          break
        }

        default:
          fail(
            'VALIDATION_FAILED',
            `updating ${change.entity} through a staged change is not supported.`,
          )
      }

      continue
    }

    switch (change.entity) {
      case 'service':
        retained_until = removeService(db, id)
        break
      case 'environment':
        retained_until = removeEnvironment(db, id)
        break
      case 'service_port':
        removePort(db, id)
        break
      case 'domain':
        db.delete(domain).where(eq(domain.id, id)).run()
        break
      case 'variable':
        db.delete(secret_value).where(eq(secret_value.variable_id, id)).run()
        db.delete(variable).where(eq(variable.id, id)).run()
        variablesChanged = true
        break
      default:
        fail(
          'VALIDATION_FAILED',
          `removing ${change.entity} through a staged change is not supported.`,
        )
    }
  }

  if (variablesChanged) {
    settleVariableWrites(db, writes)
  } else {
    refreshStale(db, [...touched])
  }

  const lockfile = lockfileBefore
    ? {
        before: lockfileBefore,
        after: storedSetting(db, 'platform.lockfile')!,
      }
    : null

  return {
    refs,
    deployments,
    retained_until,
    lockfile,
    backups,
    restores,
    probes,
    grows,
  }
}

export const stripValues = (changes: Change[]) =>
  changes.map((change) => {
    if (change.entity !== 'variable' || change.op === 'remove') {
      return change
    }

    const { value_id: _v, allow_unresolved: _a, ...after } = (change.after ?? {}) as Json

    return {
      ...change,
      after,
    }
  })

const overlapKeys = (changes: Change[]) =>
  new Set(
    changes.flatMap((change) => {
      if (change.op !== 'add') {
        return [`id:${change.id}`]
      }

      if (change.entity === 'network_probe') {
        return []
      }

      if (change.entity === 'deployment') {
        return isRef(change.parent) ? [] : [`deploy:${change.parent}`]
      }

      const name = (change.after.name ??
        change.after.key ??
        change.after.hostname ??
        change.after.port ??
        change.after.mount_path) as string | undefined

      return isRef(change.parent) || name === undefined
        ? []
        : [`add:${change.entity}:${change.parent}:${name}`]
    }),
  )

export type CommitOptions = {
  environment: EnvironmentRow | null
  protect: boolean
  source?: 'api' | 'manifest' | 'agent' | 'ui'
  station?: string | null
}

export type CommitResult =
  | { applied: false; staged: StagedRow }
  | {
      applied: true
      staged: StagedRow
      refs: Record<string, string>
      deployments: string[]
      retained_until: Date | null
      upgrade: string | null
    }

export const commit = (
  deps: Store,
  call: Call,
  options: CommitOptions,
  set: ChangeSet,
): CommitResult => {
  const { db, keyring } = deps
  const changes = set.changes
  const source = options.source ?? (call.principal.human ? 'ui' : 'api')
  const environmentId = options.environment?.id ?? null

  if (options.protect) {
    return db.transaction((tx) => {
      const tdb = tx as unknown as Db
      const id = newId('staged_change')

      tdb
        .insert(staged_change)
        .values({
          id,
          environment_id: environmentId,
          actor: call.principal.actor,
          changes,
          refs: options.station
            ? {
                'platform.station': options.station,
              }
            : {},
          source,
          status: 'staged',
          deployments: [],
        })
        .run()

      for (const [valueId, plaintext] of set.values) {
        tdb
          .insert(staged_value)
          .values({
            id: valueId,
            staged_change_id: id,
            ...keyring.encrypt(valueId, plaintext),
          })
          .run()
      }

      const mine = overlapKeys(changes)
      const older = tdb
        .select()
        .from(staged_change)
        .where(
          and(
            environmentId === null
              ? isNull(staged_change.environment_id)
              : eq(staged_change.environment_id, environmentId),
            eq(staged_change.status, 'staged'),
          ),
        )
        .all()
        .filter(
          (row) =>
            row.id !== id && [...overlapKeys(row.changes as Change[])].some((key) => mine.has(key)),
        )

      for (const row of older) {
        tdb
          .update(staged_change)
          .set({
            status: 'superseded',
          })
          .where(eq(staged_change.id, row.id))
          .run()
        tdb.delete(staged_value).where(eq(staged_value.staged_change_id, row.id)).run()
      }

      audit(
        tdb,
        call,
        'staged_change.create',
        {
          entity: 'staged_change',
          id,
        },
        {
          after: {
            environment_id: environmentId,
            entries: changes.length,
            superseded: older.map((o) => o.id),
          },
        },
      )
      emit(
        tdb,
        'staged_change.created',
        {
          entity: 'staged_change',
          id,
          environment_id: environmentId,
        },
        {
          superseded: older.map((o) => o.id),
        },
      )

      return {
        applied: false as const,
        staged: tdb.select().from(staged_change).where(eq(staged_change.id, id)).get()!,
      }
    })
  }

  return db.transaction((tx) => {
    const tdb = tx as unknown as Db
    const result = applyChanges(
      {
        ...deps,
        db: tdb,
      },
      call,
      changes,
      (valueId) =>
        set.values.get(valueId) ?? fail('VALIDATION_FAILED', `value ${valueId} is missing.`),
    )
    const id = newId('staged_change')

    tdb
      .insert(staged_change)
      .values({
        id,
        environment_id: environmentId,
        actor: call.principal.actor,
        changes: stripValues(changes),
        refs: result.refs,
        source,
        status: 'accepted',
        accepted_by: call.principal.actor,
        deployments: result.deployments,
      })
      .run()
    const upgrade = result.lockfile
      ? startUpgrade(tdb, {
          stagedChangeId: id,
          actor: call.principal.actor,
          before: result.lockfile.before,
          after: result.lockfile.after,
          station: options.station ?? null,
        })
      : null

    return {
      applied: true as const,
      upgrade,
      staged: tdb.select().from(staged_change).where(eq(staged_change.id, id)).get()!,
      ...result,
    }
  })
}

export const acceptStaged = (deps: Store, call: Call, row: StagedRow) => {
  const { db, keyring } = deps

  if (row.status === 'superseded') {
    fail(
      'STAGED_CHANGE_SUPERSEDED',
      `Staged change ${row.id} was replaced by a newer one.`,
      'Read the newer staged change and accept that one.',
    )
  }

  if (row.status !== 'staged') {
    fail('VALIDATION_FAILED', `Staged change ${row.id} is ${row.status}, not staged.`, undefined, {
      issues: [
        {
          path: '/status',
          message: row.status,
        },
      ],
    })
  }

  return db.transaction((tx) => {
    const tdb = tx as unknown as Db
    const values = new Map(
      tdb
        .select()
        .from(staged_value)
        .where(eq(staged_value.staged_change_id, row.id))
        .all()
        .map((v) => [v.id, v]),
    )
    const plaintext = (valueId: string) => {
      const stored =
        values.get(valueId) ?? fail('VALIDATION_FAILED', `staged value ${valueId} is missing.`)

      return keyring.decrypt(stored.id, stored.data_key_id, stored.ciphertext)
    }
    const result = applyChanges(
      {
        ...deps,
        db: tdb,
      },
      call,
      row.changes as Change[],
      plaintext,
    )

    tdb.delete(staged_value).where(eq(staged_value.staged_change_id, row.id)).run()
    tdb
      .update(staged_change)
      .set({
        status: 'accepted',
        accepted_by: call.principal.actor,
        refs: result.refs,
        deployments: result.deployments,
        changes: stripValues(row.changes as Change[]),
      })
      .where(eq(staged_change.id, row.id))
      .run()
    const upgrade = result.lockfile
      ? startUpgrade(tdb, {
          stagedChangeId: row.id,
          actor: row.actor,
          before: result.lockfile.before,
          after: result.lockfile.after,
          station: (row.refs as Record<string, string> | null)?.['platform.station'] ?? null,
        })
      : null

    audit(
      tdb,
      call,
      'staged_change.accept',
      {
        entity: 'staged_change',
        id: row.id,
      },
      {
        after: {
          refs: result.refs,
          deployments: result.deployments,
          upgrade,
        },
      },
    )
    emit(
      tdb,
      'staged_change.accepted',
      {
        entity: 'staged_change',
        id: row.id,
        environment_id: row.environment_id,
      },
      {
        deployments: result.deployments,
      },
    )

    return {
      staged: tdb.select().from(staged_change).where(eq(staged_change.id, row.id)).get()!,
      ...result,
      upgrade,
    }
  })
}

export const rejectStaged = (deps: Store, call: Call, row: StagedRow, reason: string | null) => {
  const { db } = deps

  if (row.status === 'superseded') {
    fail('STAGED_CHANGE_SUPERSEDED', `Staged change ${row.id} was replaced by a newer one.`)
  }

  if (row.status !== 'staged') {
    fail('VALIDATION_FAILED', `Staged change ${row.id} is ${row.status}, not staged.`)
  }

  return db.transaction((tx) => {
    const tdb = tx as unknown as Db

    tdb.delete(staged_value).where(eq(staged_value.staged_change_id, row.id)).run()
    tdb
      .update(staged_change)
      .set({
        status: 'rejected',
        accepted_by: call.principal.actor,
      })
      .where(eq(staged_change.id, row.id))
      .run()
    audit(
      tdb,
      call,
      'staged_change.reject',
      {
        entity: 'staged_change',
        id: row.id,
      },
      {
        after: {
          reason,
        },
      },
    )
    emit(
      tdb,
      'staged_change.rejected',
      {
        entity: 'staged_change',
        id: row.id,
        environment_id: row.environment_id,
      },
      {
        reason,
      },
    )

    return tdb.select().from(staged_change).where(eq(staged_change.id, row.id)).get()!
  })
}
