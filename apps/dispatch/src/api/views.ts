import { and, asc, count, desc, eq, inArray, isNull } from 'drizzle-orm'

import { serviceStatusValues } from '@stationly/protocol'

import type { Db } from '../db/client.ts'
import {
  attestation,
  audit_event,
  build,
  component,
  deployment,
  deployment_step,
  domain,
  environment,
  event,
  notification_channel,
  port_allocation,
  run,
  sandbox,
  sandbox_snapshot,
  secret_value,
  service,
  service_port,
  staged_change,
  station,
  station_generation,
  token,
  variable,
  volume,
  volume_snapshot,
} from '../db/schema.ts'
import { deleteAt, retentionSeconds } from '../sandboxes/lifecycle.ts'
import { sandboxMemory } from '../sandboxes/limits.ts'
import type { EnvSnapshot } from '../secrets/deploy.ts'
import { SecretsError } from '../secrets/errors.ts'
import { valueBytes } from '../secrets/keyring.ts'
import { parseValue } from '../secrets/reference.ts'
import { isSealed, leaves, Resolver } from '../secrets/resolve.ts'
import { storedBytes } from '../secrets/variables.ts'
import { snapshotView } from '../volumes/backups.ts'

import {
  all,
  projectAll,
  project as select,
  type FieldTree,
  type Row,
  type View,
} from './fields.ts'
import type {
  AllocationRow,
  DeploymentRow,
  DomainRow,
  EnvironmentRow,
  PortRow,
  ProjectRow,
  ServiceRow,
  StagedRow,
  StationRow,
  VariableRow,
  VolumeRow,
} from './lookup.ts'
import * as shapes from './shapes.ts'

export const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null)

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
type SandboxRow = typeof sandbox.$inferSelect
type SandboxSnapshotRow = typeof sandbox_snapshot.$inferSelect
type EventRow = typeof event.$inferSelect
type ChannelRow = typeof notification_channel.$inferSelect

export const exportsOf = (db: Db, svc: ServiceRow) => {
  const host = `${svc.name}.internal`
  const port = db
    .select()
    .from(service_port)
    .where(eq(service_port.service_id, svc.id))
    .orderBy(asc(service_port.created_at), asc(service_port.port))
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

export const createViews = (db: Db) => {
  const stagedPending = (environmentId: string) =>
    db
      .select({
        n: count(),
      })
      .from(staged_change)
      .where(
        and(eq(staged_change.environment_id, environmentId), eq(staged_change.status, 'staged')),
      )
      .get()?.n ?? 0

  const servicesOf = (environmentId: string) =>
    db
      .select()
      .from(service)
      .where(eq(service.environment_id, environmentId))
      .orderBy(desc(service.id))
      .all()

  const portView: View<PortRow, typeof shapes.ServicePort> = {
    schema: shapes.ServicePort,
    full: (row) => ({
      ...stamps(row),
      service_id: row.service_id,
      port: row.port,
      protocol: row.protocol,
      grpc: row.grpc,
    }),
    summary: ['id', 'service_id', 'port', 'protocol', 'grpc'],
    expand: {
      domains: (row, sub) =>
        projectAll(
          domainView,
          db.select().from(domain).where(eq(domain.service_port_id, row.id)).all(),
          sub,
        ),
      port_allocations: (row, sub) =>
        projectAll(
          allocationView,
          db
            .select()
            .from(port_allocation)
            .where(eq(port_allocation.service_port_id, row.id))
            .all(),
          sub,
        ),
    },
  }

  const volumeView: View<VolumeRow, typeof shapes.Volume> = {
    schema: shapes.Volume,
    full: (row) => ({
      ...stamps(row),
      owner: row.owner,
      service_id: row.service_id,
      station_id: row.station_id,
      mount_path: row.mount_path,
      docker_name: row.docker_name,
      size_bytes: row.size_bytes,
      status: row.status,
      retain_until: iso(row.retain_until),
    }),
    summary: [
      'id',
      'owner',
      'service_id',
      'station_id',
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

  const stationOf = (id: string) => db.select().from(station).where(eq(station.id, id)).get()

  const dnsInstructions = (row: DomainRow) => {
    if (row.kind === 'generated') return []
    const ctx = db
      .select({
        station_id: service.station_id,
      })
      .from(service_port)
      .innerJoin(service, eq(service.id, service_port.service_id))
      .where(eq(service_port.id, row.service_port_id))
      .get()
    const address = ctx ? stationOf(ctx.station_id)?.public_address : null
    if (row.ingress === 'tunnel')
      return [
        {
          type: 'CNAME',
          name: row.hostname,
          value: '<tunnel id>.cfargotunnel.com',
          note: 'Tunnel ingress arrives in phase 1b.',
        },
      ]
    return [
      {
        type: 'A',
        name: row.hostname,
        value: address ?? null,
        note: address
          ? 'Point the name at the station.'
          : 'The station has not reported a public address yet.',
      },
    ]
  }

  const domainView: View<DomainRow, typeof shapes.Domain> = {
    schema: shapes.Domain,
    full: (row) => ({
      ...stamps(row),
      service_port_id: row.service_port_id,
      hostname: row.hostname,
      kind: row.kind,
      ingress: row.ingress,
      status: row.status,
      certificate: row.certificate ?? {
        status: 'pending',
        expires_at: null,
      },
      last_checked_at: iso(row.last_checked_at),
    }),
    summary: [
      'id',
      'service_port_id',
      'hostname',
      'kind',
      'ingress',
      'status',
      'certificate.status',
      'certificate.expires_at',
    ],
    expand: {
      dns_instructions: (row) => dnsInstructions(row),
      error: (row) => row.error,
    },
  }

  const allocationView: View<AllocationRow, typeof shapes.PortAllocation> = {
    schema: shapes.PortAllocation,
    full: (row) => {
      const stn = stationOf(row.station_id)
      return {
        ...stamps(row),
        service_port_id: row.service_port_id,
        station_id: row.station_id,
        host_port: row.host_port,
        status: row.status,
        address: stn?.public_address ? `${stn.public_address}:${row.host_port}` : null,
      }
    },
    summary: ['id', 'service_port_id', 'station_id', 'host_port', 'status', 'address'],
  }

  const snapshotIds = (snapshot: EnvSnapshot) =>
    (snapshot.entries ?? []).map((entry) => ({
      key: entry.key,
      variable_id: entry.variable_id,
      sealed: entry.sealed,
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
      service_id: row.service_id,
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
      'service_id',
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
        if (!row.build_id) return null
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
    if (!id) return null
    const row = db.select().from(deployment).where(eq(deployment.id, id)).get()
    return row ? select(deploymentView, row, sub) : null
  }

  const headVersion = (row: VariableRow) => {
    if (!row.current_value_id) return null
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
      variable_id: row.variable_id,
      environment_id: row.environment_id,
      version: row.version,
      bytes:
        db
          .select({
            kind: variable.kind,
          })
          .from(variable)
          .where(eq(variable.id, row.variable_id))
          .get()?.kind === 'sealed'
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
      'variable_id',
      'environment_id',
      'version',
      'bytes',
      'created_by',
      'created_at',
      'revoked_at',
      'needs_reentry',
      'pinned_by',
    ],
  }

  const variableView: View<VariableRow, typeof shapes.Variable> = {
    schema: shapes.Variable,
    full: (row) => {
      const base: Row = {
        ...stamps(row),
        scope: row.scope,
        project_id: row.project_id,
        service_id: row.service_id,
        sandbox_id: row.sandbox_id,
        key: row.key,
        kind: row.kind,
        reference: row.reference,
        injection: row.injection,
        build: row.build,
        head_version: headVersion(row),
        bytes:
          row.kind === 'sealed' && row.current_value_id
            ? storedBytes(db, row.current_value_id)
            : null,
        sealed: row.kind === 'sealed',
        value: null,
      }
      if (row.scope === 'project') {
        const held = db
          .select({
            environment_id: secret_value.environment_id,
          })
          .from(secret_value)
          .where(and(eq(secret_value.variable_id, row.id), isNull(secret_value.revoked_at)))
          .all()
        const envIds = [
          ...new Set(held.map((h) => h.environment_id).filter((id): id is string => id !== null)),
        ]
        const names = envIds.length
          ? db
              .select({
                name: environment.name,
              })
              .from(environment)
              .where(inArray(environment.id, envIds))
              .all()
              .map((e) => e.name)
          : []
        base.environments = [
          ...names.sort(),
          ...(held.some((h) => h.environment_id === null) ? ['default'] : []),
        ]
      }
      return base
    },
    summary: [
      'id',
      'scope',
      'key',
      'kind',
      'reference',
      'injection',
      'build',
      'head_version',
      'bytes',
      'environments',
    ],
    expand: {
      versions: (row, sub) =>
        projectAll(
          secretValueView,
          db
            .select()
            .from(secret_value)
            .where(eq(secret_value.variable_id, row.id))
            .orderBy(desc(secret_value.id))
            .all(),
          sub,
        ),
    },
  }

  const serviceView: View<ServiceRow, typeof shapes.Service> = {
    schema: shapes.Service,
    full: (row) => ({
      ...stamps(row),
      environment_id: row.environment_id,
      name: row.name,
      kind: row.kind,
      station_id: row.station_id,
      source: sourceView(row.source),
      command: row.command,
      build_args: row.build_args,
      limits: row.limits,
      health: row.health,
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
      'environment_id',
      'name',
      'kind',
      'status',
      'status_reason',
      'desired_state',
      'station_id',
      'source',
      'current_deployment_id',
      'stale',
      'stale_reasons',
    ],
    expand: {
      ports: (row, sub) =>
        projectAll(
          portView,
          db
            .select()
            .from(service_port)
            .where(eq(service_port.service_id, row.id))
            .orderBy(asc(service_port.port))
            .all(),
          sub,
        ),
      volumes: (row, sub) =>
        projectAll(
          volumeView,
          db.select().from(volume).where(eq(volume.service_id, row.id)).all(),
          sub,
        ),
      domains: (row, sub) => {
        const ports = db
          .select({
            id: service_port.id,
          })
          .from(service_port)
          .where(eq(service_port.service_id, row.id))
          .all()
          .map((p) => p.id)
        return ports.length
          ? projectAll(
              domainView,
              db.select().from(domain).where(inArray(domain.service_port_id, ports)).all(),
              sub,
            )
          : []
      },
      port_allocations: (row, sub) => {
        const ports = db
          .select({
            id: service_port.id,
          })
          .from(service_port)
          .where(eq(service_port.service_id, row.id))
          .all()
          .map((p) => p.id)
        return ports.length
          ? projectAll(
              allocationView,
              db
                .select()
                .from(port_allocation)
                .where(inArray(port_allocation.service_port_id, ports))
                .all(),
              sub,
            )
          : []
      },
      current_deployment: (row, sub) => deploymentSummary(row.current_deployment_id, sub),
      variables: (row, sub) =>
        projectAll(
          variableView,
          db
            .select()
            .from(variable)
            .where(and(eq(variable.scope, 'service'), eq(variable.service_id, row.id)))
            .orderBy(asc(variable.key))
            .all(),
          sub,
        ),
      exports: (row) => exportsOf(db, row),
    },
  }

  const edgesOf = (environmentId: string) => {
    const services = servicesOf(environmentId)
    const byName = new Map(services.map((s) => [s.name, s.id]))
    const edges = new Map<string, { from_service: string; to_service: string; keys: string[] }>()
    for (const svc of services) {
      const vars = db
        .select()
        .from(variable)
        .where(
          and(
            eq(variable.scope, 'service'),
            eq(variable.service_id, svc.id),
            eq(variable.kind, 'reference'),
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
          if (segment.type !== 'reference' || segment.target.type !== 'service') continue
          const to = byName.get(segment.target.service)
          if (!to) continue
          const id = `${svc.id}>${to}`
          const edge = edges.get(id) ?? {
            from_service: svc.id,
            to_service: to,
            keys: [],
          }
          if (!edge.keys.includes(v.key)) edge.keys.push(v.key)
          edges.set(id, edge)
        }
      }
    }
    return [...edges.values()]
  }

  const environmentView: View<EnvironmentRow, typeof shapes.Environment> = {
    schema: shapes.Environment,
    full: (row) => ({
      ...stamps(row),
      project_id: row.project_id,
      name: row.name,
      protected: row.protected,
      ephemeral: row.ephemeral,
      source_environment_id: row.source_environment_id,
      pull_request: row.pull_request,
      ttl_seconds: row.ttl_seconds,
      service_count:
        db
          .select({
            n: count(),
          })
          .from(service)
          .where(eq(service.environment_id, row.id))
          .get()?.n ?? 0,
      pending_staged_changes: stagedPending(row.id),
    }),
    summary: [
      'id',
      'project_id',
      'name',
      'protected',
      'ephemeral',
      'ttl_seconds',
      'pull_request',
      'service_count',
      'pending_staged_changes',
    ],
    expand: {
      services: (row, sub) => {
        const nested =
          sub && sub.size > 0
            ? sub
            : new Map([
                ['current_deployment', new Map()],
                ['domains', new Map()],
              ])
        return projectAll(serviceView, servicesOf(row.id), nested)
      },
      edges: (row) => edgesOf(row.id),
    },
  }

  const projectView: View<ProjectRow, typeof shapes.Project> = {
    schema: shapes.Project,
    full: (row) => {
      const envIds = db
        .select({
          id: environment.id,
        })
        .from(environment)
        .where(eq(environment.project_id, row.id))
        .all()
        .map((e) => e.id)
      const services = envIds.length
        ? db
            .select({
              status: service.status,
            })
            .from(service)
            .where(inArray(service.environment_id, envIds))
            .all()
        : []
      const status_counts = Object.fromEntries(
        serviceStatusValues.map((key) => [key, services.filter((s) => s.status === key).length]),
      )
      return {
        ...stamps(row),
        name: row.name,
        shared: row.shared,
        manifest_path: row.manifest_path,
        default_environment_id: row.default_environment_id,
        build_cache_bytes: row.build_cache_bytes,
        workshop_uid_base: row.workshop_uid_base,
        image_retention_count: row.image_retention_count,
        base_image_auto_rebuild: row.base_image_auto_rebuild,
        pr_environments: row.pr_environments,
        environment_count: envIds.length,
        service_count: services.length,
        status_counts,
      }
    },
    summary: [
      'id',
      'name',
      'default_environment_id',
      'environment_count',
      'service_count',
      'status_counts',
    ],
    expand: {
      environments: (row, sub) =>
        projectAll(
          environmentView,
          db
            .select()
            .from(environment)
            .where(eq(environment.project_id, row.id))
            .orderBy(desc(environment.id))
            .all(),
          sub,
        ),
      variables: (row, sub) =>
        projectAll(
          variableView,
          db
            .select()
            .from(variable)
            .where(and(eq(variable.scope, 'project'), eq(variable.project_id, row.id)))
            .orderBy(asc(variable.key))
            .all(),
          sub,
        ),
    },
  }

  const stagedView: View<StagedRow, typeof shapes.StagedChange> = {
    schema: shapes.StagedChange,
    full: (row) => {
      const changes = row.changes as { op: string; entity: string }[]
      return {
        ...stamps(row),
        environment_id: row.environment_id,
        status: row.status,
        source: row.source,
        actor: row.actor,
        accepted_by: row.accepted_by,
        summary: {
          add: changes.filter((c) => c.op === 'add' && c.entity !== 'deployment').length,
          update: changes.filter((c) => c.op === 'update').length,
          remove: changes.filter((c) => c.op === 'remove').length,
          deployments: changes.filter((c) => c.op === 'add' && c.entity === 'deployment').length,
        },
      }
    },
    summary: ['id', 'environment_id', 'status', 'source', 'actor', 'created_at', 'summary'],
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
                environment_id: '*',
                level: 'admin',
              },
            ]
          : row.scopes,
      expires_at: iso(row.expires_at),
      last_used_at: iso(row.last_used_at),
      client_id: row.client_id,
      station_id: row.station_id,
      used_at: iso(row.used_at),
    }),
    summary: ['id', 'name', 'kind', 'scopes', 'expires_at', 'last_used_at', 'client_id'],
  }

  const stationView: View<StationRow, typeof shapes.Station> = {
    schema: shapes.Station,
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
      public_address: row.public_address,
      sandbox_subnet: row.sandbox_subnet,
      sandbox_limits: row.sandbox_limits,
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
      sandbox_memory: (row) => sandboxMemory(db, row),
      generation_failure: (row) =>
        db
          .select({
            generation: station_generation.generation,
            ack: station_generation.ack,
            failure: station_generation.failure,
          })
          .from(station_generation)
          .where(
            and(eq(station_generation.station_id, row.id), eq(station_generation.ack, 'rejected')),
          )
          .orderBy(desc(station_generation.generation))
          .limit(1)
          .get() ?? null,
      components: (row) =>
        db
          .select()
          .from(component)
          .where(eq(component.station_id, row.id))
          .all()
          .map((c) => ({
            name: c.name,
            station_id: c.station_id,
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
      service_id: row.service_id,
      sandbox_id: row.sandbox_id,
      deployment_id: row.deployment_id,
      kind: row.kind,
      command: row.command,
      status: row.status,
      exit_code: row.exit_code,
      tty: row.tty,
      log_ref: row.log_ref,
      started_at: iso(row.started_at),
      finished_at: iso(row.finished_at),
    }),
    summary: [
      'id',
      'service_id',
      'sandbox_id',
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

  const sandboxSnapshotView: View<SandboxSnapshotRow, typeof shapes.SandboxSnapshot> = {
    schema: shapes.SandboxSnapshot,
    full: (row) => ({
      ...stamps(row),
      sandbox_id: row.sandbox_id,
      environment_id: row.environment_id,
      station_id: row.station_id,
      name: row.name,
      status: row.status,
      source_state: row.source_state,
      taken_at: iso(row.taken_at),
      exclusive_bytes: row.exclusive_bytes,
      referenced_bytes: row.referenced_bytes,
    }),
    summary: [
      'id',
      'sandbox_id',
      'environment_id',
      'station_id',
      'name',
      'status',
      'source_state',
      'taken_at',
      'exclusive_bytes',
      'referenced_bytes',
    ],
    expand: {
      image: (row) => row.image,
      size: (row) => row.size,
      failure: (row) => row.failure,
    },
  }

  const sandboxVariables = (row: SandboxRow) => {
    const resolver = Resolver.forSandbox(db, row.id)
    return resolver.sandboxVariables().map((v) => {
      try {
        const node = resolver.resolveSandbox(v)
        return {
          key: v.key,
          kind: v.kind,
          reference: v.reference,
          sealed: isSealed(node),
          sources: leaves(node).map((leaf) =>
            leaf.kind === 'value'
              ? {
                  from: leaf.from,
                  key: leaf.key,
                  version: leaf.version,
                }
              : {
                  from: 'export',
                  key: leaf.key,
                },
          ),
          error: null,
        }
      } catch (error) {
        if (!(error instanceof SecretsError)) throw error
        return {
          key: v.key,
          kind: v.kind,
          reference: v.reference,
          sealed: v.kind === 'sealed',
          sources: [],
          error: {
            code: error.code,
            explanation: error.message,
          },
        }
      }
    })
  }

  const sandboxView: View<SandboxRow, typeof shapes.Sandbox> = {
    schema: shapes.Sandbox,
    full: (row) => ({
      ...stamps(row),
      environment_id: row.environment_id,
      station_id: row.station_id,
      name: row.name,
      status: row.status,
      status_reason: row.status_reason,
      desired_state: row.desired_state,
      image: row.image,
      size: row.size,
      network: row.network,
      docker: row.docker,
      egress: {
        mode: row.egress.mode,
      },
      ttl_s: row.ttl_s,
      stop_at: iso(row.stop_at),
      delete_at: iso(deleteAt(row, retentionSeconds(db))),
      address: row.address,
      disk_used_bytes: row.disk_used_bytes,
      forked_from: row.forked_from,
      exit_code: row.exit_code,
      started_at: iso(row.started_at),
      stopped_at: iso(row.stopped_at),
    }),
    summary: [
      'id',
      'environment_id',
      'station_id',
      'name',
      'status',
      'status_reason',
      'desired_state',
      'image',
      'size',
      'network',
      'docker',
      'egress.mode',
      'ttl_s',
      'stop_at',
      'delete_at',
      'address',
      'disk_used_bytes',
      'forked_from',
      'created_at',
    ],
    expand: {
      egress: (row) => row.egress,
      failure: (row) => row.failure,
      command: (row) => row.command,
      snapshots: (row, sub) =>
        projectAll(
          sandboxSnapshotView,
          db
            .select()
            .from(sandbox_snapshot)
            .where(eq(sandbox_snapshot.sandbox_id, row.id))
            .orderBy(desc(sandbox_snapshot.id))
            .all(),
          sub,
        ),
      runs: (row, sub) =>
        projectAll(
          runView,
          db
            .select()
            .from(run)
            .where(eq(run.sandbox_id, row.id))
            .orderBy(desc(run.id))
            .limit(20)
            .all(),
          sub,
        ),
      variables: (row) => sandboxVariables(row),
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
    environment: environmentView,
    service: serviceView,
    port: portView,
    volume: volumeView,
    domain: domainView,
    allocation: allocationView,
    deployment: deploymentView,
    variable: variableView,
    secretValue: secretValueView,
    staged: stagedView,
    token: tokenView,
    station: stationView,
    audit: auditView,
    build: buildView,
    run: runView,
    sandbox: sandboxView,
    sandboxSnapshot: sandboxSnapshotView,
    event: eventView,
    channel: channelView,
    edges: edgesOf,
    all,
  }
}

export type Views = ReturnType<typeof createViews>
