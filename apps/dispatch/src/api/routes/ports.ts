import { and, asc, eq } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { service_port } from '../../db/schema.ts'
import { ChangeSet, commit, requireNoPortDependents } from '../changes.ts'
import { configDeployTrigger, requireStationReady } from '../deployments.ts'
import { fail } from '../errors.ts'
import { project as select, projectAll } from '../fields.ts'
import type { Kit } from '../kit.ts'
import { portById, serviceById } from '../lookup.ts'
import { getQuery } from '../pagination.ts'
import { PortInput } from '../schemas.ts'
import { Deleted, models, Page, replies, ServicePort, Staged } from '../shapes.ts'
import { respond, withDeployments } from './services.ts'

const PortWritten = withDeployments(ServicePort)

const PortRemoved = withDeployments(Deleted)

export const portRoutes = (kit: Kit) => {
  const { db } = kit.deps
  const tags = ['ports']
  const view = (id: string) => select(kit.views.port, db.select().from(service_port).where(eq(service_port.id, id)).get()!, undefined)

  return new Elysia({ prefix: '/v1', normalize: false }).use(models()).use(kit.operations)
    .get(
      '/services/:service/ports',
      async ({ params, query }) => {
        const ctx = serviceById(db, params.service)
        const rows = db.select().from(service_port).where(eq(service_port.service_id, ctx.service.id)).orderBy(asc(service_port.port)).all()
        return { items: projectAll(kit.views.port, rows, kit.fields(query.fields)), next_cursor: null }
      },
      { operation: { id: 'list_ports', level: 'read' }, params: t.Object({ service: t.String() }), query: t.Object(getQuery), response: replies({ 200: Page(ServicePort) }), detail: { summary: 'List the ports of a service', tags } }
    )
    .post(
      '/services/:service/ports',
      async ({ request, params, body, set }) => {
        const call = await kit.call(request)
        const ctx = serviceById(db, params.service)
        if (ctx.service.kind !== 'web') fail('VALIDATION_FAILED', `A ${ctx.service.kind} service has no ports.`, undefined, { issues: [{ path: '/port', message: `kind ${ctx.service.kind} takes no ports` }] })
        if (db.select().from(service_port).where(and(eq(service_port.service_id, ctx.service.id), eq(service_port.port, body.port))).get()) {
          fail('NAME_TAKEN', `${ctx.service.name} already has port ${body.port}.`, undefined, { port: body.port })
        }
        requireStationReady(db, ctx.service.station_id)
        const changes = new ChangeSet()
        changes.add('service_port', ctx.service.id, { port: body.port, protocol: body.protocol ?? 'http', grpc: body.grpc ?? false })
        const trigger = configDeployTrigger(ctx.service, ctx.service.source)
        if (trigger) changes.deploy(ctx.service.id, trigger, { reason: `port ${body.port} added` })
        const result = commit(kit.deps, call, { environment: ctx.environment, protect: ctx.environment.protected }, changes)
        if (result.applied) set.status = 201
        return respond(kit, set, result, () => view(result.applied ? result.refs['new:service_port:1']! : ''))
      },
      {
        operation: { id: 'add_port', level: 'deploy' },
        params: t.Object({ service: t.String() }),
        body: PortInput,
        response: replies({ 201: PortWritten, 202: Staged }),
        detail: { summary: 'Add a port; deploys', tags }
      }
    )
    .patch(
      '/ports/:id',
      async ({ request, params, body, set }) => {
        const call = await kit.call(request)
        const ctx = portById(db, params.id)
        if (body.grpc === undefined || body.grpc === ctx.port.grpc) return view(ctx.port.id)
        const changes = new ChangeSet()
        changes.update('service_port', ctx.port.id, '/grpc', ctx.port.grpc, body.grpc)
        const result = commit(kit.deps, call, { environment: ctx.environment, protect: ctx.environment.protected }, changes)
        if (!result.applied) return kit.stagedBody(result, set)
        return view(ctx.port.id)
      },
      { operation: { id: 'update_port', level: 'deploy' }, params: t.Object({ id: t.String() }), body: t.Object({ grpc: t.Optional(t.Boolean()) }, { additionalProperties: false }), response: replies({ 200: ServicePort, 202: Staged }), detail: { summary: 'Mark a port as gRPC', tags } }
    )
    .delete(
      '/ports/:id',
      async ({ request, params, set }) => {
        const call = await kit.call(request)
        const ctx = portById(db, params.id)
        requireNoPortDependents(db, ctx.port.id)
        requireStationReady(db, ctx.service.station_id)
        const changes = new ChangeSet()
        changes.remove('service_port', ctx.port.id, select(kit.views.port, ctx.port, undefined))
        const trigger = configDeployTrigger(ctx.service, ctx.service.source)
        if (trigger) changes.deploy(ctx.service.id, trigger, { reason: `port ${ctx.port.port} removed` })
        const result = commit(kit.deps, call, { environment: ctx.environment, protect: ctx.environment.protected }, changes)
        return respond(kit, set, result, () => ({ deleted: true as const }))
      },
      { operation: { id: 'remove_port', level: 'deploy' }, params: t.Object({ id: t.String() }), response: replies({ 200: PortRemoved, 202: Staged }), detail: { summary: 'Remove a port; deploys', tags } }
    )
}
