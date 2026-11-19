import { and, desc, eq, inArray } from 'drizzle-orm'
import { t } from 'elysia'
import { parse } from 'tldts'

import { domainFieldText, domainStatusValues } from '@stationly/protocol'

import { oneLabelProblem } from '../../auth/hostnames.ts'
import { app_port, domain } from '../../db/schema.ts'
import { readSetting } from '../../db/settings.ts'
import { ChangeSet, commit } from '../changes.ts'
import { fail } from '../errors.ts'
import { generatedHostname, requireGatewayPin } from '../exposure.ts'
import { projectAll, project as select } from '../fields.ts'
import type { Kit } from '../kit.ts'
import { isProduction } from '../lookup.ts'
import { filterOne, getQuery } from '../pagination.ts'
import { ApprovalDetail, Deleted, Domain, Page, replies } from '../shapes.ts'

export const domainRoutes = (kit: Kit) => {
  const { db } = kit.deps
  const domainView = (id: string, fields?: string) =>
    select(
      kit.views.domain,
      db.select().from(domain).where(eq(domain.id, id)).get()!,
      kit.fields(fields),
    )
  const portsOf = (appId: string) =>
    db
      .select({
        id: app_port.id,
      })
      .from(app_port)
      .where(eq(app_port.app_id, appId))
      .all()
      .map((p) => p.id)

  return kit
    .router('domains', '/v1')
    .get(
      '/apps/:app/domains',
      ({ ctx, query }) => {
        const ports = portsOf(ctx.app.id)
        const rows = ports.length
          ? db
              .select()
              .from(domain)
              .where(
                and(
                  inArray(domain.app_port_id, ports),
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
        app: {
          id: 'list_domains',
          summary: 'List the domains of an app',
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

        if (ctx.port.protocol !== 'http' || ctx.port.grpc) {
          fail(
            'TUNNEL_UNSUPPORTED_PROTOCOL',
            `Port ${ctx.port.port} is ${ctx.port.grpc ? 'gRPC' : ctx.port.protocol}, which the Cloudflare Tunnel cannot carry to the public.`,
            ctx.port.grpc
              ? 'A gRPC port cannot be exposed in this release; reach it from another app over its .internal name.'
              : 'Reach a tcp port from another app over its .internal name.',
          )
        }

        requireGatewayPin(db, ctx.app.server_id)

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

          const zone = readSetting(db, 'domains.zone')
          const deep = zone ? oneLabelProblem(hostname, zone) : null

          if (deep) {
            fail('DOMAIN_INVALID', `${deep}.`, 'Send a hostname one label under the zone.')
          }
        } else {
          hostname =
            generatedHostname(db, ctx.app.name, ctx.target_row.name) ??
            fail(
              'DOMAIN_INVALID',
              'No domains.zone is set, so no hostname can be generated.',
              'Run sly setup first, or send a hostname.',
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
            'Choose another hostname for the app.',
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

        set.status = 201

        return domainView(result.refs['new:domain:1']!, 'tunnel_route')
      },
      {
        app_port: {
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
          },
          {
            additionalProperties: false,
          },
        ),
        response: replies({
          201: Domain,
          202: ApprovalDetail,
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
          202: ApprovalDetail,
        }),
      },
    )
}
