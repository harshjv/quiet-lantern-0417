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

import { service } from '../../db/schema.ts'
import { shapeSamples, type ConnectionsDoc } from '../../net/connections.ts'
import { explainNetwork, probeTarget, type Check } from '../../net/explain.ts'
import type { LiveTick } from '../../net/live.ts'
import { networkMap } from '../../net/map.ts'
import { sendProbe } from '../../net/probe.ts'
import { ChangeSet, commit } from '../changes.ts'
import { fail, invalid } from '../errors.ts'
import { csv, type Kit } from '../kit.ts'
import { getQuery } from '../pagination.ts'
import { DnsLogQuery, input, ProbeBody } from '../schemas.ts'
import {
  DnsLog,
  NetworkConnections,
  NetworkExplanation,
  NetworkMap,
  NetworkProbe,
  replies,
  Staged,
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
      '/environments/:environment/network',
      ({ ctx, query }) => {
        const fields = kit.fields(query.fields)

        return networkMap(sources, ctx.environment, {
          service: query.service,
          rules: selects(fields, 'paths', 'rule'),
          bridges: selects(fields, 'subnets', 'bridge'),
        })
      },
      {
        environment: {
          id: 'describe_network',
          summary:
            "Get an environment's network map: subnets, DNS names, virtual IPs, Switch targets, domains, TCP exposures and every path",
          level: 'read',
          cli: {
            render: 'network-map',
          },
        },
        query: t.Object({
          ...getQuery,
          service: t.Optional(
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
      '/services/:service/connections',
      async ({ ctx, request, query }) => {
        const call = await kit.call(request)
        const reply = await stations
          .ask(
            ctx.service.station_id,
            'network.sample',
            {
              service_ids: [ctx.service.id],
            },
            {
              timeoutMs: 10_000,
            },
          )
          .catch(stationError)
        const sample = reply.body.samples.find((s) => s.service_id === ctx.service.id)

        if (!sample) {
          fail(
            'NOT_FOUND',
            `The station returned no connection sample for ${ctx.service.name}.`,
            `Read the connections again; check the station with sly stations get ${ctx.service.station_id}.`,
            {
              service_id: ctx.service.id,
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
        service: {
          id: 'get_connections',
          summary:
            'Live connections of a service grouped by peer, and refused attempts with the path that refused them; one sample',
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
      '/environments/:environment/network/live',
      async ({ ctx, request, query }) => {
        const call = await kit.call(request)
        const refs = csv(query.service)
        const rows = refs?.length
          ? db
              .select({
                id: service.id,
                name: service.name,
                station_id: service.station_id,
              })
              .from(service)
              .where(
                and(
                  eq(service.environment_id, ctx.environment.id),
                  or(inArray(service.id, refs), inArray(service.name, refs)),
                ),
              )
              .all()
          : db
              .select({
                id: service.id,
                name: service.name,
                station_id: service.station_id,
              })
              .from(service)
              .where(
                and(
                  eq(service.environment_id, ctx.environment.id),
                  eq(service.desired_state, 'running'),
                  isNotNull(service.current_deployment_id),
                  inArray(service.kind, ['web', 'worker']),
                ),
              )
              .all()

        if (refs?.length) {
          const missing = refs.filter((r) => !rows.some((s) => s.id === r || s.name === r))

          if (missing.length) {
            invalid(
              missing.map((m) => ({
                path: '/service',
                message: `no service ${m} in environment ${ctx.environment.name}`,
              })),
            )
          }
        }

        const byStation = new Map<string, Set<string>>()

        for (const s of rows) {
          byStation.set(s.station_id, new Set([...(byStation.get(s.station_id) ?? []), s.id]))
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
            explanation: 'no running service in this environment',
          })
        }

        const leaves = [...byStation].map(([stationId, ids]) =>
          kit.live.subscribe(stationId, ctx.environment.id, {
            ids,
            deliver: (tick) => {
              pending.set(stationId, tick)
              void pump()
            },
            notify: (event, data) => void sse.send(event, data),
          }),
        )
        const unclaim = kit.live.claim(call.principal.credential, ctx.environment.id, () => {
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
        environment: {
          id: 'stream_connections',
          summary:
            'SSE: one connections sample per watched service every 5 s, as event network with { at, samples }',
          level: 'read',
          mcp: false,
          cli: {
            render: 'live-connections',
          },
          stream: true,
        },
        query: t.Object({
          service: t.Optional(
            t.String({
              minLength: 1,
            }),
          ),
          direction,
        }),
      },
    )
    .get(
      '/environments/:environment/network/explain',
      async ({ ctx, query }) => {
        return explainNetwork(explainSources, ctx.environment, {
          from: query.from,
          to: query.to,
          port: query.port,
          protocol: query.protocol ?? 'tcp',
        })
      },
      {
        environment: {
          id: 'explain_network',
          summary:
            'Explain why a service can or cannot reach a target, or why the internet can or cannot reach a domain or TCP exposure, hop by hop with fixes',
          level: 'read',
          cli: false,
        },
        query: t.Object({
          from: t.String({
            minLength: 1,
            description: 'A service of the environment (id or name), or internet',
          }),
          to: t.String({
            minLength: 1,
            maxLength: 260,
            description:
              'A service, service:port, a .internal name, ipv4:port, hostname:port, or with from=internet a domain hostname or public address:host port',
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
      '/services/:service/network/probe',
      async ({ ctx, request, body, set }) => {
        const call = await kit.call(request)

        kit.probeLimit(ctx.service.id, ctx.environment.id)
        const kind = body.kind ?? 'tcp'
        const target = probeTarget(db, ctx.environment, body.to, body.port, kind)
        const probe = {
          kind,
          to: target.to,
          port: target.port,
          timeout_s: body.timeout_s ?? probeTimeout.defaultS,
        }

        if (ctx.environment.protected && !call.principal.human) {
          const changes = new ChangeSet()

          changes.add('network_probe', ctx.service.id, probe)
          const result = commit(
            kit.deps,
            call,
            {
              environment: ctx.environment,
              protect: true,
            },
            changes,
          )

          if (!result.applied) {
            return kit.stagedBody(result, set)
          }
        }

        return sendProbe(kit.deps, call, ctx.service, probe)
      },
      {
        service: {
          id: 'probe_network',
          summary:
            "Send one TCP handshake or one DNS query from inside the service's own namespace, under its own rules; staged for a non-human actor in a protected environment",
          level: 'deploy',
          cli: {
            render: 'probe',
          },
        },
        body: ProbeBody,
        response: replies({
          200: NetworkProbe,
          202: Staged,
        }),
      },
    )
    .get(
      '/services/:service/dns-log',
      async ({ ctx, request, query }) => {
        const call = await kit.call(request)
        const reply = await stations
          .ask(
            ctx.service.station_id,
            'dns.log',
            {
              service_id: ctx.service.id,
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
            : ctx.service.current_deployment_id
              ? [ctx.service.current_deployment_id]
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
        service: {
          id: 'get_dns_log',
          summary:
            "The service's recent DNS queries from the resolver's ring, newest first, as untrusted data",
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
