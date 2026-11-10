import { Type, type TObject, type Static as TStatic } from '@sinclair/typebox'
import { and, desc, eq } from 'drizzle-orm'
import { Elysia, t, type Static } from 'elysia'

import type { Principal } from '../../auth/principal.ts'
import { deployment, service, service_port, station, variable, volume } from '../../db/schema.ts'
import { normalizeHealth } from '../../generation/health.ts'
import { pinImageSource, pinnedWarning } from '../../platform/image-source.ts'
import { parseValue } from '../../secrets/reference.ts'
import { requireLevel } from '../access.ts'
import {
  ChangeSet,
  commit,
  leafDiff,
  requireProtocolChangeAllowed,
  type CommitResult,
} from '../changes.ts'
import { configDeployTrigger, configFields, requireStationReady } from '../deployments.ts'
import { fail, invalid } from '../errors.ts'
import { project as select } from '../fields.ts'
import { warning, type Kit } from '../kit.ts'
import {
  environmentById,
  serviceById,
  type EnvironmentRow,
  type ServiceContext,
  type ServiceRow,
} from '../lookup.ts'
import { before, collect, getQuery, listQuery } from '../pagination.ts'
import { ServiceCreate, ServicePatch } from '../schemas.ts'
import {
  component,
  DeletedRetaining,
  Deployment,
  extend,
  models,
  Page,
  replies,
  Service,
  Staged,
  Warnings,
  type Ref,
} from '../shapes.ts'
import { planVariables } from '../variable-changes.ts'

export const withDeployments = <S extends TObject>(schema: S | Ref<S>) =>
  extend(schema, {
    deployments: Type.Array(Deployment),
    warnings: Warnings,
  })

const ServiceWritten = component('ServiceWritten', withDeployments(Service))

const ServiceStarted = extend(Service, {
  deployments: Type.Array(Deployment),
})

type CreateBody = Static<typeof ServiceCreate>
type PatchBody = Static<typeof ServicePatch>
type HealthBody = NonNullable<CreateBody['health']>

const defaultLimits = {
  cpu_millis: 1000,
  memory_bytes: 536870912,
}
const fullHealth = (kind: string, health: HealthBody | null | undefined) =>
  health ? normalizeHealth(kind, [], health) : null

const kindTakesPorts = (kind: string) => kind === 'web'

const placeStation = (kit: Kit, stationId: string | undefined) => {
  const { db } = kit.deps
  if (stationId) {
    const row = db.select().from(station).where(eq(station.id, stationId)).get()
    if (!row)
      return invalid([
        {
          path: '/station_id',
          message: `station ${stationId} does not exist`,
        },
      ])
    if (row.draining)
      return invalid([
        {
          path: '/station_id',
          message: `station ${row.name} is draining, so no new services are placed on it`,
        },
      ])
    return stationId
  }
  const online = db
    .select({
      id: station.id,
    })
    .from(station)
    .where(and(eq(station.status, 'online'), eq(station.draining, false)))
    .all()
  if (online.length !== 1)
    invalid([
      {
        path: '/station_id',
        message: `required unless exactly one station is online (${online.length} are)`,
      },
    ])
  return online[0]!.id
}

const strategyCheck = (strategy: string, volumes: number, multiWriterSafe: boolean) => {
  if (strategy === 'overlap' && volumes > 0 && !multiWriterSafe) {
    fail(
      'STRATEGY_VOLUME_CONFLICT',
      'overlap runs two containers at once, which is unsafe with a volume.',
      'Use strategy = replace, or set multi_writer_safe = true if the program tolerates two writers.',
    )
  }
}

const portIssues = (kind: string, ports: { port: number }[]) => {
  if (kind === 'web' && ports.length === 0)
    return [
      {
        path: '/ports',
        message: 'a web service needs at least one port',
      },
    ]
  if (!kindTakesPorts(kind) && ports.length > 0)
    return [
      {
        path: '/ports',
        message: `a ${kind} service has no ports`,
      },
    ]
  const seen = new Set<number>()
  return ports.flatMap((p, i) =>
    seen.has(p.port)
      ? [
          {
            path: `/ports/${i}/port`,
            message: 'port appears twice',
          },
        ]
      : (seen.add(p.port), []),
  )
}

export const dependentsOfService = (kit: Kit, svc: ServiceRow) =>
  kit.deps.db
    .select({
      id: variable.id,
      key: variable.key,
      service_id: variable.service_id,
      reference: variable.reference,
    })
    .from(variable)
    .innerJoin(service, eq(service.id, variable.service_id))
    .where(and(eq(variable.kind, 'reference'), eq(service.environment_id, svc.environment_id)))
    .all()
    .filter((v) => v.service_id !== svc.id)
    .filter((v) => {
      try {
        return parseValue(v.reference ?? '').some(
          (s) =>
            s.type === 'reference' && s.target.type === 'service' && s.target.service === svc.name,
        )
      } catch {
        return false
      }
    })
    .map((v) => ({
      entity: 'variable',
      id: v.id,
      key: v.key,
      service_id: v.service_id,
    }))

export const respond = <B extends object>(
  kit: Kit,
  set: { status?: number | string },
  result: CommitResult,
  body: () => B,
  warnings: TStatic<typeof Warnings> = [],
):
  | TStatic<typeof Staged>
  | (B & { deployments: TStatic<typeof Deployment>[]; warnings: TStatic<typeof Warnings> }) => {
  if (!result.applied) return kit.stagedBody(result, set)
  const deployments = result.deployments.map((id) =>
    select(
      kit.views.deployment,
      kit.deps.db.select().from(deployment).where(eq(deployment.id, id)).get()!,
      undefined,
    ),
  )
  const replaceWarning = deployments.some((d) => d.strategy === 'replace')
    ? [
        warning(
          'DOWNTIME_EXPECTED',
          'strategy = replace stops the old container before the new one is healthy.',
        ),
      ]
    : []
  return {
    ...body(),
    deployments,
    warnings: [...warnings, ...replaceWarning],
  }
}

const onlyOnlineStation = (kit: Kit) => {
  const online = kit.deps.db
    .select({
      id: station.id,
    })
    .from(station)
    .where(and(eq(station.status, 'online'), eq(station.draining, false)))
    .all()
  return online.length === 1 ? online[0]!.id : null
}

const authorizeSource = async (
  kit: Kit,
  body: { source?: CreateBody['source']; station_id?: string },
  current?: ServiceRow,
) => {
  const source = body.source
  if (source?.type === 'image') {
    const stationId = body.station_id ?? current?.station_id ?? onlyOnlineStation(kit)
    const prior =
      current && (body.station_id === undefined || body.station_id === current.station_id)
        ? current.source
        : null
    const pinned = await pinImageSource(kit.deps.db, source, stationId, prior)
    body.source = pinned.source as unknown as CreateBody['source']
    return pinned.resolution ? [pinnedWarning(pinned.resolution)] : []
  }
  if (!source || (source.type !== 'dockerfile' && source.type !== 'railpack')) return []
  const resolved = await kit.deps.github.resolveRepo(source.repo)
  body.source = {
    ...source,
    auth: resolved.auth,
  } as unknown as CreateBody['source']
  return resolved.auth === 'public'
    ? [
        warning(
          'SOURCE_POLLING',
          `${source.repo} is read anonymously; Dispatch polls ${source.branch} every github.poll_interval_s seconds and posts no commit statuses.`,
        ),
      ]
    : []
}

const planCreate = (kit: Kit, principal: Principal, env: EnvironmentRow, body: CreateBody) => {
  const { db } = kit.deps
  const ports = body.ports ?? []
  const volumes = body.volumes ?? []
  const issues = portIssues(body.kind, ports)
  if (body.kind === 'cron' && !body.schedule)
    issues.push({
      path: '/schedule',
      message: 'a cron service needs a schedule',
    })
  if (issues.length) invalid(issues)
  if (
    db
      .select({
        id: service.id,
      })
      .from(service)
      .where(and(eq(service.environment_id, env.id), eq(service.name, body.name)))
      .get()
  ) {
    fail(
      'NAME_TAKEN',
      `Environment ${env.name} already has a service named ${body.name}.`,
      undefined,
      {
        name: body.name,
      },
    )
  }
  const stationId = placeStation(kit, body.station_id)
  const strategy = body.strategy ?? (volumes.length > 0 ? 'replace' : 'overlap')
  strategyCheck(strategy, volumes.length, body.multi_writer_safe ?? false)
  const deploy = (body.deploy_on_create ?? true) && body.source.type !== 'local'
  if (deploy) requireStationReady(db, stationId)
  const set = new ChangeSet()
  const ref = set.add('service', env.id, {
    name: body.name,
    kind: body.kind,
    source: body.source,
    station_id: stationId,
    command: body.command ?? null,
    build_args: body.build_args ?? null,
    limits: {
      ...defaultLimits,
      ...body.limits,
    },
    health: fullHealth(body.kind, body.health),
    strategy,
    multi_writer_safe: body.multi_writer_safe ?? false,
    drain_timeout_s: body.drain_timeout_s ?? 30,
    readonly_rootfs: body.readonly_rootfs ?? false,
    secrets_owner: body.secrets_owner ?? null,
    pre_deploy: body.pre_deploy ?? null,
    schedule: body.schedule ?? null,
  })
  for (const port of ports)
    set.add('service_port', ref, {
      port: port.port,
      protocol: port.protocol ?? 'http',
      grpc: port.grpc ?? false,
    })
  for (const vol of volumes)
    set.add('volume', ref, {
      mount_path: vol.mount_path,
    })
  if (body.variables?.length) {
    planVariables(
      db,
      kit.deps.keyring,
      principal,
      set,
      {
        scope: 'service',
        parent: ref,
        serviceId: null,
        target: {
          project_id: env.project_id,
          environment_id: env.id,
        },
      },
      {
        set: body.variables,
        allow_unresolved: true,
      },
    )
  }
  if (deploy) set.deploy(ref, 'manual')
  return set
}

const planPatch = (kit: Kit, principal: Principal, ctx: ServiceContext, body: PatchBody) => {
  const { db } = kit.deps
  const svc = ctx.service
  if (body.station_id !== undefined && body.station_id !== svc.station_id) {
    requireLevel(principal, ctx.target, 'admin')
    placeStation(kit, body.station_id)
  }
  const set = new ChangeSet()
  const next: Record<string, unknown> = {
    ...body,
    limits: body.limits
      ? {
          ...svc.limits,
          ...body.limits,
        }
      : undefined,
    health: body.health === undefined ? undefined : fullHealth(svc.kind, body.health),
  }
  for (const field of configFields) {
    if (next[field] === undefined) continue
    leafDiff(
      set,
      'service',
      svc.id,
      `/${field}`,
      (svc as Record<string, unknown>)[field] ?? null,
      next[field],
    )
  }
  const configChanged = !set.empty
  const sourceChanged = set.changes.some((c) => c.op === 'update' && c.path.startsWith('/source'))
  let structural = false
  if (body.ports) {
    const issues = portIssues(svc.kind, body.ports)
    if (issues.length) invalid(issues)
    const current = db.select().from(service_port).where(eq(service_port.service_id, svc.id)).all()
    for (const port of current) {
      if (body.ports.some((p) => p.port === port.port)) continue
      set.remove('service_port', port.id, select(kit.views.port, port, undefined))
      structural = true
    }
    for (const port of body.ports) {
      const existing = current.find((c) => c.port === port.port)
      if (!existing) {
        set.add('service_port', svc.id, {
          port: port.port,
          protocol: port.protocol ?? 'http',
          grpc: port.grpc ?? false,
        })
        structural = true
        continue
      }
      if (port.protocol !== undefined && port.protocol !== existing.protocol) {
        requireProtocolChangeAllowed(db, existing.id, port.protocol)
        set.update('service_port', existing.id, '/protocol', existing.protocol, port.protocol)
        structural = true
      }
      if (port.grpc !== undefined && port.grpc !== existing.grpc) {
        set.update('service_port', existing.id, '/grpc', existing.grpc, port.grpc)
        structural = true
      }
    }
  }
  if (body.volumes) {
    const current = db
      .select()
      .from(volume)
      .where(and(eq(volume.service_id, svc.id), eq(volume.status, 'active')))
      .all()
    for (const vol of current) {
      if (body.volumes.some((v) => v.mount_path === vol.mount_path)) continue
      set.update('volume', vol.id, '/status', vol.status, 'retained')
      set.update(
        'volume',
        vol.id,
        '/retain_until',
        null,
        new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      )
      set.update('volume', vol.id, '/service_id', svc.id, null)
      structural = true
    }
    for (const vol of body.volumes) {
      if (current.some((c) => c.mount_path === vol.mount_path)) continue
      set.add('volume', svc.id, {
        mount_path: vol.mount_path,
      })
      structural = true
    }
  }
  const strategy = (next.strategy as string | undefined) ?? svc.strategy
  const volumeCount =
    body.volumes?.length ??
    db
      .select({
        id: volume.id,
      })
      .from(volume)
      .where(and(eq(volume.service_id, svc.id), eq(volume.status, 'active')))
      .all().length
  strategyCheck(
    strategy,
    volumeCount,
    (next.multi_writer_safe as boolean | undefined) ?? svc.multi_writer_safe,
  )
  if (body.variables) {
    planVariables(
      db,
      kit.deps.keyring,
      principal,
      set,
      {
        scope: 'service',
        parent: svc.id,
        serviceId: svc.id,
        target: ctx.target,
      },
      {
        set: body.variables,
        allow_unresolved: true,
      },
      {
        replaceAll: true,
      },
    )
  }
  const deploy = body.deploy ?? true
  const trigger = configDeployTrigger(svc, next.source ?? svc.source, sourceChanged)
  if (trigger && (structural || (configChanged && deploy))) {
    requireStationReady(db, (next.station_id as string | undefined) ?? svc.station_id)
    set.deploy(svc.id, trigger, {
      reason:
        set.changes
          .filter((c) => c.op === 'update')
          .map((c) => (c.op === 'update' ? c.path : ''))
          .join(', ') || 'ports or volumes changed',
    })
  }
  return set
}

export const serviceRoutes = (kit: Kit) => {
  const { db } = kit.deps
  const tags = ['services']
  const view = (id: string, fields?: string) =>
    select(
      kit.views.service,
      db.select().from(service).where(eq(service.id, id)).get()!,
      kit.fields(fields),
    )

  return new Elysia({
    prefix: '/v1',
    normalize: false,
  })
    .use(models())
    .use(kit.operations)
    .get(
      '/environments/:environment/services',
      ({ params, query }) => {
        const ctx = environmentById(db, params.environment)
        const page = collect(
          (cursor, size) =>
            db
              .select()
              .from(service)
              .where(
                and(
                  eq(service.environment_id, ctx.environment.id),
                  query.status ? eq(service.status, query.status as 'green') : undefined,
                  query.kind ? eq(service.kind, query.kind as 'web') : undefined,
                  query.station ? eq(service.station_id, query.station) : undefined,
                  query.stale === undefined ? undefined : eq(service.stale, query.stale),
                  before(service.id, cursor),
                ),
              )
              .orderBy(desc(service.id))
              .limit(size)
              .all(),
          query,
        )
        return {
          items: page.rows.map((row) => select(kit.views.service, row, kit.fields(query.fields))),
          next_cursor: page.next_cursor,
        }
      },
      {
        operation: {
          id: 'list_services',
          level: 'read',
        },
        params: t.Object({
          environment: t.String(),
        }),
        query: t.Object({
          ...listQuery,
          status: t.Optional(t.String()),
          kind: t.Optional(t.String()),
          station: t.Optional(t.String()),
          stale: t.Optional(t.BooleanString()),
        }),
        response: replies({
          200: Page(Service),
        }),
        detail: {
          summary: 'List the services of an environment',
          tags,
        },
      },
    )
    .get(
      '/services/:service',
      ({ params, query }) =>
        select(
          kit.views.service,
          serviceById(db, params.service).service,
          kit.fields(query.fields),
        ),
      {
        operation: {
          id: 'describe_service',
          level: 'read',
        },
        params: t.Object({
          service: t.String(),
        }),
        query: t.Object(getQuery),
        response: replies({
          200: Service,
        }),
        detail: {
          summary: 'Get a service',
          tags,
        },
      },
    )
    .post(
      '/environments/:environment/services',
      async ({ request, params, body, set }) => {
        const call = await kit.call(request)
        const ctx = environmentById(db, params.environment)
        const sourceWarnings = await authorizeSource(kit, body)
        const changes = planCreate(kit, call.principal, ctx.environment, body)
        const result = commit(
          kit.deps,
          call,
          {
            environment: ctx.environment,
            protect: ctx.environment.protected,
          },
          changes,
        )
        if (result.applied) set.status = 201
        return respond(
          kit,
          set,
          result,
          () => view(result.applied ? result.refs['new:service:1']! : '', 'ports,volumes'),
          sourceWarnings,
        )
      },
      {
        operation: {
          id: 'create_service',
          level: 'admin',
        },
        params: t.Object({
          environment: t.String(),
        }),
        body: ServiceCreate,
        response: replies({
          201: ServiceWritten,
          202: Staged,
        }),
        detail: {
          summary: 'Create a service',
          tags,
        },
      },
    )
    .patch(
      '/services/:service',
      async ({ request, params, body, set }) => {
        const call = await kit.call(request)
        const ctx = serviceById(db, params.service)
        const sourceWarnings = await authorizeSource(kit, body, ctx.service)
        const changes = planPatch(kit, call.principal, ctx, body)
        if (changes.empty)
          return {
            ...view(ctx.service.id),
            deployments: [],
            warnings: [],
          }
        const result = commit(
          kit.deps,
          call,
          {
            environment: ctx.environment,
            protect: ctx.environment.protected,
          },
          changes,
        )
        return respond(
          kit,
          set,
          result,
          () => view(ctx.service.id, 'ports,volumes'),
          sourceWarnings,
        )
      },
      {
        operation: {
          id: 'update_service',
          level: 'deploy',
        },
        params: t.Object({
          service: t.String(),
        }),
        body: ServicePatch,
        response: replies({
          200: ServiceWritten,
          202: Staged,
        }),
        detail: {
          summary: 'Update a service; deploys when deploy = true and the configuration changed',
          tags,
        },
      },
    )
    .delete(
      '/services/:service',
      async ({ request, params, set }) => {
        const call = await kit.call(request)
        const ctx = serviceById(db, params.service)
        const dependents = dependentsOfService(kit, ctx.service)
        if (dependents.length)
          fail(
            'DELETE_HAS_DEPENDENTS',
            `${ctx.service.name} is referenced by other services' variables.`,
            'Remove those references first.',
            {
              dependents,
            },
          )
        const changes = new ChangeSet()
        changes.remove('service', ctx.service.id, select(kit.views.service, ctx.service, undefined))
        const result = commit(
          kit.deps,
          call,
          {
            environment: ctx.environment,
            protect: ctx.environment.protected,
          },
          changes,
        )
        if (!result.applied) return kit.stagedBody(result, set)
        return {
          deleted: true as const,
          volumes_retained_until: result.retained_until?.toISOString() ?? null,
        }
      },
      {
        operation: {
          id: 'delete_service',
          level: 'admin',
        },
        params: t.Object({
          service: t.String(),
        }),
        response: replies({
          200: DeletedRetaining,
          202: Staged,
        }),
        detail: {
          summary: 'Delete a service; volumes are retained',
          tags,
        },
      },
    )
    .post(
      '/services/:service/restart',
      async ({ request, params, set }) => {
        const call = await kit.call(request)
        const ctx = serviceById(db, params.service)
        if (!ctx.service.current_deployment_id)
          fail(
            'NO_CURRENT_DEPLOYMENT',
            `${ctx.service.name} has no current deployment to restart.`,
            'Call deploy (POST /v1/services/{service}/deployments) first.',
          )
        const changes = new ChangeSet()
        changes.deploy(ctx.service.id, 'redeploy', {
          reason: 'restart',
        })
        const result = commit(
          kit.deps,
          call,
          {
            environment: ctx.environment,
            protect: ctx.environment.protected,
          },
          changes,
        )
        if (!result.applied) return kit.stagedBody(result, set)
        return select(
          kit.views.deployment,
          db.select().from(deployment).where(eq(deployment.id, result.deployments[0]!)).get()!,
          undefined,
        )
      },
      {
        operation: {
          id: 'restart_service',
          level: 'deploy',
        },
        params: t.Object({
          service: t.String(),
        }),
        response: replies({
          200: Deployment,
          202: Staged,
        }),
        detail: {
          summary: 'Restart: a redeploy of the current deployment',
          tags,
        },
      },
    )
    .post(
      '/services/:service/stop',
      async ({ request, params, set }) => {
        const call = await kit.call(request)
        const ctx = serviceById(db, params.service)
        const changes = new ChangeSet()
        if (ctx.service.desired_state !== 'stopped')
          changes.update(
            'service',
            ctx.service.id,
            '/desired_state',
            ctx.service.desired_state,
            'stopped',
          )
        if (changes.empty) return view(ctx.service.id)
        const result = commit(
          kit.deps,
          call,
          {
            environment: ctx.environment,
            protect: ctx.environment.protected,
          },
          changes,
        )
        if (!result.applied) return kit.stagedBody(result, set)
        return view(ctx.service.id)
      },
      {
        operation: {
          id: 'stop_service',
          level: 'deploy',
        },
        params: t.Object({
          service: t.String(),
        }),
        response: replies({
          200: Service,
          202: Staged,
        }),
        detail: {
          summary: 'Stop: desired_state = stopped',
          tags,
        },
      },
    )
    .post(
      '/services/:service/start',
      async ({ request, params, set }) => {
        const call = await kit.call(request)
        const ctx = serviceById(db, params.service)
        if (!ctx.service.current_deployment_id)
          fail(
            'NO_CURRENT_DEPLOYMENT',
            `${ctx.service.name} has no current deployment to start.`,
            'Call deploy (POST /v1/services/{service}/deployments) first.',
          )
        const changes = new ChangeSet()
        if (ctx.service.desired_state !== 'running')
          changes.update(
            'service',
            ctx.service.id,
            '/desired_state',
            ctx.service.desired_state,
            'running',
          )
        if (changes.empty)
          return {
            ...view(ctx.service.id),
            deployments: [],
          }
        const result = commit(
          kit.deps,
          call,
          {
            environment: ctx.environment,
            protect: ctx.environment.protected,
          },
          changes,
        )
        if (!result.applied) return kit.stagedBody(result, set)
        return {
          ...view(ctx.service.id),
          deployments: [],
        }
      },
      {
        operation: {
          id: 'start_service',
          level: 'deploy',
        },
        params: t.Object({
          service: t.String(),
        }),
        response: replies({
          200: ServiceStarted,
          202: Staged,
        }),
        detail: {
          summary: 'Start: desired_state = running',
          tags,
        },
      },
    )
}
