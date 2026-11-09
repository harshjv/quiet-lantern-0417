import { and, desc, eq, inArray } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { parse } from 'tldts'
import { domain, port_allocation, service_port, setting } from '../../db/schema.ts'
import { requireLevel } from '../access.ts'
import { ChangeSet, commit } from '../changes.ts'
import { fail } from '../errors.ts'
import { project as select, projectAll } from '../fields.ts'
import type { Kit } from '../kit.ts'
import { allocationById, domainById, portById, serviceById } from '../lookup.ts'
import { getQuery } from '../pagination.ts'
import { generatedHostname, hostPortPicker, requireGatewayPin } from '../exposure.ts'
import { Deleted, Domain, models, Page, PortAllocation, replies, Staged } from '../shapes.ts'

export const domainRoutes = (kit: Kit) => {
  const { db } = kit.deps
  const tags = ['domains']
  const domainView = (id: string, fields?: string) => select(kit.views.domain, db.select().from(domain).where(eq(domain.id, id)).get()!, kit.fields(fields))
  const allocationView = (id: string) => select(kit.views.allocation, db.select().from(port_allocation).where(eq(port_allocation.id, id)).get()!, undefined)
  const portsOf = (serviceId: string) => db.select({ id: service_port.id }).from(service_port).where(eq(service_port.service_id, serviceId)).all().map(p => p.id)

  return new Elysia({ prefix: '/v1', normalize: false }).use(models())
    .get(
      '/services/:service/domains',
      async ({ request, params, query }) => {
        const principal = await kit.principal(request)
        const ctx = serviceById(db, params.service)
        requireLevel(principal, ctx.target, 'read')
        const ports = portsOf(ctx.service.id)
        const rows = ports.length
          ? db
              .select()
              .from(domain)
              .where(and(inArray(domain.service_port_id, ports), query.status ? eq(domain.status, query.status as 'active') : undefined))
              .orderBy(desc(domain.id))
              .all()
          : []
        return { items: projectAll(kit.views.domain, rows, kit.fields(query.fields)), next_cursor: null }
      },
      { params: t.Object({ service: t.String() }), query: t.Object({ ...getQuery, status: t.Optional(t.String()) }), response: replies({ 200: Page(Domain) }), detail: { summary: 'List the domains of a service', tags } }
    )
    .get(
      '/domains/:id',
      async ({ request, params, query }) => {
        const principal = await kit.principal(request)
        const ctx = domainById(db, params.id)
        requireLevel(principal, ctx.target, 'read')
        return select(kit.views.domain, ctx.domain, kit.fields(query.fields))
      },
      { params: t.Object({ id: t.String() }), query: t.Object(getQuery), response: replies({ 200: Domain }), detail: { summary: 'Get a domain', tags } }
    )
    .post(
      '/ports/:id/domains',
      async ({ request, params, body, set }) => {
        const call = await kit.call(request)
        const ctx = portById(db, params.id)
        requireLevel(call.principal, ctx.target, 'admin')
        const ingress = body.ingress ?? 'direct'
        if (ctx.port.protocol !== 'http' || ctx.port.grpc) {
          if (ingress === 'tunnel') fail('TUNNEL_UNSUPPORTED_PROTOCOL', `Port ${ctx.port.port} is ${ctx.port.grpc ? 'gRPC' : ctx.port.protocol}, which the Tunnel cannot carry.`, 'Use ingress = direct, or expose a tcp port with POST /v1/ports/{id}/port-allocations.')
          if (ctx.port.protocol !== 'http') fail('VALIDATION_FAILED', `Port ${ctx.port.port} is tcp; a domain needs an http port.`, 'Expose it with POST /v1/ports/{id}/port-allocations instead.', { issues: [{ path: '/id', message: 'port is tcp' }] })
        }
        requireGatewayPin(db, ctx.service.station_id)
        if (body.generated === (body.hostname !== undefined)) fail('VALIDATION_FAILED', 'Send exactly one of generated = true or hostname.', undefined, { issues: [{ path: '/', message: 'generated xor hostname' }] })
        let hostname: string
        if (body.hostname !== undefined) {
          hostname = body.hostname.toLowerCase()
          const parsed = parse(hostname, { allowPrivateDomains: true })
          if (parsed.isIp || !parsed.domain || parsed.hostname !== hostname) fail('DOMAIN_INVALID', `${body.hostname} is not a DNS name under a registrable domain.`, 'Send a full hostname such as app.example.com.')
        } else {
          hostname =
            generatedHostname(db, ctx.service.name, ctx.environment.name, ctx.service.station_id) ??
            fail('DOMAIN_INVALID', 'No domains.zone is set and the station has not reported a public address, so no hostname can be generated.', 'Set the domains.zone setting, or send a hostname.')
        }
        if (db.select({ id: domain.id }).from(domain).where(eq(domain.hostname, hostname)).get()) fail('NAME_TAKEN', `${hostname} is already routed.`, undefined, { hostname })
        const ownKey = (['hostnames.dashboard', 'hostnames.api'] as const).find(key => db.select().from(setting).where(eq(setting.key, key)).get()?.value === hostname)
        if (ownKey) fail('NAME_TAKEN', `${hostname} is Dispatch's own hostname (${ownKey}).`, 'Choose another hostname for the service.', { hostname, setting: ownKey })
        const changes = new ChangeSet()
        changes.add('domain', ctx.port.id, { hostname, kind: body.generated ? 'generated' : 'custom', ingress })
        const result = commit(kit.deps, call, { environment: ctx.environment, protect: ctx.environment.protected }, changes)
        if (!result.applied) return kit.stagedBody(result, set)
        set.status = 201
        return domainView(result.refs['new:domain:1']!, 'dns_instructions')
      },
      {
        params: t.Object({ id: t.String() }),
        body: t.Object(
          { generated: t.Optional(t.Boolean()), hostname: t.Optional(t.String({ minLength: 1 })), ingress: t.Optional(t.Union([t.Literal('direct'), t.Literal('tunnel')])) },
          { additionalProperties: false }
        ),
        response: replies({ 201: Domain, 202: Staged }),
        detail: { summary: 'Add a generated or custom domain to an http port', tags }
      }
    )
    .delete(
      '/domains/:id',
      async ({ request, params, set }) => {
        const call = await kit.call(request)
        const ctx = domainById(db, params.id)
        requireLevel(call.principal, ctx.target, 'admin')
        const changes = new ChangeSet()
        changes.remove('domain', ctx.domain.id, select(kit.views.domain, ctx.domain, undefined))
        const result = commit(kit.deps, call, { environment: ctx.environment, protect: ctx.environment.protected }, changes)
        if (!result.applied) return kit.stagedBody(result, set)
        return { deleted: true as const }
      },
      { params: t.Object({ id: t.String() }), response: replies({ 200: Deleted, 202: Staged }), detail: { summary: 'Remove a domain', tags } }
    )
    .get(
      '/services/:service/port-allocations',
      async ({ request, params, query }) => {
        const principal = await kit.principal(request)
        const ctx = serviceById(db, params.service)
        requireLevel(principal, ctx.target, 'read')
        const ports = portsOf(ctx.service.id)
        const rows = ports.length
          ? db
              .select()
              .from(port_allocation)
              .where(and(inArray(port_allocation.service_port_id, ports), query.status ? eq(port_allocation.status, query.status as 'active') : undefined))
              .orderBy(desc(port_allocation.id))
              .all()
          : []
        return { items: projectAll(kit.views.allocation, rows, kit.fields(query.fields)), next_cursor: null }
      },
      { params: t.Object({ service: t.String() }), query: t.Object({ ...getQuery, status: t.Optional(t.String()) }), response: replies({ 200: Page(PortAllocation) }), detail: { summary: 'List the TCP exposures of a service', tags } }
    )
    .post(
      '/ports/:id/port-allocations',
      async ({ request, params, set }) => {
        const call = await kit.call(request)
        const ctx = portById(db, params.id)
        requireLevel(call.principal, ctx.target, 'admin')
        if (ctx.port.protocol !== 'tcp') fail('VALIDATION_FAILED', `Port ${ctx.port.port} is ${ctx.port.protocol}; only tcp ports are exposed this way.`, 'Add a domain for an http port instead.', { issues: [{ path: '/id', message: 'port is not tcp' }] })
        const picker = hostPortPicker(db, ctx.service.station_id)
        const hostPort = picker.next() ?? fail('PORT_RANGE_EXHAUSTED', `Every port in ${picker.range} is allocated on this station.`, 'Remove an unused TCP exposure, or widen exposure.port_range.')
        const changes = new ChangeSet()
        changes.add('port_allocation', ctx.port.id, { station_id: ctx.service.station_id, host_port: hostPort })
        const result = commit(kit.deps, call, { environment: ctx.environment, protect: ctx.environment.protected }, changes)
        if (!result.applied) return kit.stagedBody(result, set)
        set.status = 201
        return allocationView(result.refs['new:port_allocation:1']!)
      },
      { params: t.Object({ id: t.String() }), response: replies({ 201: PortAllocation, 202: Staged }), detail: { summary: 'Expose a tcp port on a host port', tags } }
    )
    .delete(
      '/port-allocations/:id',
      async ({ request, params, set }) => {
        const call = await kit.call(request)
        const ctx = allocationById(db, params.id)
        requireLevel(call.principal, ctx.target, 'admin')
        if (ctx.allocation.status === 'removed') return allocationView(ctx.allocation.id)
        const changes = new ChangeSet()
        changes.update('port_allocation', ctx.allocation.id, '/status', ctx.allocation.status, 'removed')
        const result = commit(kit.deps, call, { environment: ctx.environment, protect: ctx.environment.protected }, changes)
        if (!result.applied) return kit.stagedBody(result, set)
        return allocationView(ctx.allocation.id)
      },
      { params: t.Object({ id: t.String() }), response: replies({ 200: PortAllocation, 202: Staged }), detail: { summary: 'Remove a TCP exposure', tags } }
    )
}
