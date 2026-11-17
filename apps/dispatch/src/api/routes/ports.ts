import { and, asc, eq } from 'drizzle-orm'
import { t } from 'elysia'

import { app_port } from '../../db/schema.ts'
import { ChangeSet, commit, requireNoPortDependents } from '../changes.ts'
import { configDeployTrigger, requireStationReady } from '../deployments.ts'
import { fail } from '../errors.ts'
import { projectAll, project as select } from '../fields.ts'
import type { Kit } from '../kit.ts'
import { isProduction } from '../lookup.ts'
import { getQuery } from '../pagination.ts'
import { PortInput } from '../schemas.ts'
import { AppPort, ApprovalDetail, Deleted, Page, replies } from '../shapes.ts'

import { respond, withDeployments } from './services.ts'

const PortWritten = withDeployments(AppPort)

const PortRemoved = withDeployments(Deleted)

export const portRoutes = (kit: Kit) => {
  const { db } = kit.deps
  const view = (id: string) =>
    select(kit.views.port, db.select().from(app_port).where(eq(app_port.id, id)).get()!, undefined)

  return kit
    .router('ports', '/v1')
    .get(
      '/apps/:app/ports',
      ({ ctx, query }) => {
        const rows = db
          .select()
          .from(app_port)
          .where(eq(app_port.app_id, ctx.app.id))
          .orderBy(asc(app_port.port))
          .all()

        return {
          items: projectAll(kit.views.port, rows, kit.fields(query.fields)),
          next_cursor: null,
        }
      },
      {
        app: {
          id: 'list_ports',
          summary: 'List the ports of an app',
          level: 'read',
        },
        query: t.Object(getQuery),
        response: replies({
          200: Page(AppPort),
        }),
      },
    )
    .post(
      '/apps/:app/ports',
      async ({ ctx, request, body, set }) => {
        const call = await kit.call(request)

        if (ctx.app.kind !== 'web') {
          fail('VALIDATION_FAILED', `A ${ctx.app.kind} app has no ports.`, undefined, {
            issues: [
              {
                path: '/port',
                message: `kind ${ctx.app.kind} takes no ports`,
              },
            ],
          })
        }

        if (
          db
            .select()
            .from(app_port)
            .where(and(eq(app_port.app_id, ctx.app.id), eq(app_port.port, body.port)))
            .get()
        ) {
          fail('NAME_TAKEN', `${ctx.app.name} already has port ${body.port}.`, undefined, {
            port: body.port,
          })
        }

        requireStationReady(db, ctx.app.server_id)
        const changes = new ChangeSet()

        changes.add('app_port', ctx.app.id, {
          port: body.port,
          protocol: body.protocol ?? 'http',
          grpc: body.grpc ?? false,
        })
        const trigger = configDeployTrigger(ctx.app, ctx.app.source)

        if (trigger) {
          changes.deploy(ctx.app.id, trigger, {
            reason: `port ${body.port} added`,
          })
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

        if (result.applied) {
          set.status = 201
        }

        return respond(kit, set, result, () =>
          view(result.applied ? result.refs['new:app_port:1']! : ''),
        )
      },
      {
        app: {
          id: 'add_port',
          summary: 'Add a port; deploys',
          level: 'deploy',
        },
        body: PortInput,
        response: replies({
          201: PortWritten,
          202: ApprovalDetail,
        }),
      },
    )
    .patch(
      '/ports/:id',
      async ({ ctx, request, body, set }) => {
        const call = await kit.call(request)

        if (body.grpc === undefined || body.grpc === ctx.port.grpc) {
          return view(ctx.port.id)
        }

        const changes = new ChangeSet()

        changes.update('app_port', ctx.port.id, '/grpc', ctx.port.grpc, body.grpc)
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

        return view(ctx.port.id)
      },
      {
        app_port: {
          id: 'update_port',
          summary: 'Mark a port as gRPC',
          level: 'deploy',
        },
        body: t.Object(
          {
            grpc: PortInput.properties.grpc,
          },
          {
            additionalProperties: false,
          },
        ),
        response: replies({
          200: AppPort,
          202: ApprovalDetail,
        }),
      },
    )
    .delete(
      '/ports/:id',
      async ({ ctx, request, set }) => {
        const call = await kit.call(request)

        requireNoPortDependents(db, ctx.port.id)
        requireStationReady(db, ctx.app.server_id)
        const changes = new ChangeSet()

        changes.remove('app_port', ctx.port.id, select(kit.views.port, ctx.port, undefined))
        const trigger = configDeployTrigger(ctx.app, ctx.app.source)

        if (trigger) {
          changes.deploy(ctx.app.id, trigger, {
            reason: `port ${ctx.port.port} removed`,
          })
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

        return respond(kit, set, result, () => ({
          deleted: true as const,
        }))
      },
      {
        app_port: {
          id: 'remove_port',
          summary: 'Remove a port; deploys',
          level: 'deploy',
        },
        response: replies({
          200: PortRemoved,
          202: ApprovalDetail,
        }),
      },
    )
}
