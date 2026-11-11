import { and, asc, eq } from 'drizzle-orm'
import { t } from 'elysia'

import { service_port } from '../../db/schema.ts'
import { ChangeSet, commit, requireNoPortDependents } from '../changes.ts'
import { configDeployTrigger, requireStationReady } from '../deployments.ts'
import { fail } from '../errors.ts'
import { projectAll, project as select } from '../fields.ts'
import type { Kit } from '../kit.ts'
import { getQuery } from '../pagination.ts'
import { PortInput } from '../schemas.ts'
import { Deleted, Page, replies, ServicePort, Staged } from '../shapes.ts'

import { respond, withDeployments } from './services.ts'

const PortWritten = withDeployments(ServicePort)

const PortRemoved = withDeployments(Deleted)

export const portRoutes = (kit: Kit) => {
  const { db } = kit.deps
  const view = (id: string) =>
    select(
      kit.views.port,
      db.select().from(service_port).where(eq(service_port.id, id)).get()!,
      undefined,
    )

  return kit
    .router('ports', '/v1')
    .get(
      '/services/:service/ports',
      ({ ctx, query }) => {
        const rows = db
          .select()
          .from(service_port)
          .where(eq(service_port.service_id, ctx.service.id))
          .orderBy(asc(service_port.port))
          .all()

        return {
          items: projectAll(kit.views.port, rows, kit.fields(query.fields)),
          next_cursor: null,
        }
      },
      {
        service: {
          id: 'list_ports',
          summary: 'List the ports of a service',
          level: 'read',
        },
        query: t.Object(getQuery),
        response: replies({
          200: Page(ServicePort),
        }),
      },
    )
    .post(
      '/services/:service/ports',
      async ({ ctx, request, body, set }) => {
        const call = await kit.call(request)

        if (ctx.service.kind !== 'web') {
          fail('VALIDATION_FAILED', `A ${ctx.service.kind} service has no ports.`, undefined, {
            issues: [
              {
                path: '/port',
                message: `kind ${ctx.service.kind} takes no ports`,
              },
            ],
          })
        }

        if (
          db
            .select()
            .from(service_port)
            .where(
              and(eq(service_port.service_id, ctx.service.id), eq(service_port.port, body.port)),
            )
            .get()
        ) {
          fail('NAME_TAKEN', `${ctx.service.name} already has port ${body.port}.`, undefined, {
            port: body.port,
          })
        }

        requireStationReady(db, ctx.service.station_id)
        const changes = new ChangeSet()

        changes.add('service_port', ctx.service.id, {
          port: body.port,
          protocol: body.protocol ?? 'http',
          grpc: body.grpc ?? false,
        })
        const trigger = configDeployTrigger(ctx.service, ctx.service.source)

        if (trigger) {
          changes.deploy(ctx.service.id, trigger, {
            reason: `port ${body.port} added`,
          })
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

        if (result.applied) {
          set.status = 201
        }

        return respond(kit, set, result, () =>
          view(result.applied ? result.refs['new:service_port:1']! : ''),
        )
      },
      {
        service: {
          id: 'add_port',
          summary: 'Add a port; deploys',
          level: 'deploy',
        },
        body: PortInput,
        response: replies({
          201: PortWritten,
          202: Staged,
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

        changes.update('service_port', ctx.port.id, '/grpc', ctx.port.grpc, body.grpc)
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

        return view(ctx.port.id)
      },
      {
        service_port: {
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
          200: ServicePort,
          202: Staged,
        }),
      },
    )
    .delete(
      '/ports/:id',
      async ({ ctx, request, set }) => {
        const call = await kit.call(request)

        requireNoPortDependents(db, ctx.port.id)
        requireStationReady(db, ctx.service.station_id)
        const changes = new ChangeSet()

        changes.remove('service_port', ctx.port.id, select(kit.views.port, ctx.port, undefined))
        const trigger = configDeployTrigger(ctx.service, ctx.service.source)

        if (trigger) {
          changes.deploy(ctx.service.id, trigger, {
            reason: `port ${ctx.port.port} removed`,
          })
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

        return respond(kit, set, result, () => ({
          deleted: true as const,
        }))
      },
      {
        service_port: {
          id: 'remove_port',
          summary: 'Remove a port; deploys',
          level: 'deploy',
        },
        response: replies({
          200: PortRemoved,
          202: Staged,
        }),
      },
    )
}
