import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm'

import { appStatusValues, type Observed } from '@stationly/protocol'

import type { Db } from '../db/client.ts'
import {
  app,
  app_port,
  approval,
  attestation,
  audit_event,
  build,
  component,
  deployment,
  deployment_step,
  domain,
  environment_variable,
  event,
  notification_channel,
  run,
  secret_value,
  server,
  station_generation,
  target,
  task,
  token,
  volume,
  volume_snapshot,
} from '../db/schema.ts'
import { effectiveHealth, type StoredHealth } from '../generation/health.ts'
import { machineMemory } from '../sandboxes/limits.ts'
import { machineRuntimeAdvice } from '../sandboxes/runtime.ts'
import type { EnvSnapshot } from '../secrets/deploy.ts'
import { valueBytes } from '../secrets/keyring.ts'
import { parseValue } from '../secrets/reference.ts'
import { leaves } from '../secrets/resolve.ts'
import { storedBytes } from '../secrets/variables.ts'
import { projectMachine, taskSlotsOf } from '../tasks/machine.ts'
import { snapshotView } from '../volumes/backups.ts'

import { approvalItem } from './approval-view.ts'
import { tunnelRouteOf } from './exposure.ts'
import {
  all,
  projectAll,
  project as select,
  type FieldTree,
  type Row,
  type View,
} from './fields.ts'
import {
  decidable,
  previewIdOf,
  productionOf,
  type ApprovalRow,
  type AppRow,
  type DeploymentRow,
  type DomainRow,
  type PortRow,
  type ProjectRow,
  type StationRow,
  type TargetRow,
  type VariableRow,
  type VolumeRow,
} from './lookup.ts'
import * as shapes from './shapes.ts'

export const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null)

const runDeadline = (row: RunRow) =>
  row.exec?.timeout_s
    ? new Date((row.started_at ?? row.created_at).getTime() + row.exec.timeout_s * 1000)
    : null

const stamps = (row: { id: string; created_at: Date; updated_at: Date }) => ({
  id: row.id,
  created_at: iso(row.created_at),
  updated_at: iso(row.updated_at),
})

type TokenRow = typeof token.$inferSelect
type AuditRow = typeof audit_event.$inferSelect
type SecretValueRow = typeof secret_value.$inferSelect
type BuildRow = typeof build.$inferSelect
type RunRow = typeof run.$inferSelect
type EventRow = typeof event.$inferSelect
type ChannelRow = typeof notification_channel.$inferSelect

export const exportsOf = (db: Db, svc: AppRow) => {
  const host = `${svc.name}.internal`
  const port = db
    .select()
    .from(app_port)
    .where(eq(app_port.app_id, svc.id))
    .orderBy(asc(app_port.created_at), asc(app_port.port))
    .get()

  return [
    {
      key: 'HOST',
      value: host,
    },
    ...(port
      ? [
          {
            key: 'PORT',
            value: String(port.port),
          },
        ]
      : []),
    ...(port && svc.kind === 'web'
      ? [
          {
            key: 'URL',
            value: `http://${host}:${port.port}`,
          },
        ]
      : []),
  ]
}

export const sourceView = (source: Record<string, unknown>) =>
  typeof source.repo === 'string'
    ? {
        ...source,
        auth: source.auth ?? null,
      }
    : source

export const createViews = (db: Db, observedOf: (serverId: string) => Observed | undefined) => {
  const waitingApprovals = (projectId: string) =>
    db
      .select({
        n: count(),
      })
      .from(approval)
      .where(and(eq(approval.project_id, projectId), decidable()))
      .get()?.n ?? 0

  const appsOf = (targetId: string) =>
    db.select().from(app).where(eq(app.target_id, targetId)).orderBy(desc(app.id)).all()

  const placeOf = (targetId: string) => {
    const row = db.select().from(target).where(eq(target.id, targetId)).get()!

    return {
      project_id: row.project_id,
      preview_id: previewIdOf(row),
    }
  }

  const portView: View<PortRow, typeof shapes.AppPort> = {
    schema: shapes.AppPort,
    full: (row) => ({
      ...stamps(row),
      app_id: row.app_id,
      port: row.port,
      protocol: row.protocol,
      grpc: row.grpc,
    }),
    summary: ['id', 'app_id', 'port', 'protocol', 'grpc'],
    expand: {
      domains: (row, sub) =>
        projectAll(
          domainView,
          db.select().from(domain).where(eq(domain.app_port_id, row.id)).all(),
          sub,
        ),
    },
  }

  const volumeView: View<VolumeRow, typeof shapes.Volume> = {
    schema: shapes.Volume,
    full: (row) => ({
      ...stamps(row),
      owner: row.owner,
      app_id: row.app_id,
      server_id: row.server_id,
      mount_path: row.mount_path,
      docker_name: row.docker_name,
      size_bytes: row.size_bytes,
      status: row.status,
      retain_until: iso(row.retain_until),
    }),
    summary: [
      'id',
      'owner',
      'app_id',
      'server_id',
      'mount_path',
      'size_bytes',
      'status',
      'retain_until',
    ],
    expand: {
      backups: (row) =>
        db
          .select()
          .from(volume_snapshot)
          .where(eq(volume_snapshot.volume_id, row.id))
          .orderBy(desc(volume_snapshot.id))
          .all()
          .map(snapshotView),
    },
  }

  const domainView: View<DomainRow, typeof shapes.Domain> = {
    schema: shapes.Domain,
    full: (row) => ({
      ...stamps(row),
      app_port_id: row.app_port_id,
      hostname: row.hostname,
      kind: row.kind,
      status: row.status,
      last_checked_at: iso(row.last_checked_at),
    }),
    summary: ['id', 'app_port_id', 'hostname', 'kind', 'status'],
    expand: {
      tunnel_route: (row) => tunnelRouteOf(db, row.hostname),
      error: (row) => row.error,
    },
  }

  const snapshotIds = (snapshot: EnvSnapshot) =>
    (snapshot.entries ?? []).map((entry) => ({
      name: entry.key,
      environment_variable_id: entry.environment_variable_id,
      secret: entry.secret,
      values: leaves(entry.node).flatMap((leaf) =>
        leaf.kind === 'value'
          ? [
              {
                secret_value_id: leaf.secret_value_id,
                version: leaf.version,
              },
            ]
          : [],
      ),
    }))

  const deploymentView: View<DeploymentRow, typeof shapes.Deployment> = {
    schema: shapes.Deployment,
    full: (row) => ({
      ...stamps(row),
      app_id: row.app_id,
      number: row.number,
      status: row.status,
      trigger: row.trigger,
      image_ref: row.image_ref,
      image_pruned_at: iso(row.image_pruned_at),
      build_id: row.build_id,
      strategy: row.strategy,
      cancel_reason: row.cancel_reason,
      started_at: iso(row.started_at),
      finished_at: iso(row.finished_at),
      failure: row.failure
        ? {
            code: row.failure.code,
            summary: row.failure.summary,
          }
        : null,
    }),
    summary: [
      'id',
      'app_id',
      'number',
      'status',
      'trigger.type',
      'trigger.source_sha',
      'image_ref',
      'strategy',
      'cancel_reason',
      'started_at',
      'finished_at',
      'failure.code',
      'failure.summary',
    ],
    expand: {
      steps: (row) =>
        db
          .select()
          .from(deployment_step)
          .where(eq(deployment_step.deployment_id, row.id))
          .orderBy(asc(deployment_step.created_at))
          .all()
          .map((s) => ({
            id: s.id,
            step: s.step,
            status: s.status,
            attempt: s.attempt,
            detail: s.detail,
            started_at: iso(s.started_at),
            finished_at: iso(s.finished_at),
          })),
      build: (row) => {
        if (!row.build_id) {
          return null
        }

        const b = db.select().from(build).where(eq(build.id, row.build_id)).get()

        return b
          ? {
              id: b.id,
              deployment_id: b.deployment_id,
              builder: b.builder,
              status: b.status,
              duration_s: b.duration_s,
              source: b.source,
              failure: b.failure,
            }
          : null
      },
      failure: (row) => row.failure,
      env_snapshot: (row) => snapshotIds(row.env_snapshot as EnvSnapshot),
      config_snapshot: (row) => row.config_snapshot,
      base_images: (row) => row.base_images,
    },
  }

  const deploymentSummary = (id: string | null, sub?: FieldTree) => {
    if (!id) {
      return null
    }

    const row = db.select().from(deployment).where(eq(deployment.id, id)).get()

    return row ? select(deploymentView, row, sub) : null
  }

  const headVersion = (row: VariableRow) => {
    if (!row.current_value_id) {
      return null
    }

    return (
      db
        .select({
          version: secret_value.version,
        })
        .from(secret_value)
        .where(eq(secret_value.id, row.current_value_id))
        .get()?.version ?? null
    )
  }

  const pinnedBy = (secretValueId: string) =>
    db
      .select({
        env_snapshot: deployment.env_snapshot,
      })
      .from(deployment)
      .where(eq(deployment.status, 'active'))
      .all()
      .filter((d) =>
        snapshotIds(d.env_snapshot as EnvSnapshot).some((e) =>
          e.values.some((v) => v.secret_value_id === secretValueId),
        ),
      ).length

  const secretValueView: View<SecretValueRow, typeof shapes.SecretValue> = {
    schema: shapes.SecretValue,
    full: (row) => ({
      id: row.id,
      environment_variable_id: row.environment_variable_id,
      target: row.target,
      version: row.version,
      bytes:
        db
          .select({
            kind: environment_variable.kind,
          })
          .from(environment_variable)
          .where(eq(environment_variable.id, row.environment_variable_id))
          .get()?.kind === 'secret'
          ? valueBytes(row.ciphertext)
          : null,
      created_by: row.created_by,
      created_at: iso(row.created_at),
      revoked_at: iso(row.revoked_at),
      needs_reentry: row.needs_reentry,
      pinned_by: pinnedBy(row.id),
    }),
    summary: [
      'id',
      'environment_variable_id',
      'target',
      'version',
      'bytes',
      'created_by',
      'created_at',
      'revoked_at',
      'needs_reentry',
      'pinned_by',
    ],
  }

  const variableView: View<VariableRow, typeof shapes.EnvironmentVariable> = {
    schema: shapes.EnvironmentVariable,
    full: (row) => {
      const base: Row = {
        ...stamps(row),
        scope: row.scope,
        project_id: row.project_id,
        app_id: row.app_id,
        machine_id: row.machine_id,
        name: row.name,
        kind: row.kind,
        reference: row.reference,
        injection: row.injection,
        build: row.build,
        head_version: headVersion(row),
        bytes:
          row.kind === 'secret' && row.current_value_id
            ? storedBytes(db, row.current_value_id)
            : null,
        secret: row.kind === 'secret',
        value: null,
      }

      if (row.scope === 'project' || row.scope === 'app') {
        base.targets = [
          ...new Set(
            db
              .select({
                target: secret_value.target,
              })
              .from(secret_value)
              .where(
                and(
                  eq(secret_value.environment_variable_id, row.id),
                  isNull(secret_value.revoked_at),
                ),
              )
              .all()
              .map((h) => h.target),
          ),
        ].sort()
      }

      return base
    },
    summary: [
      'id',
      'scope',
      'name',
      'kind',
      'reference',
      'injection',
      'build',
      'head_version',
      'bytes',
      'targets',
    ],
    expand: {
      versions: (row, sub) =>
        projectAll(
          secretValueView,
          db
            .select()
            .from(secret_value)
            .where(eq(secret_value.environment_variable_id, row.id))
            .orderBy(desc(secret_value.id))
            .all(),
          sub,
        ),
    },
  }

  const portDocsOf = (appId: string) =>
    db
      .select()
      .from(app_port)
      .where(eq(app_port.app_id, appId))
      .orderBy(asc(app_port.port))
      .all()
      .map((p) => ({
        port: p.port,
        protocol: p.protocol,
      }))

  const lastHealthChange = (row: AppRow) => {
    if (row.status !== 'failing') {
      return null
    }

    const found = db
      .select()
      .from(event)
      .where(
        and(
          eq(event.type, 'health.changed'),
          sql`json_extract(${event.subject}, '$.id') = ${row.id}`,
        ),
      )
      .orderBy(desc(event.id))
      .limit(1)
      .get()

    if (!found) {
      return null
    }

    const payload = found.payload as Record<string, string | number | null | undefined>

    return {
      at: found.created_at.toISOString(),
      from: String(payload.from),
      to: String(payload.to),
      state: String(payload.state ?? payload.health ?? '') || null,
      consecutive: typeof payload.consecutive === 'number' ? payload.consecutive : null,
      last_check: typeof payload.last_check === 'string' ? payload.last_check : null,
      status_hint: typeof payload.status_hint === 'string' ? payload.status_hint : null,
    }
  }

  const appView: View<AppRow, typeof shapes.App> = {
    schema: shapes.App,
    full: (row) => ({
      ...stamps(row),
      ...placeOf(row.target_id),
      name: row.name,
      kind: row.kind,
      server_id: row.server_id,
      source: sourceView(row.source),
      command: row.command,
      build_args: row.build_args,
      limits: row.limits,
      health_default: row.health === null,
      strategy: row.strategy,
      multi_writer_safe: row.multi_writer_safe,
      drain_timeout_s: row.drain_timeout_s,
      readonly_rootfs: row.readonly_rootfs,
      secrets_owner: row.secrets_owner,
      best_effort: row.best_effort,
      pre_deploy: row.pre_deploy,
      schedule: row.schedule,
      current_deployment_id: row.current_deployment_id,
      status: row.status,
      status_reason: row.status_reason,
      desired_state: row.desired_state,
      stale: row.stale,
      stale_reasons: row.stale_reasons,
    }),
    summary: [
      'id',
      'project_id',
      'preview_id',
      'name',
      'kind',
      'status',
      'status_reason',
      'desired_state',
      'server_id',
      'source',
      'current_deployment_id',
      'stale',
      'stale_reasons',
    ],
    expand: {
      health: (row) => effectiveHealth(row.kind, portDocsOf(row.id), row.health as StoredHealth),
      last_health_change: (row) => lastHealthChange(row),
      ports: (row, sub) =>
        projectAll(
          portView,
          db
            .select()
            .from(app_port)
            .where(eq(app_port.app_id, row.id))
            .orderBy(asc(app_port.port))
            .all(),
          sub,
        ),
      volumes: (row, sub) =>
        projectAll(
          volumeView,
          db.select().from(volume).where(eq(volume.app_id, row.id)).all(),
          sub,
        ),
      domains: (row, sub) => {
        const ports = db
          .select({
            id: app_port.id,
          })
          .from(app_port)
          .where(eq(app_port.app_id, row.id))
          .all()
          .map((p) => p.id)

        return ports.length
          ? projectAll(
              domainView,
              db.select().from(domain).where(inArray(domain.app_port_id, ports)).all(),
              sub,
            )
          : []
      },
      current_deployment: (row, sub) => deploymentSummary(row.current_deployment_id, sub),
      environment_variables: (row, sub) =>
        projectAll(
          variableView,
          db
            .select()
            .from(environment_variable)
            .where(
              and(eq(environment_variable.scope, 'app'), eq(environment_variable.app_id, row.id)),
            )
            .orderBy(asc(environment_variable.name))
            .all(),
          sub,
        ),
      exports: (row) => exportsOf(db, row),
    },
  }

  const edgesOf = (targetId: string) => {
    const apps = appsOf(targetId)
    const byName = new Map(apps.map((s) => [s.name, s.id]))
    const edges = new Map<
      string,
      { from_app: string; to_app: string; environment_variables: string[] }
    >()

    for (const svc of apps) {
      const vars = db
        .select()
        .from(environment_variable)
        .where(
          and(
            eq(environment_variable.scope, 'app'),
            eq(environment_variable.app_id, svc.id),
            eq(environment_variable.kind, 'reference'),
          ),
        )
        .all()

      for (const v of vars) {
        let segments: ReturnType<typeof parseValue> = []

        try {
          segments = parseValue(v.reference ?? '')
        } catch {
          continue
        }

        for (const segment of segments) {
          if (segment.type !== 'reference' || segment.target.type !== 'app') {
            continue
          }

          const to = byName.get(segment.target.app)

          if (!to) {
            continue
          }

          const id = `${svc.id}>${to}`
          const edge = edges.get(id) ?? {
            from_app: svc.id,
            to_app: to,
            environment_variables: [],
          }

          if (!edge.environment_variables.includes(v.name)) {
            edge.environment_variables.push(v.name)
          }

          edges.set(id, edge)
        }
      }
    }

    return [...edges.values()]
  }

  const appCount = (targetId: string) =>
    db
      .select({
        n: count(),
      })
      .from(app)
      .where(eq(app.target_id, targetId))
      .get()?.n ?? 0

  const appsExpand = (targetId: string, sub: Parameters<typeof projectAll>[2]) => {
    const nested =
      sub && sub.size > 0
        ? sub
        : new Map([
            ['current_deployment', new Map()],
            ['domains', new Map()],
          ])

    return projectAll(appView, appsOf(targetId), nested)
  }

  const previewView: View<TargetRow, typeof shapes.Preview> = {
    schema: shapes.Preview,
    full: (row) => ({
      ...stamps(row),
      project_id: row.project_id,
      name: row.name,
      origin: row.origin ?? {
        type: 'named',
      },
      expires_at: iso(row.expires_at),
      app_count: appCount(row.id),
    }),
    summary: ['id', 'project_id', 'name', 'origin', 'expires_at', 'app_count'],
    expand: {
      apps: (row, sub) => appsExpand(row.id, sub),
      edges: (row) => edgesOf(row.id),
    },
  }

  const previewsOf = (projectId: string) =>
    db
      .select()
      .from(target)
      .where(and(eq(target.project_id, projectId), eq(target.kind, 'preview')))
      .orderBy(desc(target.id))
      .all()

  const targetIdsOf = (projectId: string) =>
    db
      .select({
        id: target.id,
      })
      .from(target)
      .where(eq(target.project_id, projectId))
      .all()
      .map((e) => e.id)

  const serversOf = (row: ProjectRow) => {
    const targetIds = targetIdsOf(row.id)
    const appServers = targetIds.length
      ? db
          .selectDistinct({
            id: app.server_id,
          })
          .from(app)
          .where(inArray(app.target_id, targetIds))
          .all()
          .map((e) => e.id)
      : []
    const machineServer = projectMachine(db, row)?.server_id
    const ids = [...new Set(machineServer ? [...appServers, machineServer] : appServers)]

    if (!ids.length) {
      return []
    }

    return db
      .select()
      .from(server)
      .where(inArray(server.id, ids))
      .orderBy(asc(server.name))
      .all()
      .map((st) => {
        const memory = machineMemory(db, st)
        const tunnel = observedOf(st.id)?.gateway.tunnel

        return {
          id: st.id,
          name: st.name,
          status: st.status,
          last_seen_at: iso(st.last_seen_at),
          memory: {
            used: memory.used,
            total: memory.limit ?? st.resources?.memory_bytes ?? null,
          },
          tunnel: tunnel
            ? {
                configured: tunnel.configured,
                ready: tunnel.ready,
                connections: tunnel.connections,
              }
            : null,
        }
      })
  }

  const projectView: View<ProjectRow, typeof shapes.Project> = {
    schema: shapes.Project,
    full: (row) => {
      const targetIds = targetIdsOf(row.id)
      const apps = targetIds.length
        ? db
            .select({
              status: app.status,
            })
            .from(app)
            .where(inArray(app.target_id, targetIds))
            .all()
        : []
      const status_counts = Object.fromEntries(
        appStatusValues.map((key) => [key, apps.filter((s) => s.status === key).length]),
      )

      return {
        ...stamps(row),
        name: row.name,
        shared: row.shared,
        manifest_path: row.manifest_path,
        build_cache_bytes: row.build_cache_bytes,
        workshop_uid_base: row.workshop_uid_base,
        image_retention_count: row.image_retention_count,
        base_image_auto_rebuild: row.base_image_auto_rebuild,
        pull_request_previews: row.pull_request_previews,
        preview_count: targetIds.length - 1,
        waiting_approvals: waitingApprovals(row.id),
        app_count: apps.length,
        status_counts,
        task_count:
          db
            .select({
              n: count(),
            })
            .from(task)
            .where(eq(task.project_id, row.id))
            .get()?.n ?? 0,
      }
    },
    summary: [
      'id',
      'name',
      'preview_count',
      'waiting_approvals',
      'app_count',
      'status_counts',
      'task_count',
    ],
    expand: {
      previews: (row, sub) => projectAll(previewView, previewsOf(row.id), sub),
      apps: (row, sub) => appsExpand(productionOf(db, row.id).id, sub),
      edges: (row) => edgesOf(productionOf(db, row.id).id),
      environment_variables: (row, sub) =>
        projectAll(
          variableView,
          db
            .select()
            .from(environment_variable)
            .where(
              and(
                eq(environment_variable.scope, 'project'),
                eq(environment_variable.project_id, row.id),
              ),
            )
            .orderBy(asc(environment_variable.name))
            .all(),
          sub,
        ),
      servers: (row) => serversOf(row),
      task_slots: (row) => taskSlotsOf(db, row),
      task_egress: (row) => projectMachine(db, row)?.egress ?? null,
    },
  }

  const approvalView: View<ApprovalRow, typeof shapes.Approval> = {
    schema: shapes.Approval,
    full: (row) => approvalItem(db, row),
    summary: [...shapes.approvalSummary],
    expand: {
      changes: (row) => row.changes,
      refs: (row) => row.refs,
      deployments: (row) => row.deployments,
    },
  }

  const tokenView: View<TokenRow, typeof shapes.Token> = {
    schema: shapes.Token,
    full: (row) => ({
      ...stamps(row),
      name: row.name,
      kind: row.kind,
      scopes:
        row.kind === 'personal'
          ? [
              {
                project_id: '*',
                target: '*',
                level: 'admin',
              },
            ]
          : row.scopes,
      expires_at: iso(row.expires_at),
      last_used_at: iso(row.last_used_at),
      client_id: row.client_id,
      server_id: row.server_id,
      used_at: iso(row.used_at),
    }),
    summary: ['id', 'name', 'kind', 'scopes', 'expires_at', 'last_used_at', 'client_id'],
  }

  const stationView: View<StationRow, typeof shapes.Server> = {
    schema: shapes.Server,
    full: (row) => ({
      ...stamps(row),
      name: row.name,
      status: row.status,
      draining: row.draining,
      os: row.os,
      arch: row.arch,
      version_skew: row.version_skew,
      last_seen_at: iso(row.last_seen_at),
      concurrency_cap: row.concurrency_cap,
      resources: row.resources,
      intermittent: row.intermittent,
      machine_subnet: row.machine_subnet,
      machine_limits: row.machine_limits,
      default_machine_runtime: row.default_machine_runtime,
      registry_address: row.registry_address,
      hosts_dispatch: row.hosts_dispatch,
      generation: row.generation,
      revoked_at: iso(row.revoked_at),
    }),
    summary: [
      'id',
      'name',
      'status',
      'draining',
      'os',
      'arch',
      'version_skew',
      'last_seen_at',
      'concurrency_cap',
      'resources',
    ],
    expand: {
      capabilities: (row) => row.capabilities,
      routes: (row) => row.routes,
      machine_memory: (row) => machineMemory(db, row),
      machine_runtime_advice: (row) => machineRuntimeAdvice(row),
      generation_failure: (row) =>
        db
          .select({
            generation: station_generation.generation,
            ack: station_generation.ack,
            failure: station_generation.failure,
          })
          .from(station_generation)
          .where(
            and(eq(station_generation.server_id, row.id), eq(station_generation.ack, 'rejected')),
          )
          .orderBy(desc(station_generation.generation))
          .limit(1)
          .get() ?? null,
      components: (row) =>
        db
          .select()
          .from(component)
          .where(eq(component.server_id, row.id))
          .all()
          .map((c) => ({
            name: c.name,
            server_id: c.server_id,
            version: c.version,
            digest: c.digest,
            lockfile_version: c.lockfile_version,
            lockfile_digest: c.lockfile_digest,
            status: c.status,
          })),
    },
  }

  const buildView: View<BuildRow, typeof shapes.Build> = {
    schema: shapes.Build,
    full: (row) => ({
      ...stamps(row),
      deployment_id: row.deployment_id,
      project_id: row.project_id,
      builder: row.builder,
      status: row.status,
      duration_s: row.duration_s,
      source: {
        ...row.source,
        sha: (row.source.sha as string | undefined) ?? null,
      },
      image_ref: row.image_ref,
      index_digest: row.index_digest,
      railpack_version: row.railpack_version,
      log_ref: row.log_ref,
      failure: row.failure
        ? {
            code: row.failure.code,
            summary: row.failure.summary,
          }
        : null,
    }),
    summary: [
      'id',
      'deployment_id',
      'builder',
      'status',
      'duration_s',
      'source.sha',
      'failure.code',
    ],
    expand: {
      detail: (row) => row.detail,
      failure: (row) => row.failure,
      attestations: (row) =>
        db
          .select()
          .from(attestation)
          .where(eq(attestation.build_id, row.id))
          .all()
          .map((a) => ({
            id: a.id,
            kind: a.kind,
            platform: a.platform,
            digest: a.digest,
            predicate_ref: a.predicate_ref,
            base_images: a.base_images,
          })),
    },
  }

  const runView: View<RunRow, typeof shapes.Run> = {
    schema: shapes.Run,
    full: (row) => ({
      ...stamps(row),
      app_id: row.app_id,
      machine_id: row.machine_id,
      deployment_id: row.deployment_id,
      kind: row.kind,
      command: row.command,
      status: row.status,
      exit_code: row.exit_code,
      tty: row.tty,
      log_ref: row.log_ref,
      started_at: iso(row.started_at),
      finished_at: iso(row.finished_at),
      deadline_at: iso(runDeadline(row)),
    }),
    summary: [
      'id',
      'app_id',
      'machine_id',
      'deployment_id',
      'kind',
      'command',
      'status',
      'exit_code',
      'started_at',
      'finished_at',
    ],
    expand: {
      failure: (row) => row.failure,
    },
  }

  const eventView: View<EventRow, typeof shapes.Event> = {
    schema: shapes.Event,
    full: (row) => ({
      id: row.id,
      type: row.type,
      subject: row.subject,
      payload: row.payload,
      created_at: iso(row.created_at),
    }),
    summary: ['id', 'type', 'subject', 'payload', 'created_at'],
    expand: {
      delivered: (row) => row.delivered,
    },
  }

  const channelView: View<ChannelRow, typeof shapes.NotificationChannel> = {
    schema: shapes.NotificationChannel,
    full: (row) => ({
      ...stamps(row),
      kind: row.kind,
      filter: row.filter,
      status: row.status,
      failing_since: iso(row.failing_since),
    }),
    summary: ['id', 'kind', 'filter', 'status', 'failing_since'],
    expand: {
      config: (row) =>
        Object.fromEntries(
          Object.entries(row.config).map(([k, v]) => [
            k,
            v && typeof v === 'object' && 'sealed' in v
              ? {
                  sealed: true,
                }
              : v,
          ]),
        ),
    },
  }

  const auditView: View<AuditRow, typeof shapes.AuditEvent> = {
    schema: shapes.AuditEvent,
    full: (row) => ({
      id: row.id,
      created_at: iso(row.created_at),
      actor: row.actor,
      action: row.action,
      target: row.target,
      request_id: row.request_id,
    }),
    summary: ['id', 'created_at', 'actor', 'action', 'target', 'request_id'],
    expand: {
      before: (row) => row.before,
      after: (row) => row.after,
      purpose: (row) => row.purpose,
      idempotency_key: (row) => row.idempotency_key,
    },
  }

  return {
    project: projectView,
    preview: previewView,
    app: appView,
    port: portView,
    volume: volumeView,
    domain: domainView,
    deployment: deploymentView,
    variable: variableView,
    secretValue: secretValueView,
    approval: approvalView,
    token: tokenView,
    station: stationView,
    audit: auditView,
    build: buildView,
    run: runView,
    event: eventView,
    channel: channelView,
    edges: edgesOf,
    all,
  }
}

export type Views = ReturnType<typeof createViews>
