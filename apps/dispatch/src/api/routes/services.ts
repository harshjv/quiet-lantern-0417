import { Type, type TObject, type Static as TStatic } from '@sinclair/typebox'
import { and, desc, eq } from 'drizzle-orm'
import { t, type Static } from 'elysia'

import { appKindValues, appStatusValues } from '@stationly/protocol'

import type { Principal } from '../../auth/principal.ts'
import { app, app_port, deployment, key, server, volume } from '../../db/schema.ts'
import {
  healthPortMissing,
  normalizeHealth,
  undeclaredHealthPort,
  type PortDoc,
  type StoredHealth,
} from '../../generation/health.ts'
import { pinImageSource, pinnedWarning } from '../../platform/image-source.ts'
import { parseValue } from '../../secrets/reference.ts'
import { requireLevel } from '../access.ts'
import {
  ChangeSet,
  commit,
  leafDiff,
  placeName,
  requireProtocolChangeAllowed,
  type CommitResult,
} from '../changes.ts'
import { configDeployTrigger, configFields, requireStationReady } from '../deployments.ts'
import { fail, invalid } from '../errors.ts'
import { project as select } from '../fields.ts'
import { warning, type Kit } from '../kit.ts'
import { isProduction, scopeOf, type AppContext, type AppRow, type TargetRow } from '../lookup.ts'
import { before, collect, filterOne, getQuery, listQuery, previewQuery } from '../pagination.ts'
import { AppCreate, AppPatch } from '../schemas.ts'
import {
  App,
  ApprovalDetail,
  component,
  DeletedRetaining,
  Deployment,
  extend,
  Page,
  replies,
  Warnings,
  type Ref,
} from '../shapes.ts'
import { planKeys } from '../variable-changes.ts'

export const withDeployments = <S extends TObject>(schema: S | Ref<S>) =>
  extend(schema, {
    deployments: Type.Array(Deployment),
    warnings: Warnings,
  })

const AppWritten = component('AppWritten', withDeployments(App))

const AppStarted = extend(App, {
  deployments: Type.Array(Deployment),
})

type CreateBody = Static<typeof AppCreate>
type PatchBody = Static<typeof AppPatch>
type HealthBody = NonNullable<CreateBody['health']>

const defaultLimits = {
  cpu_millis: 1000,
  memory_bytes: 536870912,
}

const fullHealth = (
  kind: string,
  ports: PortDoc[],
  health: HealthBody | null | undefined,
  path: string,
) => {
  if (!health) {
    return null
  }

  const resolved = normalizeHealth(kind, ports, health)
  const undeclared = undeclaredHealthPort(resolved, ports)

  if (undeclared) {
    invalid([
      {
        path,
        code: 'PORT_UNDECLARED',
        message: undeclared,
      },
    ])
  }

  return resolved
}

const portDocs = (ports: { port: number; protocol?: 'http' | 'tcp' }[]): PortDoc[] =>
  ports.map((p) => ({
    port: p.port,
    protocol: p.protocol ?? 'http',
  }))

const kindTakesPorts = (kind: string) => kind === 'web'

const placeStation = (kit: Kit, stationId: string | undefined) => {
  const { db } = kit.deps

  if (stationId) {
    const row = db.select().from(server).where(eq(server.id, stationId)).get()

    if (!row) {
      return invalid([
        {
          path: '/server_id',
          message: `server ${stationId} does not exist`,
        },
      ])
    }

    if (row.draining) {
      return invalid([
        {
          path: '/server_id',
          message: `server ${row.name} is draining, so no new apps are placed on it`,
        },
      ])
    }

    return stationId
  }

  const online = db
    .select({
      id: server.id,
    })
    .from(server)
    .where(and(eq(server.status, 'online'), eq(server.draining, false)))
    .all()

  if (online.length !== 1) {
    invalid([
      {
        path: '/server_id',
        message: `required unless exactly one server is online (${online.length} are)`,
      },
    ])
  }

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
  if (kind === 'web' && ports.length === 0) {
    return [
      {
        path: '/ports',
        message: 'a web app needs at least one port',
      },
    ]
  }

  if (!kindTakesPorts(kind) && ports.length > 0) {
    return [
      {
        path: '/ports',
        message: `a ${kind} app has no ports`,
      },
    ]
  }

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

export const dependentsOfApp = (kit: Kit, svc: AppRow) =>
  kit.deps.db
    .select({
      id: key.id,
      name: key.name,
      app_id: key.app_id,
      reference: key.reference,
    })
    .from(key)
    .innerJoin(app, eq(app.id, key.app_id))
    .where(and(eq(key.kind, 'reference'), eq(app.target_id, svc.target_id)))
    .all()
    .filter((v) => v.app_id !== svc.id)
    .filter((v) => {
      try {
        return parseValue(v.reference ?? '').some(
          (s) => s.type === 'reference' && s.target.type === 'app' && s.target.app === svc.name,
        )
      } catch {
        return false
      }
    })
    .map((v) => ({
      entity: 'key',
      id: v.id,
      name: v.name,
      app_id: v.app_id,
    }))

export const respond = <B extends object>(
  kit: Kit,
  set: { status?: number | string },
  result: CommitResult,
  body: () => B,
  warnings: TStatic<typeof Warnings> = [],
):
  | TStatic<typeof ApprovalDetail>
  | (B & { deployments: TStatic<typeof Deployment>[]; warnings: TStatic<typeof Warnings> }) => {
  if (!result.applied) {
    return kit.approvalBody(result, set)
  }

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
      id: server.id,
    })
    .from(server)
    .where(and(eq(server.status, 'online'), eq(server.draining, false)))
    .all()

  return online.length === 1 ? online[0]!.id : null
}

const authorizeSource = async (
  kit: Kit,
  body: { source?: CreateBody['source']; server_id?: string },
  current?: AppRow,
) => {
  const source = body.source

  if (source?.type === 'image') {
    const stationId = body.server_id ?? current?.server_id ?? onlyOnlineStation(kit)
    const prior =
      current && (body.server_id === undefined || body.server_id === current.server_id)
        ? current.source
        : null
    const pinned = await pinImageSource(kit.deps.db, source, stationId, prior)

    body.source = pinned.source as unknown as CreateBody['source']

    return pinned.resolution ? [pinnedWarning(pinned.resolution)] : []
  }

  if (!source || (source.type !== 'dockerfile' && source.type !== 'railpack')) {
    return []
  }

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

const planCreate = (kit: Kit, principal: Principal, env: TargetRow, body: CreateBody) => {
  const { db } = kit.deps
  const ports = body.ports ?? []
  const volumes = body.volumes ?? []
  const issues = portIssues(body.kind, ports)

  if (body.kind === 'cron' && !body.schedule) {
    issues.push({
      path: '/schedule',
      message: 'a cron app needs a schedule',
    })
  }

  if (issues.length) {
    invalid(issues)
  }

  if (
    db
      .select({
        id: app.id,
      })
      .from(app)
      .where(and(eq(app.target_id, env.id), eq(app.name, body.name)))
      .get()
  ) {
    fail(
      'NAME_TAKEN',
      `An app named ${body.name} already exists in ${placeName(env)}.`,
      undefined,
      {
        name: body.name,
      },
    )
  }

  const stationId = placeStation(kit, body.server_id)
  const strategy = body.strategy ?? (volumes.length > 0 ? 'replace' : 'overlap')

  strategyCheck(strategy, volumes.length, body.multi_writer_safe ?? false)
  const deploy = (body.deploy_on_create ?? true) && body.source.type !== 'local'

  if (deploy) {
    requireStationReady(db, stationId)
  }

  const set = new ChangeSet()
  const ref = set.add('app', env.id, {
    name: body.name,
    kind: body.kind,
    source: body.source,
    server_id: stationId,
    command: body.command ?? null,
    build_args: body.build_args ?? null,
    limits: {
      ...defaultLimits,
      ...body.limits,
    },
    health: fullHealth(body.kind, portDocs(ports), body.health, '/health/port'),
    strategy,
    multi_writer_safe: body.multi_writer_safe ?? false,
    drain_timeout_s: body.drain_timeout_s ?? 30,
    readonly_rootfs: body.readonly_rootfs ?? false,
    secrets_owner: body.secrets_owner ?? null,
    pre_deploy: body.pre_deploy ?? null,
    schedule: body.schedule ?? null,
  })

  for (const port of ports) {
    set.add('app_port', ref, {
      port: port.port,
      protocol: port.protocol ?? 'http',
      grpc: port.grpc ?? false,
    })
  }

  for (const vol of volumes) {
    set.add('volume', ref, {
      mount_path: vol.mount_path,
    })
  }

  if (body.keys?.length) {
    planKeys(
      db,
      kit.deps.keyring,
      principal,
      set,
      {
        scope: 'app',
        parent: ref,
        appId: null,
        valueTarget: 'production',
        target: scopeOf(env),
      },
      {
        set: body.keys,
        allow_unresolved: true,
      },
    )
  }

  if (deploy) {
    set.deploy(ref, 'manual')
  }

  return set
}

const planPatch = (kit: Kit, principal: Principal, ctx: AppContext, body: PatchBody) => {
  const { db } = kit.deps
  const svc = ctx.app

  if (body.server_id !== undefined && body.server_id !== svc.server_id) {
    requireLevel(principal, ctx.target, 'admin')
    placeStation(kit, body.server_id)
  }

  const stored = db.select().from(app_port).where(eq(app_port.app_id, svc.id)).all()
  const nextPorts: PortDoc[] = body.ports
    ? body.ports.map((p) => ({
        port: p.port,
        protocol: p.protocol ?? stored.find((c) => c.port === p.port)?.protocol ?? 'http',
      }))
    : stored.map((p) => ({
        port: p.port,
        protocol: p.protocol,
      }))
  const nextHealth =
    body.health === undefined
      ? undefined
      : fullHealth(svc.kind, nextPorts, body.health, '/health/port')

  if (body.health === undefined && body.ports) {
    const dropped = healthPortMissing(svc.health as StoredHealth, nextPorts)

    if (dropped !== null) {
      invalid([
        {
          path: '/ports',
          code: 'PORT_UNDECLARED',
          message: `health.port ${dropped} would no longer be in ports; change the health check in the same request.`,
        },
      ])
    }
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
    health: nextHealth,
  }

  for (const field of configFields) {
    if (next[field] === undefined) {
      continue
    }

    leafDiff(
      set,
      'app',
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

    if (issues.length) {
      invalid(issues)
    }

    const current = stored

    for (const port of current) {
      if (body.ports.some((p) => p.port === port.port)) {
        continue
      }

      set.remove('app_port', port.id, select(kit.views.port, port, undefined))
      structural = true
    }

    for (const port of body.ports) {
      const existing = current.find((c) => c.port === port.port)

      if (!existing) {
        set.add('app_port', svc.id, {
          port: port.port,
          protocol: port.protocol ?? 'http',
          grpc: port.grpc ?? false,
        })
        structural = true
        continue
      }

      if (port.protocol !== undefined && port.protocol !== existing.protocol) {
        requireProtocolChangeAllowed(db, existing.id, port.protocol)
        set.update('app_port', existing.id, '/protocol', existing.protocol, port.protocol)
        structural = true
      }

      if (port.grpc !== undefined && port.grpc !== existing.grpc) {
        set.update('app_port', existing.id, '/grpc', existing.grpc, port.grpc)
        structural = true
      }
    }
  }

  if (body.volumes) {
    const current = db
      .select()
      .from(volume)
      .where(and(eq(volume.app_id, svc.id), eq(volume.status, 'active')))
      .all()

    for (const vol of current) {
      if (body.volumes.some((v) => v.mount_path === vol.mount_path)) {
        continue
      }

      set.update('volume', vol.id, '/status', vol.status, 'retained')
      set.update(
        'volume',
        vol.id,
        '/retain_until',
        null,
        new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      )
      set.update('volume', vol.id, '/app_id', svc.id, null)
      structural = true
    }

    for (const vol of body.volumes) {
      if (current.some((c) => c.mount_path === vol.mount_path)) {
        continue
      }

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
      .where(and(eq(volume.app_id, svc.id), eq(volume.status, 'active')))
      .all().length

  strategyCheck(
    strategy,
    volumeCount,
    (next.multi_writer_safe as boolean | undefined) ?? svc.multi_writer_safe,
  )

  if (body.keys) {
    planKeys(
      db,
      kit.deps.keyring,
      principal,
      set,
      {
        scope: 'app',
        parent: svc.id,
        appId: svc.id,
        valueTarget: 'production',
        target: ctx.target,
      },
      {
        set: body.keys,
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
    requireStationReady(db, (next.server_id as string | undefined) ?? svc.server_id)
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

export const appRoutes = (kit: Kit) => {
  const { db } = kit.deps
  const view = (id: string, fields?: string) =>
    select(kit.views.app, db.select().from(app).where(eq(app.id, id)).get()!, kit.fields(fields))

  return kit
    .router('apps', '/v1')
    .get(
      '/projects/:project/apps',
      ({ ctx, query }) => {
        const page = collect(
          (cursor, size) =>
            db
              .select()
              .from(app)
              .where(
                and(
                  eq(app.target_id, ctx.target_row.id),
                  query.status ? eq(app.status, query.status as 'healthy') : undefined,
                  query.kind ? eq(app.kind, query.kind as 'web') : undefined,
                  query.server ? eq(app.server_id, query.server) : undefined,
                  query.stale === undefined ? undefined : eq(app.stale, query.stale),
                  before(app.id, cursor),
                ),
              )
              .orderBy(desc(app.id))
              .limit(size)
              .all(),
          query,
        )

        return {
          items: page.rows.map((row) => select(kit.views.app, row, kit.fields(query.fields))),
          next_cursor: page.next_cursor,
        }
      },
      {
        place: {
          id: 'list_apps',
          summary: 'List the apps of production, or of a preview',
          level: 'read',
        },
        query: t.Object({
          ...listQuery,
          ...previewQuery,
          status: filterOne(appStatusValues),
          kind: filterOne(appKindValues),
          server: t.Optional(
            t.String({
              description: 'Only apps on this server id',
            }),
          ),
          stale: t.Optional(
            t.BooleanString({
              description: 'Only apps whose current deployment is out of date, with stale_reasons',
            }),
          ),
        }),
        response: replies({
          200: Page(App),
        }),
      },
    )
    .get(
      '/apps/:app',
      ({ ctx, query }) => select(kit.views.app, ctx.app, kit.fields(query.fields)),
      {
        app: {
          id: 'describe_app',
          summary: 'Get an app',
          level: 'read',
        },
        query: t.Object(getQuery),
        response: replies({
          200: App,
        }),
      },
    )
    .post(
      '/projects/:project/apps',
      async ({ ctx, request, body, set }) => {
        const call = await kit.call(request)
        const sourceWarnings = await authorizeSource(kit, body)
        const changes = planCreate(kit, call.principal, ctx.target_row, body)
        const result = commit(
          kit.deps,
          call,
          {
            target: ctx.target_row,
            protect: isProduction(ctx.target_row),
          },
          changes,
        )

        if (result.applied) {
          set.status = 201
        }

        return respond(
          kit,
          set,
          result,
          () => view(result.applied ? result.refs['new:app:1']! : '', 'ports,volumes'),
          sourceWarnings,
        )
      },
      {
        place: {
          id: 'create_app',
          summary: 'Create an app in production, or in a preview',
          level: 'admin',
          cli: {
            args: ['name'],
          },
        },
        body: AppCreate,
        query: t.Object(previewQuery),
        response: replies({
          201: AppWritten,
          202: ApprovalDetail,
        }),
      },
    )
    .patch(
      '/apps/:app',
      async ({ ctx, request, body, set }) => {
        const call = await kit.call(request)
        const sourceWarnings = await authorizeSource(kit, body, ctx.app)
        const changes = planPatch(kit, call.principal, ctx, body)

        if (changes.empty) {
          return {
            ...view(ctx.app.id),
            deployments: [],
            warnings: [],
          }
        }

        const result = commit(
          kit.deps,
          call,
          {
            target: ctx.target_row,
            protect: isProduction(ctx.target_row),
          },
          changes,
        )

        return respond(kit, set, result, () => view(ctx.app.id, 'ports,volumes'), sourceWarnings)
      },
      {
        app: {
          id: 'update_app',
          summary: 'Update an app; deploys when deploy = true and the configuration changed',
          level: 'deploy',
        },
        body: AppPatch,
        response: replies({
          200: AppWritten,
          202: ApprovalDetail,
        }),
      },
    )
    .delete(
      '/apps/:app',
      async ({ ctx, request, set }) => {
        const call = await kit.call(request)
        const dependents = dependentsOfApp(kit, ctx.app)

        if (dependents.length) {
          fail(
            'DELETE_HAS_DEPENDENTS',
            `${ctx.app.name} is referenced by other apps' keys.`,
            'Remove those references first.',
            {
              dependents,
            },
          )
        }

        const changes = new ChangeSet()

        changes.remove('app', ctx.app.id, select(kit.views.app, ctx.app, undefined))
        const result = commit(
          kit.deps,
          call,
          {
            target: ctx.target_row,
            protect: isProduction(ctx.target_row),
          },
          changes,
        )

        if (!result.applied) {
          return kit.approvalBody(result, set)
        }

        return {
          deleted: true as const,
          volumes_retained_until: result.retained_until?.toISOString() ?? null,
        }
      },
      {
        app: {
          id: 'delete_app',
          summary: 'Delete an app; volumes are retained',
          level: 'admin',
        },
        response: replies({
          200: DeletedRetaining,
          202: ApprovalDetail,
        }),
      },
    )
    .post(
      '/apps/:app/restart',
      async ({ ctx, request, set }) => {
        const call = await kit.call(request)

        if (!ctx.app.current_deployment_id) {
          fail(
            'NO_CURRENT_DEPLOYMENT',
            `${ctx.app.name} has no current deployment to restart.`,
            'Call deploy (POST /v1/apps/{app}/deployments) first.',
          )
        }

        const changes = new ChangeSet()

        changes.deploy(ctx.app.id, 'redeploy', {
          reason: 'restart',
        })
        const result = commit(
          kit.deps,
          call,
          {
            target: ctx.target_row,
            protect: isProduction(ctx.target_row),
          },
          changes,
        )

        if (!result.applied) {
          return kit.approvalBody(result, set)
        }

        return select(
          kit.views.deployment,
          db.select().from(deployment).where(eq(deployment.id, result.deployments[0]!)).get()!,
          undefined,
        )
      },
      {
        app: {
          id: 'restart_app',
          summary: 'Restart: a redeploy of the current deployment',
          level: 'deploy',
          cli: {
            wait: 'wait_for_deployment',
          },
        },
        response: replies({
          200: Deployment,
          202: ApprovalDetail,
        }),
      },
    )
    .post(
      '/apps/:app/stop',
      async ({ ctx, request, set }) => {
        const call = await kit.call(request)
        const changes = new ChangeSet()

        if (ctx.app.desired_state !== 'stopped') {
          changes.update('app', ctx.app.id, '/desired_state', ctx.app.desired_state, 'stopped')
        }

        if (changes.empty) {
          return view(ctx.app.id)
        }

        const result = commit(
          kit.deps,
          call,
          {
            target: ctx.target_row,
            protect: isProduction(ctx.target_row),
          },
          changes,
        )

        if (!result.applied) {
          return kit.approvalBody(result, set)
        }

        return view(ctx.app.id)
      },
      {
        app: {
          id: 'stop_app',
          summary: 'Stop: desired_state = stopped',
          level: 'deploy',
        },
        response: replies({
          200: App,
          202: ApprovalDetail,
        }),
      },
    )
    .post(
      '/apps/:app/start',
      async ({ ctx, request, set }) => {
        const call = await kit.call(request)

        if (!ctx.app.current_deployment_id) {
          fail(
            'NO_CURRENT_DEPLOYMENT',
            `${ctx.app.name} has no current deployment to start.`,
            'Call deploy (POST /v1/apps/{app}/deployments) first.',
          )
        }

        const changes = new ChangeSet()

        if (ctx.app.desired_state !== 'running') {
          changes.update('app', ctx.app.id, '/desired_state', ctx.app.desired_state, 'running')
        }

        if (changes.empty) {
          return {
            ...view(ctx.app.id),
            deployments: [],
          }
        }

        const result = commit(
          kit.deps,
          call,
          {
            target: ctx.target_row,
            protect: isProduction(ctx.target_row),
          },
          changes,
        )

        if (!result.applied) {
          return kit.approvalBody(result, set)
        }

        return {
          ...view(ctx.app.id),
          deployments: [],
        }
      },
      {
        app: {
          id: 'start_app',
          summary: 'Start: desired_state = running',
          level: 'deploy',
        },
        response: replies({
          200: AppStarted,
          202: ApprovalDetail,
        }),
      },
    )
}
