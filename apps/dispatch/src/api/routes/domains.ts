import { and, desc, eq, inArray } from 'drizzle-orm'
import { t } from 'elysia'
import { parse } from 'tldts'

import {
  domainFieldText,
  domainStatusValues,
  ingressValues,
  portAllocationStatusValues,
  StringEnum,
} from '@stationly/protocol'

import { domain, port_allocation, service_port } from '../../db/schema.ts'
import { readSetting } from '../../db/settings.ts'
import { ChangeSet, commit } from '../changes.ts'
import { fail } from '../errors.ts'
import { generatedHostname, hostPortPicker, requireGatewayPin } from '../exposure.ts'
import { projectAll, project as select } from '../fields.ts'
import type { Kit } from '../kit.ts'
import { filterOne, getQuery } from '../pagination.ts'
import { input } from '../schemas.ts'
import { Deleted, Domain, Page, PortAllocation, replies, Staged } from '../shapes.ts'

export const domainRoutes = (kit: Kit) => {
  const { db } = kit.deps
  const domainView = (id: string, fields?: string) =>
    select(
      kit.views.domain,
      db.select().from(domain).where(eq(domain.id, id)).get()!,
      kit.fields(fields),
    )
  const allocationView = (id: string) =>
    select(
      kit.views.allocation,
      db.select().from(port_allocation).where(eq(port_allocation.id, id)).get()!,
      undefined,
    )
  const portsOf = (serviceId: string) =>
    db
      .select({
        id: service_port.id,
      })
      .from(service_port)
      .where(eq(service_port.service_id, serviceId))
      .all()
      .map((p) => p.id)

  return kit
    .router('domains', '/v1')
    .get(
      '/services/:service/domains',
      ({ ctx, query }) => {
        const ports = portsOf(ctx.service.id)
        const rows = ports.length
          ? db
              .select()
              .from(domain)
              .where(
                and(
                  inArray(domain.service_port_id, ports),
                  query.status ? eq(domain.status, query.status as 'active') : undefined,
                ),
              )
              .orderBy(desc(domain.id))
              .all()
          : []

        return {
          items: projectAll(kit.views.domain, rows, kit.fields(query.fields)),
          next_cursor: null,
        }
      },
      {
        service: {
          id: 'list_domains',
          summary: 'List the domains of a service',
          level: 'read',
        },
        query: t.Object({
          ...getQuery,
          status: filterOne(domainStatusValues),
        }),
        response: replies({
          200: Page(Domain),
        }),
      },
    )
    .get(
      '/domains/:id',
      ({ ctx, query }) => select(kit.views.domain, ctx.domain, kit.fields(query.fields)),
      {
        domain: {
          id: 'get_domain',
          summary: 'Get a domain',
          level: 'read',
          mcp: false,
        },
        query: t.Object(getQuery),
        response: replies({
          200: Domain,
        }),
      },
    )
    .post(
      '/ports/:id/domains',
      async ({ ctx, request, body, set }) => {
        const call = await kit.call(request)
        const ingress = body.ingress ?? 'direct'

        if (ctx.port.protocol !== 'http' || ctx.port.grpc) {
          if (ingress === 'tunnel') {
            fail(
              'TUNNEL_UNSUPPORTED_PROTOCOL',
              `Port ${ctx.port.port} is ${ctx.port.grpc ? 'gRPC' : ctx.port.protocol}, which the Tunnel cannot carry.`,
              'Use ingress = direct, or expose a tcp port with POST /v1/ports/{id}/port-allocations.',
            )
          }

          if (ctx.port.protocol !== 'http') {
            fail(
              'VALIDATION_FAILED',
              `Port ${ctx.port.port} is tcp; a domain needs an http port.`,
              'Expose it with POST /v1/ports/{id}/port-allocations instead.',
              {
                issues: [
                  {
                    path: '/id',
                    message: 'port is tcp',
                  },
                ],
              },
            )
          }
        }

        requireGatewayPin(db, ctx.service.station_id)

        if (body.generated === (body.hostname !== undefined)) {
          fail(
            'VALIDATION_FAILED',
            'Send exactly one of generated = true or hostname.',
            undefined,
            {
              issues: [
                {
                  path: '/',
                  message: 'generated xor hostname',
                },
              ],
            },
          )
        }

        let hostname: string

        if (body.hostname !== undefined) {
          hostname = body.hostname.toLowerCase()
          const parsed = parse(hostname, {
            allowPrivateDomains: true,
          })

          if (parsed.isIp || !parsed.domain || parsed.hostname !== hostname) {
            fail(
              'DOMAIN_INVALID',
              `${body.hostname} is not a DNS name under a registrable domain.`,
              'Send a full hostname such as app.example.com.',
            )
          }
        } else {
          hostname =
            generatedHostname(db, ctx.service.name, ctx.environment.name, ctx.service.station_id) ??
            fail(
              'DOMAIN_INVALID',
              'No domains.zone is set and the station has not reported a public address, so no hostname can be generated.',
              'Set the domains.zone setting, or send a hostname.',
            )
        }

        if (
          db
            .select({
              id: domain.id,
            })
            .from(domain)
            .where(eq(domain.hostname, hostname))
            .get()
        ) {
          fail('NAME_TAKEN', `${hostname} is already routed.`, undefined, {
            hostname,
          })
        }

        const ownKey = (['hostnames.dashboard', 'hostnames.api'] as const).find(
          (key) => readSetting(db, key) === hostname,
        )

        if (ownKey) {
          fail(
            'NAME_TAKEN',
            `${hostname} is Dispatch's own hostname (${ownKey}).`,
            'Choose another hostname for the service.',
            {
              hostname,
              setting: ownKey,
            },
          )
        }

        const changes = new ChangeSet()

        changes.add('domain', ctx.port.id, {
          hostname,
          kind: body.generated ? 'generated' : 'custom',
          ingress,
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

        return domainView(result.refs['new:domain:1']!, 'dns_instructions')
      },
      {
        service_port: {
          id: 'add_domain',
          summary: 'Add a generated or custom domain to an http port',
          level: 'admin',
        },
        body: t.Object(
          {
            generated: t.Optional(
              t.Boolean({
                description: domainFieldText.generated,
              }),
            ),
            hostname: t.Optional(
              t.String({
                minLength: 1,
                description: domainFieldText.hostname,
              }),
            ),
            ingress: t.Optional(
              input(
                StringEnum(ingressValues, {
                  description: domainFieldText.ingress,
                }),
              ),
            ),
          },
          {
            additionalProperties: false,
          },
        ),
        response: replies({
          201: Domain,
          202: Staged,
        }),
      },
    )
    .delete(
      '/domains/:id',
      async ({ ctx, request, set }) => {
        const call = await kit.call(request)
        const changes = new ChangeSet()

        changes.remove('domain', ctx.domain.id, select(kit.views.domain, ctx.domain, undefined))
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

        return {
          deleted: true as const,
        }
      },
      {
        domain: {
          id: 'remove_domain',
          summary: 'Remove a domain',
          level: 'admin',
        },
        response: replies({
          200: Deleted,
          202: Staged,
        }),
      },
    )
    .get(
      '/services/:service/port-allocations',
      ({ ctx, query }) => {
        const ports = portsOf(ctx.service.id)
        const rows = ports.length
          ? db
              .select()
              .from(port_allocation)
              .where(
                and(
                  inArray(port_allocation.service_port_id, ports),
                  query.status ? eq(port_allocation.status, query.status as 'active') : undefined,
                ),
              )
              .orderBy(desc(port_allocation.id))
              .all()
          : []

        return {
          items: projectAll(kit.views.allocation, rows, kit.fields(query.fields)),
          next_cursor: null,
        }
      },
      {
        service: {
          id: 'list_tcp_exposures',
          summary: 'List the TCP exposures of a service',
          level: 'read',
        },
        query: t.Object({
          ...getQuery,
          status: filterOne(portAllocationStatusValues),
        }),
        response: replies({
          200: Page(PortAllocation),
        }),
      },
    )
    .post(
      '/ports/:id/port-allocations',
      async ({ ctx, request, set }) => {
        const call = await kit.call(request)

        if (ctx.port.protocol !== 'tcp') {
          fail(
            'VALIDATION_FAILED',
            `Port ${ctx.port.port} is ${ctx.port.protocol}; only tcp ports are exposed this way.`,
            'Add a domain for an http port instead.',
            {
              issues: [
                {
                  path: '/id',
                  message: 'port is not tcp',
                },
              ],
            },
          )
        }

        const picker = hostPortPicker(db, ctx.service.station_id)
        const hostPort =
          picker.next() ??
          fail(
            'PORT_RANGE_EXHAUSTED',
            `Every port in ${picker.range} is allocated on this station.`,
            'Remove an unused TCP exposure, or widen exposure.port_range.',
          )
        const changes = new ChangeSet()

        changes.add('port_allocation', ctx.port.id, {
          station_id: ctx.service.station_id,
          host_port: hostPort,
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

        return allocationView(result.refs['new:port_allocation:1']!)
      },
      {
        service_port: {
          id: 'expose_tcp',
          summary: 'Expose a tcp port on a host port',
          level: 'admin',
        },
        response: replies({
          201: PortAllocation,
          202: Staged,
        }),
      },
    )
    .delete(
      '/port-allocations/:id',
      async ({ ctx, request, set }) => {
        const call = await kit.call(request)

        if (ctx.allocation.status === 'removed') {
          return allocationView(ctx.allocation.id)
        }

        const changes = new ChangeSet()

        changes.update(
          'port_allocation',
          ctx.allocation.id,
          '/status',
          ctx.allocation.status,
          'removed',
        )
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

        return allocationView(ctx.allocation.id)
      },
      {
        port_allocation: {
          id: 'remove_tcp_exposure',
          summary: 'Remove a TCP exposure',
          level: 'admin',
        },
        response: replies({
          200: PortAllocation,
          202: Staged,
        }),
      },
    )
}
