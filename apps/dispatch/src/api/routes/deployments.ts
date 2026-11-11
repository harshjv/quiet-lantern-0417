import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import { t } from 'elysia'

import {
  deploymentCancellableStatuses,
  deploymentStatusValues,
  deploymentTriggerValues,
} from '@stationly/protocol'

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
import { before, collect, filterMany, getQuery, listQuery, since, until } from '../pagination.ts'
import { supersede } from '../schemas.ts'
import { Deployment, DeploymentCreated, Page, replies, Staged } from '../shapes.ts'

const filters = {
  status: filterMany(deploymentStatusValues),
  trigger: filterMany(deploymentTriggerValues),
  since,
  until,
}

type DeploymentStatus = (typeof deployment.$inferSelect)['status']

export const deploymentRoutes = (kit: Kit) => {
  const { db } = kit.deps
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

  return kit
    .router('deployments', '/v1')
    .get(
      '/services/:service/deployments',
      ({ ctx, query }) => {
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
        service: {
          id: 'list_deployments',
          summary: 'List the deployments of a service',
          level: 'read',
        },
        query: t.Object({
          ...listQuery,
          ...filters,
        }),
        response: replies({
          200: Page(Deployment),
        }),
      },
    )
    .get(
      '/environments/:environment/deployments',
      ({ ctx, query }) => {
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
        environment: {
          id: 'list_environment_deployments',
          summary: 'List the deployments of an environment',
          level: 'read',
        },
        query: t.Object({
          ...listQuery,
          ...filters,
          service: t.Optional(t.String()),
        }),
        response: replies({
          200: Page(Deployment),
        }),
      },
    )
    .get(
      '/deployments/:id',
      ({ ctx, query }) => {
        return select(kit.views.deployment, ctx.deployment, kit.fields(query.fields))
      },
      {
        deployment: {
          id: 'get_deployment',
          summary: 'Get a deployment',
          level: 'read',
        },
        query: t.Object(getQuery),
        response: replies({
          200: Deployment,
        }),
      },
    )
    .post(
      '/services/:service/deployments',
      async ({ ctx, request, body, set }) => {
        const call = await kit.call(request)
        const source = ctx.service.source as { type: string }

        if (body.image !== undefined && source.type !== 'image') {
          fail('VALIDATION_FAILED', 'image is accepted only for image sources.', undefined, {
            issues: [
              {
                path: '/image',
                message: `source is ${source.type}`,
              },
            ],
          })
        }

        if (body.blob_id !== undefined) {
          usableBlob(db, body.blob_id, ctx.service.id)
        }

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

          if (pinned.source.digest !== current.digest) {
            changes.update(
              'service',
              ctx.service.id,
              '/source/digest',
              current.digest ?? null,
              pinned.source.digest,
            )
          }

          if (pinned.resolution) {
            imageWarnings.push(pinnedWarning(pinned.resolution))
          }
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

        if (!result.applied) {
          return kit.stagedBody(result, set)
        }

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
        service: {
          id: 'deploy',
          summary: 'Create a deployment record (queued); execution belongs to the station',
          level: 'deploy',
          mcp: {
            always_load: true,
          },
          cli: {
            wait: 'wait_for_deployment',
          },
        },
        body: t.Object(
          {
            source_ref: t.Optional(
              t.String({
                minLength: 1,
                description: 'A commit sha, branch or tag of the repository source',
              }),
            ),
            image: t.Optional(
              t.String({
                minLength: 1,
                description:
                  "An image reference for an image source, in place of the service's ref",
              }),
            ),
            blob_id: t.Optional(
              t.String({
                description: 'An uploaded blob for a local source; sly push sets it',
              }),
            ),
            supersede,
          },
          {
            additionalProperties: false,
          },
        ),
        response: replies({
          201: DeploymentCreated,
          202: Staged,
        }),
      },
    )
    .post(
      '/deployments/:id/cancel',
      async ({ ctx, request }) => {
        const call = await kit.call(request)

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
        deployment: {
          id: 'cancel_deployment',
          summary: 'Cancel a deployment before cutover; never staged',
          level: 'deploy',
        },
        response: replies({
          200: Deployment,
        }),
      },
    )
}
