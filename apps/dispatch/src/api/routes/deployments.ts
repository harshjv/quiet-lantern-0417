import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import { Elysia, t } from 'elysia'

import { deploymentCancellableStatuses } from '@stationly/protocol'

import { deployment, service } from '../../db/schema.ts'
import {
  pinImageSource,
  pinnedWarning,
  resolveImage,
  stationArch,
} from '../../platform/image-source.ts'
import { ChangeSet, commit } from '../changes.ts'
import { audit, emit } from '../context.ts'
import { requireStationReady, usableBlob } from '../deployments.ts'
import { fail } from '../errors.ts'
import { project as select } from '../fields.ts'
import { csv, parseTime, warning, type Kit } from '../kit.ts'
import { deploymentById, environmentById, serviceById } from '../lookup.ts'
import { before, collect, getQuery, listQuery } from '../pagination.ts'
import { Deployment, DeploymentCreated, models, Page, replies, Staged } from '../shapes.ts'

const filters = {
  status: t.Optional(t.String()),
  trigger: t.Optional(t.String()),
  since: t.Optional(t.String()),
  until: t.Optional(t.String()),
}

type DeploymentStatus = (typeof deployment.$inferSelect)['status']

export const deploymentRoutes = (kit: Kit) => {
  const { db } = kit.deps
  const tags = ['deployments']
  const view = (id: string) =>
    select(
      kit.views.deployment,
      db.select().from(deployment).where(eq(deployment.id, id)).get()!,
      undefined,
    )

  const conditions = (query: {
    status?: string
    trigger?: string
    since?: string
    until?: string
  }) => {
    const since = parseTime(query.since, '/since')
    const until = parseTime(query.until, '/until')
    const statuses = csv(query.status)
    const triggers = csv(query.trigger)
    return [
      statuses ? inArray(deployment.status, statuses as DeploymentStatus[]) : undefined,
      triggers ? inArray(sql`json_extract(${deployment.trigger}, '$.type')`, triggers) : undefined,
      since ? gte(deployment.created_at, since) : undefined,
      until ? lte(deployment.created_at, until) : undefined,
    ]
  }

  return new Elysia({
    prefix: '/v1',
    normalize: false,
  })
    .use(models())
    .use(kit.operations)
    .get(
      '/services/:service/deployments',
      ({ params, query }) => {
        const ctx = serviceById(db, params.service)
        const where = conditions(query)
        const page = collect(
          (cursor, size) =>
            db
              .select()
              .from(deployment)
              .where(
                and(
                  eq(deployment.service_id, ctx.service.id),
                  ...where,
                  before(deployment.id, cursor),
                ),
              )
              .orderBy(desc(deployment.id))
              .limit(size)
              .all(),
          query,
        )
        return {
          items: page.rows.map((row) =>
            select(kit.views.deployment, row, kit.fields(query.fields)),
          ),
          next_cursor: page.next_cursor,
        }
      },
      {
        operation: {
          id: 'list_deployments',
          level: 'read',
        },
        params: t.Object({
          service: t.String(),
        }),
        query: t.Object({
          ...listQuery,
          ...filters,
        }),
        response: replies({
          200: Page(Deployment),
        }),
        detail: {
          summary: 'List the deployments of a service',
          tags,
        },
      },
    )
    .get(
      '/environments/:environment/deployments',
      ({ params, query }) => {
        const ctx = environmentById(db, params.environment)
        const services = db
          .select({
            id: service.id,
          })
          .from(service)
          .where(eq(service.environment_id, ctx.environment.id))
          .all()
          .map((s) => s.id)
        const scoped = query.service ? services.filter((id) => id === query.service) : services
        const where = conditions(query)
        const page = scoped.length
          ? collect(
              (cursor, size) =>
                db
                  .select()
                  .from(deployment)
                  .where(
                    and(
                      inArray(deployment.service_id, scoped),
                      ...where,
                      before(deployment.id, cursor),
                    ),
                  )
                  .orderBy(desc(deployment.id))
                  .limit(size)
                  .all(),
              query,
            )
          : {
              rows: [],
              next_cursor: null,
            }
        return {
          items: page.rows.map((row) =>
            select(kit.views.deployment, row, kit.fields(query.fields)),
          ),
          next_cursor: page.next_cursor,
        }
      },
      {
        operation: {
          id: 'list_environment_deployments',
          level: 'read',
        },
        params: t.Object({
          environment: t.String(),
        }),
        query: t.Object({
          ...listQuery,
          ...filters,
          service: t.Optional(t.String()),
        }),
        response: replies({
          200: Page(Deployment),
        }),
        detail: {
          summary: 'List the deployments of an environment',
          tags,
        },
      },
    )
    .get(
      '/deployments/:id',
      ({ params, query }) => {
        const ctx = deploymentById(db, params.id)
        return select(kit.views.deployment, ctx.deployment, kit.fields(query.fields))
      },
      {
        operation: {
          id: 'get_deployment',
          level: 'read',
        },
        params: t.Object({
          id: t.String(),
        }),
        query: t.Object(getQuery),
        response: replies({
          200: Deployment,
        }),
        detail: {
          summary: 'Get a deployment',
          tags,
        },
      },
    )
    .post(
      '/services/:service/deployments',
      async ({ request, params, body, set }) => {
        const call = await kit.call(request)
        const ctx = serviceById(db, params.service)
        const source = ctx.service.source as { type: string }
        if (body.image !== undefined && source.type !== 'image')
          fail('VALIDATION_FAILED', 'image is accepted only for image sources.', undefined, {
            issues: [
              {
                path: '/image',
                message: `source is ${source.type}`,
              },
            ],
          })
        if (body.blob_id !== undefined) usableBlob(db, body.blob_id, ctx.service.id)
        requireStationReady(db, ctx.service.station_id)
        const changes = new ChangeSet()
        const imageWarnings: { code: string; explanation: string }[] = []
        let image: string | null = null
        const sameRef =
          source.type === 'image' &&
          body.image?.trim() === (ctx.service.source as { ref?: string }).ref
        if (body.image && !sameRef) {
          const resolution = await resolveImage(
            body.image,
            stationArch(db, ctx.service.station_id),
            '/image',
          )
          image = resolution.pinned
          imageWarnings.push(pinnedWarning(resolution))
        } else if (source.type === 'image') {
          const current = ctx.service.source as { type: 'image'; ref: string; digest?: string }
          const pinned = await pinImageSource(db, current, ctx.service.station_id, null)
          if (pinned.source.digest !== current.digest)
            changes.update(
              'service',
              ctx.service.id,
              '/source/digest',
              current.digest ?? null,
              pinned.source.digest,
            )
          if (pinned.resolution) imageWarnings.push(pinnedWarning(pinned.resolution))
        }
        changes.deploy(ctx.service.id, 'manual', {
          supersede: body.supersede ?? false,
          ...(body.source_ref
            ? {
                source_sha: body.source_ref,
              }
            : {}),
          ...(image
            ? {
                image,
              }
            : {}),
          ...(body.blob_id
            ? {
                blob_id: body.blob_id,
              }
            : {}),
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
        set.status = 201
        const created = view(result.deployments[0]!)
        return {
          ...created,
          warnings: [
            ...imageWarnings,
            ...(created.strategy === 'replace'
              ? [
                  warning(
                    'DOWNTIME_EXPECTED',
                    'strategy = replace stops the old container before the new one is healthy.',
                  ),
                ]
              : []),
          ],
        }
      },
      {
        operation: {
          id: 'deploy',
          level: 'deploy',
          mcp: {
            always_load: true,
          },
          cli: {
            wait: 'wait_for_deployment',
          },
        },
        params: t.Object({
          service: t.String(),
        }),
        body: t.Object(
          {
            source_ref: t.Optional(
              t.String({
                minLength: 1,
              }),
            ),
            image: t.Optional(
              t.String({
                minLength: 1,
              }),
            ),
            blob_id: t.Optional(t.String()),
            supersede: t.Optional(t.Boolean()),
          },
          {
            additionalProperties: false,
          },
        ),
        response: replies({
          201: DeploymentCreated,
          202: Staged,
        }),
        detail: {
          summary: 'Create a deployment record (queued); execution belongs to the station',
          tags,
        },
      },
    )
    .post(
      '/deployments/:id/cancel',
      async ({ request, params }) => {
        const call = await kit.call(request)
        const ctx = deploymentById(db, params.id)
        if (!(deploymentCancellableStatuses as readonly string[]).includes(ctx.deployment.status)) {
          fail(
            'DEPLOYMENT_NOT_CANCELLABLE',
            `Deployment ${ctx.deployment.number} is ${ctx.deployment.status}.`,
            'Use rollback to undo a deployment at or past cutover.',
            {
              status: ctx.deployment.status,
            },
          )
        }
        db.update(deployment)
          .set({
            status: 'cancelled',
            cancel_reason: 'user',
            finished_at: new Date(),
          })
          .where(eq(deployment.id, ctx.deployment.id))
          .run()
        audit(
          db,
          call,
          'deployment.cancel',
          {
            entity: 'deployment',
            id: ctx.deployment.id,
          },
          {
            before: {
              status: ctx.deployment.status,
            },
            after: {
              status: 'cancelled',
            },
          },
        )
        emit(
          db,
          'deployment.cancelled',
          {
            entity: 'deployment',
            id: ctx.deployment.id,
            project_id: ctx.project.id,
            environment_id: ctx.environment.id,
            service_id: ctx.service.id,
          },
          {
            deployment: ctx.deployment.id,
            cancel_reason: 'user',
            actor: call.principal.actor,
          },
        )
        return view(ctx.deployment.id)
      },
      {
        operation: {
          id: 'cancel_deployment',
          level: 'deploy',
        },
        params: t.Object({
          id: t.String(),
        }),
        response: replies({
          200: Deployment,
        }),
        detail: {
          summary: 'Cancel a deployment before cutover; never staged',
          tags,
        },
      },
    )
}
