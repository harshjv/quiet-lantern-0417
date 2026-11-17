import type { Static } from '@sinclair/typebox'
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm'

import { bridgeName, type Observed } from '@stationly/protocol'

import { notFound } from '../api/errors.ts'
import type { TargetRow } from '../api/lookup.ts'
import type { NetworkMap } from '../api/shapes.ts'
import type { Db } from '../db/client.ts'
import {
  app,
  app_port,
  deployment,
  deployment_step,
  domain,
  ipam_allocation,
  machine,
  port_allocation,
  server,
  virtual_ip,
} from '../db/schema.ts'
import { readSetting } from '../db/settings.ts'
import { generationNumbered } from '../station/generations.ts'

import type { NetworkFinding } from './findings.ts'
import { environmentPaths } from './paths.ts'

type MapDoc = Static<typeof NetworkMap>
type AppEntry = MapDoc['apps'][number]
type Switch = AppEntry['switch']
type Warning = MapDoc['warnings'][number]
type Edge = { from_app: string; to_app: string; keys: string[] }

export type NetworkSources = {
  db: Db
  observedOf: (stationId: string) => Observed | undefined
  isConnected: (stationId: string) => boolean
  edgesOf: (targetId: string) => Edge[]
}

export type NetworkOptions = { app?: string; rules: boolean; bridges: boolean; now?: Date }

const staleAfterMs = 60_000

const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null)

const longRunning = new Set(['web', 'worker'])

const finding = (
  code: NetworkFinding,
  explanation: string,
  details?: Record<string, unknown>,
): Warning => ({
  code,
  explanation,
  ...(details
    ? {
        details,
      }
    : {}),
})

const text = (value: unknown) => (typeof value === 'string' && value ? value : null)

export const networkMap = (
  sources: NetworkSources,
  env: TargetRow,
  options: NetworkOptions,
): MapDoc => {
  const { db } = sources
  const now = options.now ?? new Date()
  const apps = db.select().from(app).where(eq(app.target_id, env.id)).orderBy(asc(app.name)).all()
  const ids = apps.map((s) => s.id)
  const allocations = db
    .select()
    .from(ipam_allocation)
    .where(eq(ipam_allocation.target_id, env.id))
    .orderBy(asc(ipam_allocation.subnet))
    .all()
  const stationIds = [
    ...new Set([...allocations.map((a) => a.server_id), ...apps.map((s) => s.server_id)]),
  ]
  const stations = new Map(
    (stationIds.length
      ? db.select().from(server).where(inArray(server.id, stationIds)).all()
      : []
    ).map((s) => [s.id, s]),
  )
  const vips = new Map(
    db
      .select()
      .from(virtual_ip)
      .where(eq(virtual_ip.target_id, env.id))
      .all()
      .filter((v) => v.app_id)
      .map((v) => [v.app_id!, v.address]),
  )
  const ports = ids.length
    ? db
        .select()
        .from(app_port)
        .where(inArray(app_port.app_id, ids))
        .orderBy(asc(app_port.port))
        .all()
    : []
  const portById = new Map(ports.map((p) => [p.id, p]))
  const portIds = ports.map((p) => p.id)
  const domains = portIds.length
    ? db
        .select()
        .from(domain)
        .where(inArray(domain.app_port_id, portIds))
        .orderBy(asc(domain.hostname))
        .all()
    : []
  const exposures = portIds.length
    ? db
        .select()
        .from(port_allocation)
        .where(
          and(inArray(port_allocation.app_port_id, portIds), eq(port_allocation.status, 'active')),
        )
        .orderBy(asc(port_allocation.host_port))
        .all()
    : []
  const deployments = ids.length
    ? db
        .select()
        .from(deployment)
        .where(inArray(deployment.app_id, ids))
        .orderBy(desc(deployment.number))
        .all()
    : []
  const deploymentById = new Map(deployments.map((d) => [d.id, d]))
  const draining = new Map(
    deployments.filter((d) => d.status === 'draining').map((d) => [d.app_id, d]),
  )
  const cutovers = new Map(
    (draining.size
      ? db
          .select()
          .from(deployment_step)
          .where(
            and(
              inArray(
                deployment_step.deployment_id,
                [...draining.values()].map((d) => d.id),
              ),
              eq(deployment_step.step, 'cutover'),
              eq(deployment_step.status, 'done'),
            ),
          )
          .orderBy(desc(deployment_step.attempt))
          .all()
      : []
    ).map((step) => [step.deployment_id, step]),
  )

  const observed = new Map(stationIds.map((id) => [id, sources.observedOf(id)]))
  const applied = new Map(
    stationIds.map((id) => {
      const number = stations.get(id)?.generation ?? 0

      return [id, number ? generationNumbered(db, id, number)?.document : undefined]
    }),
  )
  const staleStation = (id: string) => {
    const st = stations.get(id)
    const seen = st?.last_seen_at?.getTime() ?? 0

    return !sources.isConnected(id) || !observed.get(id) || now.getTime() - seen > staleAfterMs
  }

  const warnings: Warning[] = []

  const switchOf = (svc: (typeof apps)[number]): Switch => {
    const green = draining.get(svc.id)
    const current = svc.current_deployment_id
      ? deploymentById.get(svc.current_deployment_id)
      : undefined

    if (!longRunning.has(svc.kind) || svc.desired_state !== 'running' || (!current && !green)) {
      return {
        state: 'no_target',
        deployment: null,
        draining: null,
      }
    }

    const report = observed.get(svc.server_id)
    const seen = report?.services[svc.id]
    const switchAddress = seen?.switch_address ?? null

    if (green) {
      const cutover = cutovers.get(green.id)
      const to = text(cutover?.detail.to) ?? null
      const from = text(cutover?.detail.from) ?? null
      const target = {
        id: green.id,
        number: green.number,
        address: to,
      }
      const blue =
        current && current.id !== green.id
          ? {
              id: current.id,
              number: current.number,
              address: from,
              since: iso(cutover?.finished_at),
            }
          : null
      const reportedBeforeCutover =
        !report ||
        !cutover?.finished_at ||
        Date.parse(report.observed_at) < cutover.finished_at.getTime()

      if (!switchAddress || !to || reportedBeforeCutover) {
        return {
          state: 'pending',
          deployment: target,
          draining: blue,
        }
      }

      return {
        state: switchAddress === to ? 'serving' : 'mismatch',
        deployment: target,
        draining: blue,
      }
    }

    const containers = (seen?.containers ?? []).filter(
      (c) => c.deployment_id === current!.id && c.address,
    )
    const address =
      containers.find((c) => c.role === 'coupler')?.address ?? containers[0]?.address ?? null
    const target = {
      id: current!.id,
      number: current!.number,
      address,
    }
    const named =
      applied.get(svc.server_id)?.services[svc.id]?.current?.deployment_id === current!.id

    if (!report || !seen || !switchAddress || !named) {
      return {
        state: 'pending',
        deployment: target,
        draining: null,
      }
    }

    return {
      state: containers.some((c) => c.address === switchAddress) ? 'serving' : 'mismatch',
      deployment: target,
      draining: null,
    }
  }

  const entries: AppEntry[] = apps.map((svc) => {
    const report = observed.get(svc.server_id)
    const sw = switchOf(svc)
    const vip = vips.get(svc.id) ?? null
    const st = stations.get(svc.server_id)

    if (sw.state === 'mismatch') {
      warnings.push(
        finding(
          'SWITCH_MISMATCH',
          `${svc.name}'s Switch entry points at ${report?.services[svc.id]?.switch_address}, which no container of deployment #${sw.deployment?.number} holds.`,
          {
            app: svc.name,
            observed: report?.services[svc.id]?.switch_address ?? null,
            expected: sw.deployment?.address ?? null,
          },
        ),
      )
    }

    if (sw.state === 'pending') {
      warnings.push(
        finding(
          'SWITCH_PENDING',
          `The server has not reported a Switch target for ${svc.name}'s deployment #${sw.deployment?.number} yet.`,
          {
            app: svc.name,
          },
        ),
      )
    }

    if (sw.state === 'no_target' && longRunning.has(svc.kind) && svc.status !== 'not_deployed') {
      warnings.push(
        finding(
          'SWITCH_NO_TARGET',
          `${svc.name} has no running deployment, so connections to ${vip ?? 'its virtual IP'} are rejected.`,
          {
            app: svc.name,
          },
        ),
      )
    }

    const appPorts = ports.filter((p) => p.app_id === svc.id)
    const appDomains = domains
      .filter((d) => portById.get(d.app_port_id)?.app_id === svc.id)
      .map((d) => {
        const port = portById.get(d.app_port_id)!
        const result = report?.gateway.routes[d.id]?.result ?? null
        const certificate = {
          status: d.certificate?.status ?? 'pending',
          expires_at: d.certificate?.expires_at ?? null,
        }

        if (d.status !== 'active') {
          warnings.push(
            finding('DOMAIN_NOT_ACTIVE', `${d.hostname} is ${d.status}.`, {
              app: svc.name,
              domain: d.id,
              hostname: d.hostname,
              status: d.status,
              error: d.error ?? null,
            }),
          )
        }

        if (d.ingress === 'direct' && certificate.status !== 'valid') {
          warnings.push(
            finding(
              'CERTIFICATE_NOT_VALID',
              `${d.hostname} has no valid certificate (status ${certificate.status}).`,
              {
                app: svc.name,
                domain: d.id,
                hostname: d.hostname,
                certificate: certificate.status,
              },
            ),
          )
        }

        if (result === 'failed' || result === 'blocked') {
          warnings.push(
            finding(
              'ROUTE_NOT_APPLIED',
              `The Gateway route for ${d.hostname} is ${result} on the server.`,
              {
                app: svc.name,
                domain: d.id,
                hostname: d.hostname,
                result,
              },
            ),
          )
        }

        return {
          id: d.id,
          app_port_id: d.app_port_id,
          hostname: d.hostname,
          kind: d.kind,
          ingress: d.ingress,
          status: d.status,
          certificate,
          port: port.port,
          route: {
            entrypoint: d.ingress === 'direct' ? ('websecure' as const) : ('web' as const),
            target: vip ? `${vip}:${port.port}` : null,
            result,
          },
        }
      })
    const appExposures = exposures
      .filter((a) => portById.get(a.app_port_id)?.app_id === svc.id)
      .map((a) => {
        const port = portById.get(a.app_port_id)!
        const publicAddress = stations.get(a.server_id)?.public_address ?? null
        const address = publicAddress ? `${publicAddress}:${a.host_port}` : null
        const result = observed.get(a.server_id)?.port_allocations[a.id]?.result ?? null

        if (result === 'failed' || result === 'blocked') {
          warnings.push(
            finding(
              'ROUTE_NOT_APPLIED',
              `The TCP exposure on host port ${a.host_port} is ${result} on the server.`,
              {
                app: svc.name,
                port_allocation: a.id,
                host_port: a.host_port,
                result,
              },
            ),
          )
        }

        return {
          id: a.id,
          app_port_id: a.app_port_id,
          server_id: a.server_id,
          host_port: a.host_port,
          status: a.status,
          address,
          public: address,
          port: port.port,
          result,
        }
      })

    if (
      !st?.public_address &&
      (appExposures.length || appDomains.some((d) => d.ingress === 'direct'))
    ) {
      warnings.push(
        finding(
          'NO_PUBLIC_ADDRESS',
          `Server ${st?.name ?? svc.server_id} has no public address, so ${svc.name}'s direct domains and TCP exposures cannot be reached.`,
          {
            app: svc.name,
            server: svc.server_id,
          },
        ),
      )
    }

    return {
      id: svc.id,
      name: svc.name,
      kind: svc.kind,
      status: svc.status,
      server_id: svc.server_id,
      dns: `${svc.name}.internal`,
      virtual_ip: vip,
      ports: appPorts.map((p) => ({
        port: p.port,
        protocol: p.protocol,
        grpc: p.grpc,
      })),
      switch: sw,
      domains: appDomains,
      exposures: appExposures,
    }
  })

  const nameOf = new Map(apps.map((s) => [s.id, s.name]))
  const edges = sources
    .edgesOf(env.id)
    .map((e) => ({
      from: nameOf.get(e.from_app)!,
      to: nameOf.get(e.to_app)!,
      kind: 'reference' as const,
      keys: e.keys,
    }))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))

  const subnets = allocations.map((a) => {
    const st = stations.get(a.server_id)
    const stale = staleStation(a.server_id)

    return {
      server: {
        id: a.server_id,
        name: st?.name ?? a.server_id,
      },
      subnet: a.subnet,
      gateway: a.gateway,
      resolver: `${a.gateway}:53`,
      ...(options.bridges
        ? {
            bridge: bridgeName(env.id),
          }
        : {}),
      observed_at: observed.get(a.server_id)?.observed_at ?? null,
      stale,
    }
  })

  for (const id of stationIds.filter(staleStation)) {
    const report = observed.get(id)
    const name = stations.get(id)?.name ?? id
    const why = !sources.isConnected(id)
      ? 'is not connected'
      : report
        ? 'has not reported for more than 60 s'
        : 'has sent no observed report since Dispatch started'

    warnings.push(
      finding(
        'SERVER_STALE',
        `Server ${name} ${why}${report ? ` (last report ${report.observed_at})` : ''}; live facts are missing.`,
        {
          server: id,
          observed_at: report?.observed_at ?? null,
          last_seen_at: iso(stations.get(id)?.last_seen_at),
        },
      ),
    )
  }

  const inboundStations = subnets.map((s) => s.server.id)
  const webPorts = inboundStations.some(
    (id) => applied.get(id)?.station.inbound.web_ports === 'open',
  )
    ? ('open' as const)
    : ('closed' as const)

  if (webPorts === 'closed' && entries.some((s) => s.domains.some((d) => d.ingress === 'direct'))) {
    warnings.push(
      finding(
        'WEB_PORTS_CLOSED',
        'The server has not applied a generation with a direct route, so inbound 80 and 443 are dropped.',
        {
          servers: inboundStations,
        },
      ),
    )
  }

  const inbound = {
    web_ports: webPorts,
    public_address:
      inboundStations.map((id) => stations.get(id)?.public_address ?? null).find((a) => a) ?? null,
    entries: entries.flatMap((s) => [
      ...s.domains.map((d) => ({
        kind: 'domain' as const,
        hostname: d.hostname,
        app: s.name,
        port: d.port,
      })),
      ...s.exposures.map((x) => ({
        kind: 'tcp' as const,
        public: x.public,
        app: s.name,
        port: x.port,
      })),
    ]),
  }

  const joined = db
    .select()
    .from(machine)
    .where(
      and(
        eq(machine.target_id, env.id),
        eq(machine.network, 'environment'),
        ne(machine.status, 'deleting'),
      ),
    )
    .orderBy(asc(machine.name))
    .all()
  const machines = joined.map((b) => ({
    id: b.id,
    name: b.name,
    status: b.status,
    server_id: b.server_id,
    address: b.address,
    egress: b.egress,
  }))
  const paths = environmentPaths(
    {
      subnets: allocations.map((a) => a.subnet),
      resolvers: allocations.map((a) => a.gateway),
    },
    {
      inbound: joined.length > 0,
      allowlist: joined.some((b) => b.egress.mode === 'allowlist'),
    },
  ).map(({ rule, ...p }) =>
    options.rules
      ? {
          ...p,
          rule,
        }
      : p,
  )

  const map: MapDoc = {
    project_id: env.project_id,
    preview:
      env.kind === 'preview'
        ? {
            id: env.id,
            name: env.name,
          }
        : null,
    computed_at: now.toISOString(),
    virtual_prefix: readSetting(db, 'ipam.virtual_prefix'),
    subnets,
    apps: entries,
    machines,
    edges,
    inbound,
    paths,
    warnings,
  }

  if (!options.app) {
    return map
  }

  const focus =
    apps.find((s) => s.id === options.app || s.name === options.app) ?? notFound('app', options.app)
  const touching = edges.filter((e) => e.from === focus.name || e.to === focus.name)
  const kept = new Set([focus.name, ...touching.flatMap((e) => [e.from, e.to])])

  return {
    ...map,
    apps: entries.filter((s) => kept.has(s.name)),
    edges: touching,
    inbound: {
      ...map.inbound,
      entries: inbound.entries.filter((e) => e.app === focus.name),
    },
    warnings: warnings.filter((w) => typeof w.details?.app !== 'string' || kept.has(w.details.app)),
  }
}
