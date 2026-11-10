import { and, eq, inArray, isNotNull, or } from 'drizzle-orm'
import { Elysia, t } from 'elysia'

import { dnsLogTail, portRange, probeTimeout, type MessageBody } from '@stationly/protocol'

import { service } from '../../db/schema.ts'
import { shapeSamples, type ConnectionsDoc } from '../../net/connections.ts'
import { explainNetwork, probeTarget, type Check } from '../../net/explain.ts'
import type { LiveTick } from '../../net/live.ts'
import { networkMap } from '../../net/map.ts'
import { sendProbe } from '../../net/probe.ts'
import { ChangeSet, commit } from '../changes.ts'
import { fail, invalid } from '../errors.ts'
import { csv, type Kit } from '../kit.ts'
import { environmentById, serviceById } from '../lookup.ts'
import { getQuery } from '../pagination.ts'
import { ProbeBody } from '../schemas.ts'
import {
  DnsLog,
  models,
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
  if (!fields) return false
  if (fields.has('*')) return true
  const node = fields.get(parent)
  return node !== undefined && (node.size === 0 || node.has(child) || node.has('*'))
}

const direction = t.Optional(t.Union([t.Literal('in'), t.Literal('out')]))

export const networkRoutes = (kit: Kit) => {
  const { db, stations } = kit.deps
  const tags = ['network']
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
            capability: 'network.v1',
            timeoutMs: 10_000,
          },
        )
        .catch(stationError)
      return (reply.body as MessageBody<'network.inspect.result'>).results
    },
    dnsLog: async (stationId: string, body: MessageBody<'dns.log'>) => {
      const reply = await stations
        .ask(stationId, 'dns.log', body, {
          capability: 'network.v1',
          timeoutMs: 10_000,
        })
        .catch(stationError)
      return (reply.body as MessageBody<'dns.log.result'>).entries
    },
  }

  return new Elysia({
    prefix: '/v1',
    normalize: false,
  })
    .use(models())
    .use(kit.operations)
    .get(
      '/environments/:environment/network',
      ({ params, query }) => {
        const ctx = environmentById(db, params.environment)
        const fields = kit.fields(query.fields)
        return networkMap(sources, ctx.environment, {
          service: query.service,
          rules: selects(fields, 'paths', 'rule'),
          bridges: selects(fields, 'subnets', 'bridge'),
        })
      },
      {
        operation: {
          id: 'describe_network',
          level: 'read',
          cli: {
            render: 'network-map',
          },
        },
        params: t.Object({
          environment: t.String(),
        }),
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
        detail: {
          summary:
            "Get an environment's network map: subnets, DNS names, virtual IPs, Switch targets, domains, TCP exposures and every path",
          tags,
        },
      },
    )
    .get(
      '/services/:service/connections',
      async ({ request, params, query }) => {
        const call = await kit.call(request)
        const ctx = serviceById(db, params.service)
        const reply = await stations
          .ask(
            ctx.service.station_id,
            'network.sample',
            {
              service_ids: [ctx.service.id],
            },
            {
              capability: 'network.v1',
              timeoutMs: 10_000,
            },
          )
          .catch(stationError)
        const sample = (reply.body as MessageBody<'network.sample.result'>).samples.find(
          (s) => s.service_id === ctx.service.id,
        )
        if (!sample)
          fail(
            'NOT_FOUND',
            `The station returned no connection sample for ${ctx.service.name}.`,
            `Read the connections again; check the station with sly stations get ${ctx.service.station_id}.`,
            {
              service_id: ctx.service.id,
            },
          )
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
        operation: {
          id: 'get_connections',
          level: 'read',
          cli: {
            render: 'connections',
          },
        },
        params: t.Object({
          service: t.String(),
        }),
        query: t.Object({
          direction,
        }),
        response: replies({
          200: NetworkConnections,
        }),
        detail: {
          summary:
            'Live connections of a service grouped by peer, and refused attempts with the path that refused them; one sample',
          tags,
        },
      },
    )
    .get(
      '/environments/:environment/network/live',
      async ({ request, params, query }) => {
        const call = await kit.call(request)
        const ctx = environmentById(db, params.environment)
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
          if (missing.length)
            invalid(
              missing.map((m) => ({
                path: '/service',
                message: `no service ${m} in environment ${ctx.environment.name}`,
              })),
            )
        }
        const byStation = new Map<string, Set<string>>()
        for (const s of rows)
          byStation.set(s.station_id, new Set([...(byStation.get(s.station_id) ?? []), s.id]))
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
          if (sending) return
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
        if (!byStation.size)
          void sse.send('empty', {
            explanation: 'no running service in this environment',
          })
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
          for (const leave of leaves) leave()
        })
        return sse.response
      },
      {
        operation: {
          id: 'stream_connections',
          level: 'read',
          mcp: false,
          cli: {
            render: 'live-connections',
          },
          stream: true,
        },
        params: t.Object({
          environment: t.String(),
        }),
        query: t.Object({
          service: t.Optional(
            t.String({
              minLength: 1,
            }),
          ),
          direction,
        }),
        detail: {
          summary:
            'SSE: one connections sample per watched service every 5 s, as event network with { at, samples }',
          tags,
        },
      },
    )
    .get(
      '/environments/:environment/network/explain',
      async ({ params, query }) => {
        const ctx = environmentById(db, params.environment)
        return explainNetwork(explainSources, ctx.environment, {
          from: query.from,
          to: query.to,
          port: query.port,
          protocol: query.protocol ?? 'tcp',
        })
      },
      {
        operation: {
          id: 'explain_network',
          level: 'read',
          cli: false,
        },
        params: t.Object({
          environment: t.String(),
        }),
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
          protocol: t.Optional(t.Union([t.Literal('tcp'), t.Literal('udp')])),
        }),
        response: replies({
          200: NetworkExplanation,
        }),
        detail: {
          summary:
            'Explain why a service can or cannot reach a target, or why the internet can or cannot reach a domain or TCP exposure, hop by hop with fixes',
          tags,
        },
      },
    )
    .post(
      '/services/:service/network/probe',
      async ({ request, params, body, set }) => {
        const call = await kit.call(request)
        const ctx = serviceById(db, params.service)
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
          if (!result.applied) return kit.stagedBody(result, set)
        }
        return sendProbe(kit.deps, call, ctx.service, probe)
      },
      {
        operation: {
          id: 'probe_network',
          level: 'deploy',
          cli: {
            render: 'probe',
          },
        },
        params: t.Object({
          service: t.String(),
        }),
        body: ProbeBody,
        response: replies({
          200: NetworkProbe,
          202: Staged,
        }),
        detail: {
          summary:
            "Send one TCP handshake or one DNS query from inside the service's own namespace, under its own rules; staged for a non-human actor in a protected environment",
          tags,
        },
      },
    )
    .get(
      '/services/:service/dns-log',
      async ({ request, params, query }) => {
        const call = await kit.call(request)
        const ctx = serviceById(db, params.service)
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
              capability: 'network.v1',
              timeoutMs: 10_000,
            },
          )
          .catch(stationError)
        const entries = (reply.body as MessageBody<'dns.log.result'>).entries
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
        operation: {
          id: 'get_dns_log',
          level: 'read',
          cli: {
            render: 'dns-log',
          },
        },
        params: t.Object({
          service: t.String(),
        }),
        query: t.Object({
          tail: t.Optional(
            t.Numeric({
              minimum: 1,
              maximum: dnsLogTail.max,
            }),
          ),
          name: t.Optional(
            t.String({
              minLength: 1,
              maxLength: 253,
            }),
          ),
          rcode: t.Optional(
            t.String({
              minLength: 1,
              maxLength: 16,
            }),
          ),
        }),
        response: replies({
          200: DnsLog,
        }),
        detail: {
          summary:
            "The service's recent DNS queries from the resolver's ring, newest first, as untrusted data",
          tags,
        },
      },
    )
}
