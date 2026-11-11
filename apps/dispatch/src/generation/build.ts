import { isIP } from 'node:net'

import type { Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { and, asc, desc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm'

import {
  bridgeName,
  ContainerSpec,
  DesiredDeployment,
  DesiredEnvironment,
  DesiredPortAllocation,
  DesiredSandbox,
  DesiredSandboxSnapshot,
  DesiredService,
  DesiredVolume,
  Generation,
  networkLayout,
  Route,
  sandboxNetworkName,
  stationSettingKeys,
} from '@stationly/protocol'
import { releaseRepositories } from '@stationly/protocol/release-config'

import { dispatchVirtualIp } from '../api/ipam.ts'
import type { Db } from '../db/client.ts'
import {
  deployment,
  domain,
  environment,
  ipam_allocation,
  port_allocation,
  project,
  sandbox,
  sandbox_snapshot,
  service,
  service_port,
  station,
  station_generation,
  virtual_ip,
  volume,
} from '../db/schema.ts'
import { settingsSnapshot, type SettingsSnapshot } from '../db/settings.ts'
import { DomainError } from '../errors.ts'
import { parseCidr, slash24At } from '../net/cidr.ts'
import { pinnedRef } from '../platform/image-source.ts'
import { effectivePins } from '../platform/lockfile.ts'
import { projectRepositoryPrefix } from '../platform/registry.ts'
import { generationLockfile, overlayPins } from '../platform/upgrade.ts'
import { envDigest, generationEnv } from '../secrets/deploy.ts'
import { SecretsError } from '../secrets/errors.ts'
import { sandboxEnv } from '../secrets/sandbox.ts'

import { hashed, sha256Digest } from './hash.ts'
import { normalizeHealth } from './health.ts'

type GenerationDoc = Static<typeof Generation>
type ContainerSpecDoc = Static<typeof ContainerSpec>
type HealthCheck = ContainerSpecDoc['health']
type Settings = GenerationDoc['station']['settings']

export type GenerationContent = Omit<
  GenerationDoc,
  'number' | 'previous' | 'hash' | 'issued_at' | 'resolution'
>

export class GenerationError extends DomainError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('GENERATION_INVALID', message, undefined, details)
  }
}

const inFlightStatuses = [
  'queued',
  'pre_deploy',
  'starting',
  'waiting_health',
  'cutover',
  'draining',
] as const

const unlistedComponents = new Set(['docker_engine', 'grype_db'])

const budgetDefaults = {
  pull_s: 600,
  start_s: 120,
  health_s: 120,
  slack_s: 300,
}

const workshopCache = {
  reserved_bytes: 1024 ** 3,
  min_free_bytes: 5 * 1024 ** 3,
}

const subnetOfPool = (pool: string, index: number) => {
  const cidr = parseCidr(pool)

  if (!cidr || cidr.bits > 24) {
    throw new GenerationError(`ipam.pool ${pool} cannot hold the platform /24 bridges`)
  }

  return slash24At(pool, index)
}

const readSettings = (db: Db) => {
  const read = settingsSnapshot(db)
  const settings: Record<string, unknown> = {}

  for (const key of stationSettingKeys) {
    const value = read(key)

    if (value !== null) {
      settings[key] = value
    }
  }

  settings['acme.email'] ??= ''
  const lockfile = read('platform.lockfile')

  if (lockfile !== null) {
    settings['platform.lockfile'] = generationLockfile(db, lockfile)
  }

  return {
    settings: settings as Settings,
    read,
  }
}

const healthBudget = (health: HealthCheck) =>
  health && 'startup_timeout_s' in health ? health.startup_timeout_s : budgetDefaults.health_s

const healthWithHost = (db: Db, serviceId: string, health: HealthCheck): HealthCheck => {
  if (!health || health.type !== 'http' || health.host !== undefined) {
    return health
  }

  const first = db
    .select({
      hostname: domain.hostname,
    })
    .from(domain)
    .innerJoin(service_port, eq(domain.service_port_id, service_port.id))
    .where(eq(service_port.service_id, serviceId))
    .orderBy(asc(domain.id))
    .get()
  const name =
    db
      .select({
        name: service.name,
      })
      .from(service)
      .where(eq(service.id, serviceId))
      .get()?.name ?? serviceId

  return {
    ...health,
    host: first?.hostname ?? `${name}.internal`,
  }
}

type SpecInput = Pick<
  typeof deployment.$inferSelect,
  'service_id' | 'config_snapshot' | 'strategy'
> & { image_ref: string }

const specOf = (
  db: Db,
  dep: SpecInput,
  env: { env: ContainerSpecDoc['env']; env_digest: string },
): ContainerSpecDoc => {
  const config = dep.config_snapshot as {
    kind: string
    command: string[] | null
    limits: { cpu_millis: number; memory_bytes: number }
    health: HealthCheck
    readonly_rootfs: boolean
    secrets_owner: { uid: number; gid: number } | null
    drain_timeout_s: number
    pre_deploy: string[] | null
    schedule: ContainerSpecDoc['schedule']
  }
  const runsOnly = config.kind === 'cron' || config.kind === 'one_off'
  const ports = db
    .select()
    .from(service_port)
    .where(eq(service_port.service_id, dep.service_id))
    .orderBy(asc(service_port.created_at), asc(service_port.port))
    .all()
  const mounts = db
    .select()
    .from(volume)
    .where(and(eq(volume.service_id, dep.service_id), eq(volume.status, 'active')))
    .orderBy(asc(volume.id))
    .all()

  return {
    image_ref: dep.image_ref,
    command: config.command ?? null,
    limits: config.limits,
    health: healthWithHost(
      db,
      dep.service_id,
      config.health ?? normalizeHealth(config.kind, ports, undefined),
    ),
    ports: ports.map((p) => ({
      id: p.id,
      port: p.port,
      protocol: p.protocol,
      grpc: p.grpc,
    })),
    volumes: mounts.map((v) => ({
      volume_id: v.id,
      mount_path: v.mount_path,
    })),
    readonly_rootfs: config.readonly_rootfs,
    secrets_owner: config.secrets_owner ?? null,
    drain_timeout_s: config.drain_timeout_s,
    strategy: runsOnly ? null : dep.strategy,
    pre_deploy: config.pre_deploy ?? null,
    schedule: config.schedule ?? null,
    env: env.env,
    env_digest: env.env_digest,
  }
}

const containerSpec = (db: Db, deploymentId: string): ContainerSpecDoc => {
  const dep = db.select().from(deployment).where(eq(deployment.id, deploymentId)).get()

  if (!dep) {
    throw new GenerationError(`deployment ${deploymentId} does not exist`)
  }

  if (!dep.image_ref) {
    throw new GenerationError(`deployment ${deploymentId} has no image_ref yet`)
  }

  return specOf(
    db,
    {
      ...dep,
      image_ref: dep.image_ref,
    },
    generationEnv(db, dep.id),
  )
}

const placeholderDigest = `sha256:${'0'.repeat(64)}`

export const targetIssue = (
  db: Db,
  dep: Omit<SpecInput, 'image_ref'> & { image_ref: string | null },
) => {
  const target = specOf(
    db,
    {
      ...dep,
      image_ref: dep.image_ref ?? `registry.invalid/build@${placeholderDigest}`,
    },
    {
      env: [],
      env_digest: placeholderDigest,
    },
  )

  if (Value.Check(ContainerSpec, target)) {
    return null
  }

  const issue = Value.Errors(ContainerSpec, target).First()

  return {
    path: `/target${issue?.path ?? ''}`,
    message: issue?.message ?? 'does not match ContainerSpec',
  }
}

export type ExcludedObject =
  | 'environment'
  | 'service'
  | 'deployment'
  | 'volume'
  | 'route'
  | 'port_allocation'
  | 'sandbox'
  | 'sandbox_snapshot'

export type Exclusion = {
  object: ExcludedObject
  id: string
  key: string
  explanation: string
  carried: boolean
  dispatched: boolean
}

export type Built = { content: GenerationContent; excluded: Exclusion[] }

export type Skip = Map<string, string>

const objectKeys: Record<ExcludedObject, (id: string) => string> = {
  environment: (id) => `/environments/${id}`,
  service: (id) => `/services/${id}`,
  deployment: (id) => `/deployments/${id}`,
  volume: (id) => `/volumes/${id}`,
  route: (id) => `/gateway/routes/${id}`,
  port_allocation: (id) => `/port_allocations/${id}`,
  sandbox: (id) => `/sandboxes/${id}`,
  sandbox_snapshot: (id) => `/sandbox_snapshots/${id}`,
}

export const objectAt = (path: string): { object: ExcludedObject; id: string } | null => {
  const m =
    /^\/(environments|services|deployments|volumes|port_allocations|gateway\/routes|sandboxes|sandbox_snapshots)\/([^/]+)/.exec(
      path,
    )

  if (!m) {
    return null
  }

  const object = (
    {
      environments: 'environment',
      services: 'service',
      deployments: 'deployment',
      volumes: 'volume',
      port_allocations: 'port_allocation',
      'gateway/routes': 'route',
      sandboxes: 'sandbox',
      sandbox_snapshots: 'sandbox_snapshot',
    } as const
  )[m[1] as 'environments']

  return {
    object,
    id: m[2]!,
  }
}

export const keyOf = (object: ExcludedObject, id: string) => objectKeys[object](id)

const conform = (schema: Parameters<typeof Value.Check>[0], doc: unknown, at: string) => {
  if (Value.Check(schema, doc)) {
    return
  }

  const issue = Value.Errors(schema, doc).First()

  throw new GenerationError(
    `${at}${issue?.path ?? ''}: ${issue?.message ?? 'does not match its schema'}`,
    {
      path: `${at}${issue?.path ?? ''}`,
    },
  )
}

const unbuildable = (error: unknown): error is Error =>
  error instanceof GenerationError || error instanceof SecretsError

export const systemRouteIds = {
  dashboard: 'system-dashboard',
  api: 'system-api',
  address: 'system-address',
} as const

type SystemRoute = {
  id: string
  hostname: string
  resolver: 'letsencrypt' | 'letsencrypt-shortlived'
}

const systemRoutes = (read: SettingsSnapshot, publicAddress: string | null): SystemRoute[] => {
  const dashboard = read('hostnames.dashboard')
  const api = read('hostnames.api')

  if (typeof dashboard === 'string' && dashboard && typeof api === 'string' && api) {
    return [
      {
        id: systemRouteIds.api,
        hostname: api,
        resolver: 'letsencrypt',
      },
      {
        id: systemRouteIds.dashboard,
        hostname: dashboard,
        resolver: 'letsencrypt',
      },
    ]
  }

  return publicAddress
    ? [
        {
          id: systemRouteIds.address,
          hostname: publicAddress,
          resolver: 'letsencrypt-shortlived',
        },
      ]
    : []
}

export const buildContent = (db: Db, stationId: string, skip: Skip = new Map()): Built => {
  const st = db.select().from(station).where(eq(station.id, stationId)).get()

  if (!st) {
    throw new GenerationError(`station ${stationId} does not exist`)
  }

  if (!st.registry_address || !st.registry_subnet) {
    throw new GenerationError(`station ${stationId} has no registry address yet`)
  }

  const { settings, read } = readSettings(db)
  const instanceId = read('instance.id')

  if (typeof instanceId !== 'string') {
    throw new GenerationError('the instance.id setting is missing')
  }

  if (!read('platform.lockfile')) {
    throw new GenerationError(
      'platform.lockfile is not set yet; sly setup writes it from the release stationd install verified',
    )
  }

  const previous = db
    .select({
      document: station_generation.document,
    })
    .from(station_generation)
    .where(eq(station_generation.station_id, stationId))
    .orderBy(desc(station_generation.generation))
    .limit(1)
    .get()?.document
  const excluded: Exclusion[] = []
  const guarded = <T>(
    object: ExcludedObject,
    id: string,
    carry: T | undefined,
    build: () => T,
    dispatched = false,
  ): T | undefined => {
    const key = keyOf(object, id)

    try {
      const reason = skip.get(key)

      if (reason) {
        throw new GenerationError(reason)
      }

      return build()
    } catch (error) {
      if (!unbuildable(error)) {
        throw error
      }

      excluded.push({
        object,
        id,
        key,
        explanation: error.message,
        carried: carry !== undefined,
        dispatched,
      })

      return carry
    }
  }

  const services = db
    .select()
    .from(service)
    .where(eq(service.station_id, stationId))
    .orderBy(asc(service.id))
    .all()
  const serviceIds = services.map((s) => s.id)
  const sandboxCapable = Boolean(st.capabilities?.sandboxes)
  const sandboxRows = sandboxCapable
    ? db
        .select()
        .from(sandbox)
        .where(eq(sandbox.station_id, stationId))
        .orderBy(asc(sandbox.id))
        .all()
    : []
  const joinedEnvironmentIds = sandboxRows
    .filter((r) => r.network === 'environment' && r.status !== 'deleting')
    .map((r) => r.environment_id)
  const environmentIds = [
    ...new Set([...services.map((s) => s.environment_id), ...joinedEnvironmentIds]),
  ].sort()
  const environments = environmentIds.length
    ? db.select().from(environment).where(inArray(environment.id, environmentIds)).all()
    : []
  const vips = environmentIds.length
    ? db
        .select()
        .from(virtual_ip)
        .where(inArray(virtual_ip.environment_id, environmentIds))
        .orderBy(asc(virtual_ip.address))
        .all()
    : []
  const vipOf = new Map(vips.filter((v) => v.service_id).map((v) => [v.service_id!, v]))
  const serviceById = new Map(services.map((s) => [s.id, s]))
  const projectOf = new Map(environments.map((e) => [e.id, e.project_id]))

  const volumeDocs: GenerationContent['volumes'] = {}

  for (const v of db
    .select()
    .from(volume)
    .where(eq(volume.station_id, stationId))
    .orderBy(asc(volume.id))
    .all()) {
    const status = v.status

    if (status === 'destroyed') {
      continue
    }

    const doc = guarded('volume', v.id, previous?.volumes[v.id], () => {
      const built = hashed({
        owner: v.owner,
        service_id: v.service_id ?? null,
        docker_name: v.docker_name,
        status,
        retain_until: v.retain_until
          ? v.retain_until.toISOString().replace(/\.\d{3}Z$/, 'Z')
          : null,
      })

      conform(DesiredVolume, built, keyOf('volume', v.id))

      return built
    })

    if (doc) {
      volumeDocs[v.id] = doc
    }
  }

  const spec = (deploymentId: string, at: string) => {
    const target = containerSpec(db, deploymentId)

    conform(ContainerSpec, target, at)

    for (const mount of target.volumes) {
      if (!volumeDocs[mount.volume_id]) {
        throw new GenerationError(
          `${at}/volumes: volume ${mount.volume_id} is not in this station's generation`,
        )
      }
    }

    return target
  }

  const environmentDoc = (
    env: (typeof environments)[number],
    keep: (serviceId: string) => boolean,
  ) => {
    const allocation = db
      .select()
      .from(ipam_allocation)
      .where(
        and(eq(ipam_allocation.environment_id, env.id), eq(ipam_allocation.station_id, stationId)),
      )
      .get()

    if (!allocation) {
      throw new GenerationError(
        `environment ${env.id} has no ipam_allocation on station ${stationId}`,
      )
    }

    const envVips = vips.filter(
      (v) =>
        v.environment_id === env.id &&
        v.service_id &&
        serviceById.has(v.service_id) &&
        keep(v.service_id),
    )
    const built = hashed({
      project_id: env.project_id,
      name: env.name,
      ipam_allocation_id: allocation.id,
      network: {
        bridge_name: bridgeName(env.id),
        subnet: allocation.subnet,
        gateway: allocation.gateway,
        gateway_mode: 'nat' as const,
      },
      dns: envVips.map((v) => {
        const svc = serviceById.get(v.service_id!)!

        return {
          name: svc.name,
          virtual_ip: v.address,
          kind: 'service' as const,
          target_service_id: svc.id,
        }
      }),
      virtual_ips: envVips.map((v) => ({
        id: v.id,
        address: v.address,
        service_id: v.service_id!,
      })),
    })

    conform(DesiredEnvironment, built, keyOf('environment', env.id))

    return built
  }

  const environmentDocs: GenerationContent['environments'] = {}

  for (const env of environments) {
    const doc = guarded('environment', env.id, previous?.environments[env.id], () =>
      environmentDoc(env, () => true),
    )

    if (doc) {
      environmentDocs[env.id] = doc
    }
  }

  const serviceDocs: GenerationContent['services'] = {}

  for (const svc of services) {
    const at = keyOf('service', svc.id)
    const doc = guarded('service', svc.id, previous?.services[svc.id], () => {
      if (!environmentDocs[svc.environment_id]) {
        throw new GenerationError(
          `${at}: environment ${svc.environment_id} is not in this generation`,
        )
      }

      const vip = vipOf.get(svc.id)

      if (!vip) {
        throw new GenerationError(`service ${svc.id} has no virtual_ip`)
      }

      let current = null

      if (svc.current_deployment_id) {
        const dep = db
          .select({
            number: deployment.number,
          })
          .from(deployment)
          .where(eq(deployment.id, svc.current_deployment_id))
          .get()

        if (!dep) {
          throw new GenerationError(
            `service ${svc.id} names current deployment ${svc.current_deployment_id}, which does not exist`,
          )
        }

        current = {
          deployment_id: svc.current_deployment_id,
          number: dep.number,
          spec: spec(svc.current_deployment_id, `${at}/current/spec`),
        }
      }

      const built = hashed({
        environment_id: svc.environment_id,
        project_id: projectOf.get(svc.environment_id)!,
        name: svc.name,
        kind: svc.kind,
        desired_state: svc.desired_state,
        virtual_ip: vip.address,
        current,
        reach: vips
          .filter((v) => v.environment_id === svc.environment_id && v.service_id)
          .map((v) => v.id),
      })

      conform(DesiredService, built, at)

      return built
    })

    if (doc && environmentDocs[doc.environment_id]) {
      serviceDocs[svc.id] = doc
    }
  }

  if (excluded.length) {
    const carried = new Set(excluded.filter((e) => e.carried).map((e) => e.key))

    for (const env of environments) {
      if (environmentDocs[env.id] && !carried.has(keyOf('environment', env.id))) {
        environmentDocs[env.id] = environmentDoc(env, (id) => Boolean(serviceDocs[id]))
      }
    }

    for (const [id, doc] of Object.entries(serviceDocs)) {
      if (carried.has(keyOf('service', id))) {
        continue
      }

      const reachable = new Set(
        (environmentDocs[doc.environment_id]?.virtual_ips ?? []).map((v) => v.id),
      )
      const reach = doc.reach.filter((v) => reachable.has(v))

      if (reach.length !== doc.reach.length) {
        const { hash: _hash, ...rest } = doc

        serviceDocs[id] = hashed({
          ...rest,
          reach,
        })
      }
    }
  }

  const pins = overlayPins(db, stationId, effectivePins(db, st.arch))

  const desiredSandbox = (row: (typeof sandboxRows)[number]) => {
    const at = keyOf('sandbox', row.id)
    const destroy = row.status === 'deleting'

    if (!destroy && row.network === 'environment' && !environmentDocs[row.environment_id]) {
      throw new GenerationError(
        `${at}: environment ${row.environment_id} is not in this generation`,
      )
    }

    const image_ref =
      row.image.ref === null
        ? `${pins.sandbox_toolchain?.source ?? releaseRepositories.sandbox_toolchain}@${row.image.digest}`
        : pinnedRef(row.image.ref, row.image.digest)
    const built = hashed({
      environment_id: row.environment_id,
      project_id: row.project_id,
      name: row.name,
      status: destroy ? ('destroy' as const) : ('active' as const),
      desired_state: row.desired_state,
      stop_at: row.stop_at ? timestamp(row.stop_at) : null,
      runtime: row.runtime,
      image: {
        ref: row.image.ref,
        digest: row.image.digest,
        image_ref,
      },
      command: row.command ?? null,
      size: row.size,
      docker: row.docker,
      env_digest: destroy ? envDigest([]) : sandboxEnv(db, row.id).env_digest,
      network: row.network,
      egress: row.egress,
      disk: {
        from: row.disk_from ?? null,
      },
      reach:
        row.network === 'environment' && !destroy
          ? vips
              .filter((v) => v.environment_id === row.environment_id && v.service_id)
              .map((v) => v.id)
          : [],
      ...(row.workspace
        ? {
            api_relay: true as const,
          }
        : {}),
    })

    conform(DesiredSandbox, built, at)

    return built
  }
  const sandboxDocs: Record<string, Static<typeof DesiredSandbox>> = {}

  for (const row of sandboxRows) {
    const doc = guarded('sandbox', row.id, previous?.sandboxes?.[row.id], () => desiredSandbox(row))

    if (doc) {
      sandboxDocs[row.id] = doc
    }
  }

  const snapshotDocs: Record<
    string,
    { hash: string; sandbox_id: string; status: 'active' | 'destroy' }
  > = {}

  if (sandboxCapable) {
    for (const snap of db
      .select()
      .from(sandbox_snapshot)
      .where(eq(sandbox_snapshot.station_id, stationId))
      .orderBy(asc(sandbox_snapshot.id))
      .all()) {
      if (snap.status === 'failed') {
        continue
      }

      const doc = guarded(
        'sandbox_snapshot',
        snap.id,
        previous?.sandbox_snapshots?.[snap.id],
        () => {
          const built = hashed({
            sandbox_id: snap.sandbox_id,
            status: snap.status === 'deleting' ? ('destroy' as const) : ('active' as const),
          })

          conform(DesiredSandboxSnapshot, built, keyOf('sandbox_snapshot', snap.id))

          return built
        },
      )

      if (doc) {
        snapshotDocs[snap.id] = doc
      }
    }
  }

  const candidates = serviceIds.length
    ? db
        .select()
        .from(deployment)
        .where(
          and(
            inArray(deployment.service_id, serviceIds),
            isNotNull(deployment.image_ref),
            isNull(deployment.finished_at),
            or(
              inArray(deployment.status, [...inFlightStatuses]),
              and(eq(deployment.status, 'cancelled'), isNotNull(deployment.cancel_reason)),
            ),
          ),
        )
        .orderBy(asc(deployment.created_at), asc(deployment.id))
        .all()
    : []
  const deploymentDocs: GenerationContent['deployments'] = {}
  const perService = new Set<string>()
  let uncancelled = 0
  let variableChangeAdmitted = false
  const dispatched = new Set(Object.keys(previous?.deployments ?? {}))
  const started = (dep: (typeof candidates)[number]) =>
    dispatched.has(dep.id) || dep.status !== 'queued' ? 0 : 1

  for (const dep of [...candidates].sort((a, b) => started(a) - started(b))) {
    const cancelled = dep.status === 'cancelled'
    const serial = dep.trigger.type === 'variable_change'

    if (
      !cancelled &&
      (perService.has(dep.service_id) ||
        uncancelled >= st.concurrency_cap ||
        (serial && variableChangeAdmitted))
    ) {
      continue
    }

    const svc = serviceById.get(dep.service_id)!

    if (svc.current_deployment_id === dep.id) {
      continue
    }

    const at = keyOf('deployment', dep.id)
    const wasSent = dispatched.has(dep.id)
    const doc = guarded(
      'deployment',
      dep.id,
      wasSent ? previous!.deployments[dep.id] : undefined,
      () => {
        if (!serviceDocs[dep.service_id]) {
          throw new GenerationError(`${at}: service ${dep.service_id} is not in this generation`)
        }

        const target = spec(dep.id, `${at}/target`)
        const drain = target.drain_timeout_s
        const health = healthBudget(target.health)
        const built = hashed({
          service_id: dep.service_id,
          number: dep.number,
          target,
          from_deployment_id: svc.current_deployment_id ?? null,
          strategy: dep.strategy,
          budget: {
            pull_s: budgetDefaults.pull_s,
            start_s: budgetDefaults.start_s,
            health_s: health,
            drain_s: drain,
            total_s:
              budgetDefaults.pull_s +
              budgetDefaults.start_s +
              health +
              drain +
              budgetDefaults.slack_s,
          },
          supersedes: null,
          cancel: cancelled
            ? {
                reason: dep.cancel_reason!,
              }
            : null,
        })

        conform(DesiredDeployment, built, at)

        return built
      },
      wasSent,
    )

    if (!doc || !serviceDocs[doc.service_id]) {
      continue
    }

    deploymentDocs[dep.id] = doc

    if (!cancelled) {
      perService.add(dep.service_id)
      uncancelled++

      if (serial) {
        variableChangeAdmitted = true
      }
    }
  }

  const ports = serviceIds.length
    ? db.select().from(service_port).where(inArray(service_port.service_id, serviceIds)).all()
    : []
  const portById = new Map(ports.map((p) => [p.id, p]))
  const routes: GenerationContent['gateway']['routes'] = {}
  const dispatchTarget = st.hosts_dispatch
    ? {
        system: 'dispatch' as const,
        virtual_ip: dispatchVirtualIp(settings['ipam.virtual_prefix']),
        port: networkLayout.dispatchPort,
      }
    : null
  const systemHosts = new Map<string, string>()

  if (dispatchTarget) {
    for (const r of systemRoutes(read, st.public_address)) {
      const route = guarded('route', r.id, previous?.gateway.routes[r.id], () => {
        if (!st.public_address) {
          throw new GenerationError(
            `${keyOf('route', r.id)}: ${r.hostname} is a direct route, which needs the station's public_address; set it with sly stations update ${st.name} --public-address <ipv4>`,
          )
        }

        const built = hashed({
          hostname: r.hostname,
          ingress: 'direct' as const,
          target: dispatchTarget,
          tls: {
            resolver: r.resolver,
          },
          redirect_http: true,
        })

        conform(Route, built, keyOf('route', r.id))

        return built
      })

      if (route) {
        routes[r.id] = route
        systemHosts.set(route.hostname, r.id)
      }
    }
  }

  if (ports.length) {
    for (const d of db
      .select()
      .from(domain)
      .where(inArray(domain.service_port_id, [...portById.keys()]))
      .orderBy(asc(domain.id))
      .all()) {
      const route = guarded('route', d.id, previous?.gateway.routes[d.id], () => {
        const port = portById.get(d.service_port_id)!
        const taken = systemHosts.get(d.hostname)

        if (taken) {
          throw new GenerationError(
            `${keyOf('route', d.id)}: ${d.hostname} is Dispatch's own hostname (route ${taken}); remove the domain or change the hostnames setting`,
          )
        }

        const vip = vipOf.get(port.service_id)

        if (!serviceDocs[port.service_id] || !vip) {
          throw new GenerationError(
            `${keyOf('route', d.id)}: service ${port.service_id} is not in this generation`,
          )
        }

        const direct = d.ingress === 'direct'
        const resolver: SystemRoute['resolver'] =
          d.certificate?.resolver === 'letsencrypt-shortlived' || isIP(d.hostname)
            ? 'letsencrypt-shortlived'
            : 'letsencrypt'
        const built = hashed({
          hostname: d.hostname,
          ingress: d.ingress,
          target: {
            service_id: port.service_id,
            virtual_ip: vip.address,
            port: port.port,
          },
          tls: direct
            ? {
                resolver,
              }
            : null,
          redirect_http: direct,
        })

        conform(Route, built, keyOf('route', d.id))

        return built
      })

      if (route && 'service_id' in route.target && serviceDocs[route.target.service_id]) {
        routes[d.id] = route
      }
    }
  }

  const allocationDocs: GenerationContent['port_allocations'] = {}

  for (const pa of db
    .select()
    .from(port_allocation)
    .where(and(eq(port_allocation.station_id, stationId), eq(port_allocation.status, 'active')))
    .orderBy(asc(port_allocation.id))
    .all()) {
    const port = portById.get(pa.service_port_id)

    if (!port) {
      continue
    }

    const doc = guarded('port_allocation', pa.id, previous?.port_allocations[pa.id], () => {
      const vip = vipOf.get(port.service_id)

      if (!serviceDocs[port.service_id] || !vip) {
        throw new GenerationError(
          `${keyOf('port_allocation', pa.id)}: service ${port.service_id} is not in this generation`,
        )
      }

      const built = hashed({
        service_port_id: pa.service_port_id,
        service_id: port.service_id,
        host_port: pa.host_port,
        protocol: 'tcp' as const,
        virtual_ip: vip.address,
        container_port: port.port,
      })

      conform(DesiredPortAllocation, built, keyOf('port_allocation', pa.id))

      return built
    })

    if (doc && serviceDocs[doc.service_id]) {
      allocationDocs[pa.id] = doc
    }
  }

  const projectIds = [...new Set(environments.map((e) => e.project_id))].sort()
  const workshopDocs: GenerationContent['workshops'] = {}

  for (const p of projectIds.length
    ? db.select().from(project).where(inArray(project.id, projectIds)).all()
    : []) {
    workshopDocs[p.id] = hashed({
      cache: {
        reserved_bytes: workshopCache.reserved_bytes,
        max_used_bytes: p.build_cache_bytes,
        min_free_bytes: workshopCache.min_free_bytes,
      },
      max_builds: settings['workshop.max_builds_per_project'],
      idle_timeout_s: settings['workshop.idle_timeout_s'],
      uid_base: p.workshop_uid_base,
      image_retention_count: p.image_retention_count,
      registry_scope: `${projectRepositoryPrefix(p.id)}*`,
      mirrors: [],
    })
  }

  const components: GenerationContent['components'] = {}

  for (const [name, pin] of Object.entries(pins).sort(([a], [b]) => a.localeCompare(b))) {
    if (unlistedComponents.has(name)) {
      continue
    }

    components[name] = {
      version: pin.version,
      digest: pin.digest,
    }
  }

  const gatewayAcme = {
    email: settings['acme.email'],
    ca_server: read('acme.ca_server'),
  }
  const hasDirect = Object.values(routes).some((r) => r.ingress === 'direct')
  const ingressMode = read('ingress.mode') === 'tunnel' ? ('tunnel' as const) : ('direct' as const)

  return {
    excluded,
    content: {
      schema: 1,
      instance_id: instanceId,
      station_id: stationId,
      station: {
        settings,
        registry: {
          address: st.registry_address,
          subnet: st.registry_subnet,
          token_issuer: 'stationd',
          pull_scope: 'station',
          key_ref: 'registry-token.key',
        },
        networks: {
          system: subnetOfPool(settings['ipam.pool'], networkLayout.systemIndex),
          ingress: subnetOfPool(settings['ipam.pool'], networkLayout.ingressIndex),
        },
        inbound: {
          mode: ingressMode,
          web_ports: hasDirect ? 'open' : 'closed',
          setup_port_until: null,
        },
        public_address: st.public_address ?? null,
        concurrency_cap: st.concurrency_cap,
        intermittent: st.intermittent,
        hosts_dispatch: st.hosts_dispatch,
        ...(sandboxCapable
          ? {
              sandbox_network: st.sandbox_subnet
                ? {
                    bridge_name: sandboxNetworkName,
                    subnet: st.sandbox_subnet,
                    gateway: st.sandbox_subnet.replace(/\.0\/\d+$/, '.1'),
                  }
                : null,
            }
          : {}),
      },
      components,
      environments: environmentDocs,
      services: serviceDocs,
      deployments: deploymentDocs,
      volumes: volumeDocs,
      gateway: hashed({
        acme: gatewayAcme,
        routes,
      }),
      port_allocations: allocationDocs,
      workshops: workshopDocs,
      system_targets: dispatchTarget
        ? {
            dispatch: hashed({
              component: 'dispatch',
              virtual_ip: dispatchTarget.virtual_ip,
              port: dispatchTarget.port,
            }),
          }
        : {},
      ...(sandboxCapable
        ? {
            sandboxes: sandboxDocs,
            sandbox_snapshots: snapshotDocs,
          }
        : {}),
    },
  }
}

export const contentDigest = (content: GenerationContent) => sha256Digest(content)

export const contentOf = (doc: GenerationDoc): GenerationContent => {
  const { number: _n, previous: _p, hash: _h, issued_at: _i, resolution: _r, ...content } = doc

  return content
}

const timestamp = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, 'Z')

export const seal = (
  content: GenerationContent,
  envelope: {
    number: number
    previous: number | null
    issued_at: Date
    resolution: GenerationDoc['resolution']
  },
): GenerationDoc => {
  const unhashed = {
    ...content,
    number: envelope.number,
    previous: envelope.previous,
    issued_at: timestamp(envelope.issued_at),
    resolution: envelope.resolution,
  }
  const doc = hashed(unhashed)

  if (!Value.Check(Generation, doc)) {
    const issue = Value.Errors(Generation, doc).First()

    throw new GenerationError(
      `the generation does not match its schema at ${issue?.path}: ${issue?.message}`,
      {
        path: issue?.path,
      },
    )
  }

  return doc
}
