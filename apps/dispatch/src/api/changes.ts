import { and, eq, inArray, isNull, ne, type SQL } from 'drizzle-orm'

import type { LockfileDoc, SettingKey } from '@stationly/protocol'

import type { Db } from '../db/client.ts'
import { newId } from '../db/ids.ts'
import {
  app,
  app_port,
  approval,
  approval_value,
  domain,
  ipam_allocation,
  key,
  machine,
  machine_snapshot,
  port_allocation,
  run,
  secret_value,
  target,
  virtual_ip,
  volume,
} from '../db/schema.ts'
import { deleteSetting, storedSetting, writeSetting } from '../db/settings.ts'
import { startUpgrade } from '../platform/upgrade.ts'
import { requestDeletion, systemActor } from '../sandboxes/lifecycle.ts'
import { setKey, type KeyWrite } from '../secrets/variables.ts'
import type { BackupTarget } from '../volumes/backups.ts'

import { recordHealth, refreshAppStatus } from './app-status.ts'
import { audit, emit, type Call, type Deps } from './context.ts'
import { configFields, createDeploymentRecord, type TriggerType } from './deployments.ts'
import { createApp, createAppPort, createVolume } from './entities.ts'
import { fail } from './errors.ts'
import { ensureNetwork } from './ipam.ts'
import { placeName, type ApprovalRow, type TargetRow } from './lookup.ts'
import { requesterOf, requireRequesterRule } from './requester.ts'
import { refreshStale, settleKeyWrites } from './stale.ts'
import { applyStationField, stationFields, type StationField } from './station-fields.ts'

export type Store = Pick<Deps, 'db' | 'keyring'>

export type Entity =
  | 'machine_storage'
  | 'app'
  | 'app_port'
  | 'volume'
  | 'volume_snapshot'
  | 'volume_restore'
  | 'domain'
  | 'port_allocation'
  | 'key'
  | 'deployment'
  | 'preview'
  | 'setting'
  | 'run'
  | 'network_probe'
  | 'lockfile'
  | 'server'

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

export const isTransient = (row: TargetRow) =>
  row.expires_at !== null || (row.origin !== null && row.origin.type !== 'named')

const retention = (row: TargetRow | undefined) =>
  new Date(Date.now() + (row && isTransient(row) ? 24 : 7 * 24) * 3600 * 1000)

const appColumns = new Set<string>([...configFields, 'desired_state'])

const portDependents = (db: Db, portId: string) => ({
  domains: db
    .select({
      id: domain.id,
      hostname: domain.hostname,
    })
    .from(domain)
    .where(eq(domain.app_port_id, portId))
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
    .where(and(eq(port_allocation.app_port_id, portId), eq(port_allocation.status, 'active')))
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
      port: app_port.port,
    })
    .from(app_port)
    .where(eq(app_port.id, portId))
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
    .where(and(eq(port_allocation.app_port_id, portId), eq(port_allocation.status, 'removed')))
    .run()
  db.delete(app_port).where(eq(app_port.id, portId)).run()
}

const removeApp = (db: Db, appId: string) => {
  const svc = db.select().from(app).where(eq(app.id, appId)).get()

  if (!svc) {
    return fail('NOT_FOUND', `app ${appId} does not exist.`)
  }

  const env = db.select().from(target).where(eq(target.id, svc.target_id)).get()
  const ports = db
    .select({
      id: app_port.id,
    })
    .from(app_port)
    .where(eq(app_port.app_id, svc.id))
    .all()
    .map((p) => p.id)

  if (ports.length) {
    db.delete(domain).where(inArray(domain.app_port_id, ports)).run()
    db.delete(port_allocation).where(inArray(port_allocation.app_port_id, ports)).run()
    db.delete(app_port).where(eq(app_port.app_id, svc.id)).run()
  }

  const retainUntil = retention(env)

  db.update(volume)
    .set({
      status: 'retained',
      retain_until: retainUntil,
      app_id: null,
    })
    .where(and(eq(volume.app_id, svc.id), eq(volume.owner, 'service')))
    .run()
  const vars = db
    .select({
      id: key.id,
    })
    .from(key)
    .where(eq(key.app_id, svc.id))
    .all()
    .map((v) => v.id)

  if (vars.length) {
    db.delete(secret_value).where(inArray(secret_value.key_id, vars)).run()
    db.delete(key).where(inArray(key.id, vars)).run()
  }

  db.delete(virtual_ip).where(eq(virtual_ip.app_id, svc.id)).run()
  db.delete(app).where(eq(app.id, svc.id)).run()

  return retainUntil
}

export const requireNoMachines = (db: Db, row: TargetRow) => {
  const boxes = db
    .select({
      id: machine.id,
      name: machine.name,
    })
    .from(machine)
    .where(and(eq(machine.target_id, row.id), ne(machine.status, 'deleting')))
    .all()

  if (boxes.length && !isTransient(row)) {
    fail(
      'DELETE_HAS_DEPENDENTS',
      `Preview ${row.name} still holds ${boxes.length} machines.`,
      "Delete its machines first; a task's or pull request's preview deletes them with itself.",
      {
        dependents: boxes.map((b) => ({
          entity: 'machine',
          ...b,
        })),
      },
    )
  }
}

export const removePreview = (db: Db, previewId: string) => {
  const row = db.select().from(target).where(eq(target.id, previewId)).get()

  if (!row || row.kind !== 'preview') {
    return fail('NOT_FOUND', `preview ${previewId} does not exist.`)
  }

  requireNoMachines(db, row)

  for (const box of db.select().from(machine).where(eq(machine.target_id, row.id)).all()) {
    requestDeletion(db, box, {
      actor: systemActor,
      reason: 'preview',
    })
  }

  db.update(machine_snapshot)
    .set({
      status: 'deleting',
    })
    .where(and(eq(machine_snapshot.target_id, row.id), ne(machine_snapshot.status, 'failed')))
    .run()
  db.delete(machine_snapshot)
    .where(and(eq(machine_snapshot.target_id, row.id), eq(machine_snapshot.status, 'failed')))
    .run()
  let retainUntil: Date | null = null

  for (const svc of db
    .select({
      id: app.id,
    })
    .from(app)
    .where(eq(app.target_id, row.id))
    .all()) {
    retainUntil = removeApp(db, svc.id)
  }

  db.delete(ipam_allocation).where(eq(ipam_allocation.target_id, row.id)).run()
  db.delete(virtual_ip).where(eq(virtual_ip.target_id, row.id)).run()
  db.delete(target).where(eq(target.id, row.id)).run()

  return retainUntil
}

export { placeName }

export type ApprovedBackup = { volume_id: string; target: BackupTarget; quiesce: boolean }

export type ApprovedRestore = { volume_id: string; snapshot_id: string; server_id?: string }

export type ApprovedGrow = { server_id: string; size_bytes: number }

export type ApprovedProbe = {
  app_id: string
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
  backups: ApprovedBackup[]
  restores: ApprovedRestore[]
  probes: ApprovedProbe[]
  grows: ApprovedGrow[]
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
  const backups: ApprovedBackup[] = []
  const restores: ApprovedRestore[] = []
  const probes: ApprovedProbe[] = []
  const grows: ApprovedGrow[] = []
  let retained_until: Date | null = null
  const resolve = (value: string) =>
    refs[value] ??
    (isRef(value)
      ? fail('VALIDATION_FAILED', `${value} is not defined earlier in this change.`)
      : value)
  const resolveAll = (after: Json) =>
    Object.fromEntries(Object.entries(after).map(([k, v]) => [k, isRef(v) ? resolve(v) : v]))
  let keysChanged = false
  const writes: KeyWrite[] = []
  const touched = new Set<string>()
  let lockfileBefore: LockfileDoc | null = null

  for (const change of changes) {
    if (change.op === 'add') {
      const parent = change.parent === null ? null : resolve(change.parent)
      const after = resolveAll(change.after)

      switch (change.entity) {
        case 'app': {
          refs[change.ref] = createApp(db, {
            target_id: parent!,
            name: after.name as string,
            kind: after.kind as 'web' | 'worker' | 'cron' | 'one_off',
            server_id: after.server_id as string,
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

        case 'app_port': {
          refs[change.ref] = createAppPort(db, parent!, {
            port: after.port as number,
            protocol: after.protocol as 'http' | 'tcp',
            grpc: Boolean(after.grpc),
          })
          break
        }

        case 'volume': {
          const owner =
            db.select().from(app).where(eq(app.id, parent!)).get() ??
            fail('NOT_FOUND', `app ${parent} does not exist.`)
          const env = db.select().from(target).where(eq(target.id, owner.target_id)).get()!

          refs[change.ref] = createVolume(
            db,
            {
              id: owner.id,
              server_id: owner.server_id,
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
              app_port_id: parent!,
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
              app_port_id: parent!,
              server_id: after.server_id as string,
              host_port: after.host_port as number,
            })
            .run()
          refs[change.ref] = id
          break
        }

        case 'key': {
          const scope = after.scope as 'global' | 'project' | 'app' | 'machine'
          const kind = after.kind as 'literal' | 'reference' | 'sealed'
          const value =
            typeof after.value_id === 'string'
              ? plaintext(after.value_id)
              : ((after.reference as string | null) ?? '')
          const result = setKey(db, keyring, {
            scope,
            project_id: scope === 'project' ? parent! : undefined,
            app_id: scope === 'app' ? parent! : undefined,
            machine_id: scope === 'machine' ? parent! : undefined,
            target: (after.target as 'production' | 'preview' | undefined) ?? 'production',
            name: after.name as string,
            value,
            sealed: kind === 'sealed',
            injection: after.injection as 'env' | 'file' | undefined,
            build: after.build as boolean | undefined,
            allow_unresolved: Boolean(after.allow_unresolved),
            actor: call.principal.actor,
            request_id: call.request_id,
          })

          refs[change.ref] = result.key_id

          if (result.write) {
            writes.push(result.write)
          }

          keysChanged = true
          break
        }

        case 'deployment': {
          const created = createDeploymentRecord(db, {
            app_id: parent!,
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
            db.select().from(app).where(eq(app.id, parent!)).get() ??
            fail('NOT_FOUND', `app ${parent} does not exist.`)

          if (!owner.current_deployment_id) {
            fail(
              'NO_CURRENT_DEPLOYMENT',
              `${owner.name} has no current deployment to run the command in.`,
              'Deploy the app first.',
            )
          }

          const id = newId('run')

          db.insert(run)
            .values({
              id,
              app_id: owner.id,
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
                id: app.id,
              })
              .from(app)
              .where(eq(app.id, parent!))
              .get() ?? fail('NOT_FOUND', `app ${parent} does not exist.`)

          probes.push({
            app_id: owner.id,
            kind: after.kind === 'dns' ? 'dns' : 'tcp',
            to: String(after.to),
            port: typeof after.port === 'number' ? after.port : null,
            timeout_s: Number(after.timeout_s),
          })
          break
        }

        case 'machine_storage':
          grows.push({
            server_id: parent!,
            size_bytes: Number(after.size_bytes),
          })
          break

        case 'volume_snapshot': {
          const vol =
            db.select().from(volume).where(eq(volume.id, parent!)).get() ??
            fail('NOT_FOUND', `volume ${parent} does not exist.`)

          backups.push({
            volume_id: vol.id,
            target: after.target as ApprovedBackup['target'],
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
            ...(typeof after.server_id === 'string'
              ? {
                  server_id: after.server_id,
                }
              : {}),
          })
          break
        }

        default:
          fail('VALIDATION_FAILED', `adding ${change.entity} through an approval is not supported.`)
      }

      continue
    }

    const id = resolve(change.id)

    if (change.op === 'update') {
      switch (change.entity) {
        case 'app': {
          const row =
            db.select().from(app).where(eq(app.id, id)).get() ??
            fail('NOT_FOUND', `app ${id} does not exist.`)
          const column = change.path.split('/')[1]!

          if (!appColumns.has(column)) {
            fail('VALIDATION_FAILED', `app field ${column} cannot change through an approval.`)
          }

          const holder: Json = {
            [column]: (row as Json)[column],
          }

          setPointer(holder, change.path, change.after)
          const update: Json = {
            [column]: holder[column],
          }

          db.update(app).set(update).where(eq(app.id, id)).run()
          touched.add(id)

          if (
            column === 'desired_state' &&
            change.after === 'running' &&
            row.current_deployment_id
          ) {
            recordHealth(db, row.current_deployment_id, false)
          }

          if (column === 'desired_state' || column === 'server_id') {
            refreshAppStatus(db, id, {
              source: column,
            })
          }

          if (column === 'server_id') {
            ensureNetwork(db, row.target_id, change.after as string)
          }

          break
        }

        case 'app_port':
          if (change.path === '/grpc') {
            db.update(app_port)
              .set({
                grpc: Boolean(change.after),
              })
              .where(eq(app_port.id, id))
              .run()
          } else if (change.path === '/protocol') {
            const protocol = change.after === 'tcp' ? 'tcp' : 'http'

            requireProtocolChangeAllowed(db, id, protocol)
            db.update(app_port)
              .set({
                protocol,
              })
              .where(eq(app_port.id, id))
              .run()
          } else {
            fail(
              'VALIDATION_FAILED',
              `app_port field ${change.path.slice(1)} cannot change in place.`,
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

        case 'key': {
          const row =
            db.select().from(key).where(eq(key.id, id)).get() ??
            fail('NOT_FOUND', `key ${id} does not exist.`)
          const after = change.after as Json
          const kind = after.kind as 'literal' | 'reference' | 'sealed'

          if (kind === 'sealed' && typeof after.value_id !== 'string' && !after.reference) {
            db.update(key)
              .set({
                injection: (after.injection as 'env' | 'file' | undefined) ?? row.injection,
                build: (after.build as boolean | undefined) ?? row.build,
              })
              .where(eq(key.id, id))
              .run()
            keysChanged = true
            break
          }

          const value =
            typeof after.value_id === 'string'
              ? plaintext(after.value_id)
              : ((after.reference as string | null) ?? '')
          const result = setKey(db, keyring, {
            scope: row.scope,
            project_id: row.project_id ?? undefined,
            app_id: row.app_id ?? undefined,
            machine_id: row.machine_id ?? undefined,
            target: (after.target as 'production' | 'preview' | undefined) ?? 'production',
            name: row.name,
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

          keysChanged = true
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

        case 'preview':
          db.update(target)
            .set({
              [change.path.slice(1)]: change.after,
            })
            .where(eq(target.id, id))
            .run()
          break

        case 'server': {
          const field = change.path.slice(1)

          if (!(stationFields as readonly string[]).includes(field)) {
            fail('VALIDATION_FAILED', `server field ${field} cannot change through an approval.`)
          }

          applyStationField(db, id, field as StationField, change.after)
          break
        }

        default:
          fail(
            'VALIDATION_FAILED',
            `updating ${change.entity} through an approval is not supported.`,
          )
      }

      continue
    }

    switch (change.entity) {
      case 'app':
        retained_until = removeApp(db, id)
        break
      case 'preview':
        retained_until = removePreview(db, id)
        break
      case 'app_port':
        removePort(db, id)
        break
      case 'domain':
        db.delete(domain).where(eq(domain.id, id)).run()
        break
      case 'key':
        db.delete(secret_value).where(eq(secret_value.key_id, id)).run()
        db.delete(key).where(eq(key.id, id)).run()
        keysChanged = true
        break
      default:
        fail('VALIDATION_FAILED', `removing ${change.entity} through an approval is not supported.`)
    }
  }

  if (keysChanged) {
    settleKeyWrites(db, writes)
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
    if (change.entity !== 'key' || change.op === 'remove') {
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
        change.after.hostname ??
        change.after.port ??
        change.after.mount_path) as string | undefined

      return isRef(change.parent) || name === undefined
        ? []
        : [`add:${change.entity}:${change.parent}:${name}`]
    }),
  )

export type CommitOptions = {
  target: TargetRow | null
  protect: boolean
  source?: 'api' | 'manifest' | 'task' | 'ui'
  server?: string | null
}

export type CommitResult =
  | { applied: false; approval: ApprovalRow }
  | {
      applied: true
      approval: ApprovalRow
      refs: Record<string, string>
      deployments: string[]
      retained_until: Date | null
      upgrade: string | null
    }

const entityWords = (entity: string) => entity.replaceAll('_', ' ')

export const approvalTitle = (changes: Change[], row: TargetRow | null) => {
  const place = row ? placeName(row) : 'the instance'

  if (changes.some((change) => (change.entity as string) === 'lockfile')) {
    return 'Upgrade Stationly'
  }

  if (changes.length === 1) {
    const [change] = changes as [Change]

    if (change.op === 'add' && change.entity === 'deployment') {
      return `Deploy in ${place}`
    }

    const verb = {
      add: 'Add',
      update: 'Change',
      remove: 'Remove',
    }[change.op]

    return `${verb} ${entityWords(change.entity)} in ${place}`
  }

  return `${changes.length} changes in ${place}`
}

const supersede = (tdb: Db, ids: string[]) => {
  if (!ids.length) {
    return
  }

  tdb
    .update(approval)
    .set({
      status: 'superseded',
    })
    .where(inArray(approval.id, ids))
    .run()
  tdb.delete(approval_value).where(inArray(approval_value.approval_id, ids)).run()
}

export const supersedeWaiting = (tdb: Db, where: SQL) =>
  supersede(
    tdb,
    tdb
      .select({
        id: approval.id,
      })
      .from(approval)
      .where(and(eq(approval.status, 'waiting'), where))
      .all()
      .map((row) => row.id),
  )

export const commit = (
  deps: Store,
  call: Call,
  options: CommitOptions,
  set: ChangeSet,
): CommitResult => {
  const { db, keyring } = deps
  const changes = set.changes
  const source = options.source ?? (call.principal.human ? 'ui' : 'api')
  const projectId = options.target?.project_id ?? null
  const base = {
    project_id: projectId,
    title: approvalTitle(changes, options.target),
    requested_by: call.principal.actor,
    requester: requesterOf(call.principal),
    source,
  }

  if (options.protect) {
    return db.transaction((tx) => {
      const tdb = tx as unknown as Db
      const id = newId('approval')

      tdb
        .insert(approval)
        .values({
          id,
          ...base,
          changes,
          refs: options.server
            ? {
                'platform.server': options.server,
              }
            : {},
          status: 'waiting',
          deployments: [],
        })
        .run()

      for (const [valueId, plaintext] of set.values) {
        tdb
          .insert(approval_value)
          .values({
            id: valueId,
            approval_id: id,
            ...keyring.encrypt(valueId, plaintext),
          })
          .run()
      }

      const mine = overlapKeys(changes)
      const older = tdb
        .select()
        .from(approval)
        .where(
          and(
            projectId === null ? isNull(approval.project_id) : eq(approval.project_id, projectId),
            eq(approval.status, 'waiting'),
            isNull(approval.task_id),
          ),
        )
        .all()
        .filter(
          (row) =>
            row.id !== id && [...overlapKeys(row.changes as Change[])].some((key) => mine.has(key)),
        )

      supersede(
        tdb,
        older.map((o) => o.id),
      )
      audit(
        tdb,
        call,
        'approval.create',
        {
          entity: 'approval',
          id,
        },
        {
          after: {
            project_id: projectId,
            entries: changes.length,
            superseded: older.map((o) => o.id),
          },
        },
      )
      emit(
        tdb,
        'approval.created',
        {
          entity: 'approval',
          id,
          project_id: projectId,
        },
        {
          superseded: older.map((o) => o.id),
        },
      )

      return {
        applied: false as const,
        approval: tdb.select().from(approval).where(eq(approval.id, id)).get()!,
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
    const id = newId('approval')

    tdb
      .insert(approval)
      .values({
        id,
        ...base,
        changes: stripValues(changes),
        refs: result.refs,
        status: 'approved',
        decided_by: call.principal.actor,
        decided_at: new Date(),
        deployments: result.deployments,
      })
      .run()
    const upgrade = result.lockfile
      ? startUpgrade(tdb, {
          approvalId: id,
          actor: call.principal.actor,
          before: result.lockfile.before,
          after: result.lockfile.after,
          server: options.server ?? null,
        })
      : null

    return {
      applied: true as const,
      upgrade,
      approval: tdb.select().from(approval).where(eq(approval.id, id)).get()!,
      ...result,
    }
  })
}

export const requireWaiting = (row: ApprovalRow) => {
  if (row.status === 'superseded') {
    fail(
      'APPROVAL_SUPERSEDED',
      `Approval ${row.id} was replaced by a newer one.`,
      'Read the newer approval and decide that one.',
    )
  }

  if (row.status !== 'waiting' || (row.ship && row.ship.phase !== 'open')) {
    fail(
      'APPROVAL_CLOSED',
      `Approval ${row.id} is ${row.ship && row.status === 'waiting' ? row.ship.phase : row.status}, not waiting for a decision.`,
      row.task_id ? 'Ship the task again to ask anew.' : undefined,
    )
  }
}

export const approveChanges = (deps: Store, call: Call, row: ApprovalRow) => {
  const { db, keyring } = deps

  requireWaiting(row)

  const selfApproved = requireRequesterRule(db, row, call.principal)

  return db.transaction((tx) => {
    const tdb = tx as unknown as Db
    const values = new Map(
      tdb
        .select()
        .from(approval_value)
        .where(eq(approval_value.approval_id, row.id))
        .all()
        .map((v) => [v.id, v]),
    )
    const plaintext = (valueId: string) => {
      const stored =
        values.get(valueId) ?? fail('VALIDATION_FAILED', `approval value ${valueId} is missing.`)

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

    tdb.delete(approval_value).where(eq(approval_value.approval_id, row.id)).run()
    tdb
      .update(approval)
      .set({
        status: 'approved',
        decided_by: call.principal.actor,
        decided_at: new Date(),
        self_approved: selfApproved,
        refs: result.refs,
        deployments: result.deployments,
        changes: stripValues(row.changes as Change[]),
      })
      .where(eq(approval.id, row.id))
      .run()
    const upgrade = result.lockfile
      ? startUpgrade(tdb, {
          approvalId: row.id,
          actor: row.requested_by,
          before: result.lockfile.before,
          after: result.lockfile.after,
          server: (row.refs as Record<string, string> | null)?.['platform.server'] ?? null,
        })
      : null

    recordDecision(tdb, call, row, true, {
      refs: result.refs,
      deployments: result.deployments,
      upgrade,
      self_approved: selfApproved,
    })

    return {
      approval: tdb.select().from(approval).where(eq(approval.id, row.id)).get()!,
      ...result,
      upgrade,
    }
  })
}

export const recordDecision = (
  tdb: Db,
  call: Call,
  row: ApprovalRow,
  approve: boolean,
  details: Record<string, unknown>,
) => {
  audit(
    tdb,
    call,
    approve ? 'approval.approve' : 'approval.reject',
    {
      entity: 'approval',
      id: row.id,
    },
    {
      after: {
        task_id: row.task_id,
        ...details,
      },
    },
  )
  emit(
    tdb,
    approve ? 'approval.approved' : 'approval.rejected',
    {
      entity: 'approval',
      id: row.id,
      project_id: row.project_id,
    },
    {
      task_id: row.task_id,
      ...details,
    },
  )
}

export const rejectApproval = (
  deps: Pick<Deps, 'db'>,
  call: Call,
  row: ApprovalRow,
  reason: string | null,
) => {
  const { db } = deps

  requireWaiting(row)

  return db.transaction((tx) => {
    const tdb = tx as unknown as Db

    tdb.delete(approval_value).where(eq(approval_value.approval_id, row.id)).run()
    tdb
      .update(approval)
      .set({
        status: 'rejected',
        reason,
        decided_by: call.principal.actor,
        decided_at: new Date(),
      })
      .where(eq(approval.id, row.id))
      .run()
    recordDecision(tdb, call, row, false, {
      reason,
    })

    return tdb.select().from(approval).where(eq(approval.id, row.id)).get()!
  })
}
