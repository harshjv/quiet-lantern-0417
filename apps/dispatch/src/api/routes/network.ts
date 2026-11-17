import { and, eq, inArray, isNotNull, or } from 'drizzle-orm'
import { t } from 'elysia'

import {
  dnsLogTail,
  networkDirectionValues,
  networkProtocolValues,
  portRange,
  probeTimeout,
  StringEnum,
  type MessageBody,
} from '@stationly/protocol'

import { app } from '../../db/schema.ts'
import { shapeSamples, type ConnectionsDoc } from '../../net/connections.ts'
import { explainNetwork, probeTarget, type Check } from '../../net/explain.ts'
import type { LiveTick } from '../../net/live.ts'
import { networkMap } from '../../net/map.ts'
import { sendProbe } from '../../net/probe.ts'
import { ChangeSet, commit } from '../changes.ts'
import { fail, invalid } from '../errors.ts'
import { csv, type Kit } from '../kit.ts'
import { isProduction, placeName } from '../lookup.ts'
import { getQuery, previewQuery } from '../pagination.ts'
import { DnsLogQuery, input, ProbeBody } from '../schemas.ts'
import {
  ApprovalDetail,
  DnsLog,
  NetworkConnections,
  NetworkExplanation,
  NetworkMap,
  NetworkProbe,
  replies,
} from '../shapes.ts'
import { createSse } from '../sse.ts'

import { stationError } from './runs.ts'

const selects = (fields: ReturnType<Kit['fields']>, parent: string, child: string) => {
  if (!fields) {
    return false
  }

  if (fields.has('*')) {
    return true
  }

  const node = fields.get(parent)

  return node !== undefined && (node.size === 0 || node.has(child) || node.has('*'))
}

const direction = t.Optional(input(StringEnum(networkDirectionValues)))

export const networkRoutes = (kit: Kit) => {
  const { db, stations } = kit.deps
  const sources = {
    db,
    observedOf: stations.observedOf,
    isConnected: stations.isConnected,
    edgesOf: kit.views.edges,
  }
  const explainSources = {
    ...sources,
    inspect: async (stationId: string, checks: Check[]) => {
      const reply = await stations
        .ask(
          stationId,
          'network.inspect',
          {
            checks,
          },
          {
            timeoutMs: 10_000,
          },
        )
        .catch(stationError)

      return reply.body.results
    },
    dnsLog: async (stationId: string, body: MessageBody<'dns.log'>) => {
      const reply = await stations
        .ask(stationId, 'dns.log', body, {
          timeoutMs: 10_000,
        })
        .catch(stationError)

      return reply.body.entries
    },
  }

  return kit
    .router('network', '/v1')
    .get(
      '/projects/:project/network',
      ({ ctx, query }) => {
        const fields = kit.fields(query.fields)

        return networkMap(sources, ctx.target_row, {
          app: query.app,
          rules: selects(fields, 'paths', 'rule'),
          bridges: selects(fields, 'subnets', 'bridge'),
        })
      },
      {
        place: {
          id: 'describe_network',
          summary:
            'Get the network map of production or a preview: subnets, DNS names, virtual IPs, Switch targets, domains, TCP exposures and every path',
          level: 'read',
          cli: {
            render: 'network-map',
          },
        },
        query: t.Object({
          ...previewQuery,
          ...getQuery,
          app: t.Optional(
            t.String({
              minLength: 1,
            }),
          ),
        }),
        response: replies({
          200: NetworkMap,
        }),
      },
    )
    .get(
      '/apps/:app/connections',
      async ({ ctx, request, query }) => {
        const call = await kit.call(request)
        const reply = await stations
          .ask(
            ctx.app.server_id,
            'network.sample',
            {
              service_ids: [ctx.app.id],
            },
            {
              timeoutMs: 10_000,
            },
          )
          .catch(stationError)
        const sample = reply.body.samples.find((s) => s.service_id === ctx.app.id)

        if (!sample) {
          fail(
            'NOT_FOUND',
            `The server returned no connection sample for ${ctx.app.name}.`,
            `Read the connections again; check the server with sly servers get ${ctx.app.server_id}.`,
            {
              app_id: ctx.app.id,
            },
          )
        }

        return shapeSamples(
          {
            db,
            redaction: kit.redaction,
            actor: call.principal.actor,
            requestId: call.request_id,
          },
          [sample!],
          query.direction,
        )[0]!
      },
      {
        app: {
          id: 'get_connections',
          summary:
            'Live connections of an app grouped by peer, and refused attempts with the path that refused them; one sample',
          level: 'read',
          cli: {
            render: 'connections',
          },
        },
        query: t.Object({
          direction,
        }),
        response: replies({
          200: NetworkConnections,
        }),
      },
    )
    .get(
      '/projects/:project/network/live',
      async ({ ctx, request, query }) => {
        const call = await kit.call(request)
        const refs = csv(query.app)
        const rows = refs?.length
          ? db
              .select({
                id: app.id,
                name: app.name,
                server_id: app.server_id,
              })
              .from(app)
              .where(
                and(
                  eq(app.target_id, ctx.target_row.id),
                  or(inArray(app.id, refs), inArray(app.name, refs)),
                ),
              )
              .all()
          : db
              .select({
                id: app.id,
                name: app.name,
                server_id: app.server_id,
              })
              .from(app)
              .where(
                and(
                  eq(app.target_id, ctx.target_row.id),
                  eq(app.desired_state, 'running'),
                  isNotNull(app.current_deployment_id),
                  inArray(app.kind, ['web', 'worker']),
                ),
              )
              .all()

        if (refs?.length) {
          const missing = refs.filter((r) => !rows.some((s) => s.id === r || s.name === r))

          if (missing.length) {
            invalid(
              missing.map((m) => ({
                path: '/app',
                message: `no app ${m} in ${placeName(ctx.target_row)}`,
              })),
            )
          }
        }

        const byStation = new Map<string, Set<string>>()

        for (const s of rows) {
          byStation.set(s.server_id, new Set([...(byStation.get(s.server_id) ?? []), s.id]))
        }

        const shape = {
          db,
          redaction: kit.redaction,
          actor: call.principal.actor,
          requestId: call.request_id,
        }
        const sse = createSse(request.signal)
        const pending = new Map<string, LiveTick>()
        let sending = false
        const pump = async () => {
          if (sending) {
            return
          }

          sending = true

          while (pending.size && !sse.closed()) {
            const [stationId, tick] = pending.entries().next().value!

            pending.delete(stationId)
            const samples: ConnectionsDoc[] = shapeSamples(shape, tick.samples, query.direction)

            await sse.send(
              'network',
              {
                at: tick.at,
                samples,
              },
              tick.at,
            )
          }

          sending = false
        }

        if (!byStation.size) {
          void sse.send('empty', {
            explanation: 'no running app here',
          })
        }

        const leaves = [...byStation].map(([stationId, ids]) =>
          kit.live.subscribe(stationId, ctx.target_row.id, {
            ids,
            deliver: (tick) => {
              pending.set(stationId, tick)
              void pump()
            },
            notify: (event, data) => void sse.send(event, data),
          }),
        )
        const unclaim = kit.live.claim(call.principal.credential, ctx.target_row.id, () => {
          void sse.send('end', {
            reason: 'replaced by a newer live stream from the same credential',
          })
          sse.close()
        })

        sse.onClose(() => {
          unclaim()

          for (const leave of leaves) {
            leave()
          }
        })

        return sse.response
      },
      {
        place: {
          id: 'stream_connections',
          summary:
            'SSE: one connections sample per watched app every 5 s, as event network with { at, samples }',
          level: 'read',
          mcp: false,
          cli: {
            render: 'live-connections',
          },
          stream: true,
        },
        query: t.Object({
          ...previewQuery,
          app: t.Optional(
            t.String({
              minLength: 1,
            }),
          ),
          direction,
        }),
      },
    )
    .get(
      '/projects/:project/network/explain',
      async ({ ctx, query }) => {
        return explainNetwork(explainSources, ctx.target_row, {
          from: query.from,
          to: query.to,
          port: query.port,
          protocol: query.protocol ?? 'tcp',
        })
      },
      {
        place: {
          id: 'explain_network',
          summary:
            'Explain why an app can or cannot reach a target, or why the internet can or cannot reach a domain or TCP exposure, hop by hop with fixes',
          level: 'read',
          cli: false,
        },
        query: t.Object({
          ...previewQuery,
          from: t.String({
            minLength: 1,
            description: 'An app (id or name), or internet',
          }),
          to: t.String({
            minLength: 1,
            maxLength: 260,
            description:
              'An app, app:port, a .internal name, ipv4:port, hostname:port, or with from=internet a domain hostname or public address:host port',
          }),
          port: t.Optional(t.Numeric(portRange)),
          protocol: t.Optional(input(StringEnum(networkProtocolValues))),
        }),
        response: replies({
          200: NetworkExplanation,
        }),
      },
    )
    .post(
      '/apps/:app/network/probe',
      async ({ ctx, request, body, set }) => {
        const call = await kit.call(request)

        kit.probeLimit(ctx.app.id, ctx.target_row.id)
        const kind = body.kind ?? 'tcp'
        const target = probeTarget(db, ctx.target_row, body.to, body.port, kind)
        const probe = {
          kind,
          to: target.to,
          port: target.port,
          timeout_s: body.timeout_s ?? probeTimeout.defaultS,
        }

        if (isProduction(ctx.target_row) && !call.principal.human) {
          const changes = new ChangeSet()

          changes.add('network_probe', ctx.app.id, probe)
          const result = commit(
            kit.deps,
            call,
            {
              target: ctx.target_row,
              protect: true,
            },
            changes,
          )

          if (!result.applied) {
            return kit.approvalBody(result, set)
          }
        }

        return sendProbe(kit.deps, call, ctx.app, probe)
      },
      {
        app: {
          id: 'probe_network',
          summary:
            "Send one TCP handshake or one DNS query from inside the app's own namespace, under its own rules; needs approval for a non-human actor in production",
          level: 'deploy',
          cli: {
            render: 'probe',
          },
        },
        body: ProbeBody,
        response: replies({
          200: NetworkProbe,
          202: ApprovalDetail,
        }),
      },
    )
    .get(
      '/apps/:app/dns-log',
      async ({ ctx, request, query }) => {
        const call = await kit.call(request)
        const reply = await stations
          .ask(
            ctx.app.server_id,
            'dns.log',
            {
              service_id: ctx.app.id,
              tail: query.tail ?? dnsLogTail.default,
              ...(query.name
                ? {
                    name: query.name,
                  }
                : {}),
              ...(query.rcode
                ? {
                    rcode: query.rcode,
                  }
                : {}),
            },
            {
              timeoutMs: 10_000,
            },
          )
          .catch(stationError)
        const entries = reply.body.entries
        const deployments = [
          ...new Set(entries.flatMap((e) => (e.deployment_id ? [e.deployment_id] : []))),
        ]
        const redact = kit.redaction(
          deployments.length
            ? deployments
            : ctx.app.current_deployment_id
              ? [ctx.app.current_deployment_id]
              : [],
          call.principal.actor,
          call.request_id,
        )

        return {
          untrusted: {
            source: 'resolver log' as const,
            entries: entries.map((e) => ({
              ...e,
              name: redact(e.name),
            })),
          },
        }
      },
      {
        app: {
          id: 'get_dns_log',
          summary:
            "The app's recent DNS queries from the resolver's ring, newest first, as untrusted data",
          level: 'read',
          cli: {
            render: 'dns-log',
          },
        },
        query: DnsLogQuery,
        response: replies({
          200: DnsLog,
        }),
      },
    )
}
