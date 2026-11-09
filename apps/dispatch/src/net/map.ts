import type { Observed } from '@stationly/protocol'
import type { Static } from '@sinclair/typebox'
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm'
import type { Db } from '../db/client.ts'
import { deployment, deployment_step, domain, ipam_allocation, port_allocation, sandbox, service, service_port, station, virtual_ip } from '../db/schema.ts'
import { bridgeName } from '../generation/build.ts'
import { readSetting } from '../api/settings.ts'
import { notFound } from '../api/errors.ts'
import type { EnvironmentRow } from '../api/lookup.ts'
import type { NetworkMap } from '../api/shapes.ts'
import { generationNumbered } from '../station/generations.ts'
import type { NetworkFinding } from './findings.ts'
import { environmentPaths } from './paths.ts'

type MapDoc = Static<typeof NetworkMap>
type ServiceEntry = MapDoc['services'][number]
type Switch = ServiceEntry['switch']
type Warning = MapDoc['warnings'][number]
type Edge = { from_service: string; to_service: string; keys: string[] }

export type NetworkSources = {
  db: Db
  observedOf: (stationId: string) => Observed | undefined
  isConnected: (stationId: string) => boolean
  edgesOf: (environmentId: string) => Edge[]
}

export type NetworkOptions = { service?: string; rules: boolean; bridges: boolean; now?: Date }

const staleAfterMs = 60_000

const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null)

const longRunning = new Set(['web', 'worker'])

const finding = (code: NetworkFinding, explanation: string, details?: Record<string, unknown>): Warning => ({ code, explanation, ...(details ? { details } : {}) })

const text = (value: unknown) => (typeof value === 'string' && value ? value : null)

export const networkMap = (sources: NetworkSources, env: EnvironmentRow, options: NetworkOptions): MapDoc => {
  const { db } = sources
  const now = options.now ?? new Date()
  const services = db.select().from(service).where(eq(service.environment_id, env.id)).orderBy(asc(service.name)).all()
  const ids = services.map(s => s.id)
  const allocations = db.select().from(ipam_allocation).where(eq(ipam_allocation.environment_id, env.id)).orderBy(asc(ipam_allocation.subnet)).all()
  const stationIds = [...new Set([...allocations.map(a => a.station_id), ...services.map(s => s.station_id)])]
  const stations = new Map((stationIds.length ? db.select().from(station).where(inArray(station.id, stationIds)).all() : []).map(s => [s.id, s]))
  const vips = new Map(
    db
      .select()
      .from(virtual_ip)
      .where(eq(virtual_ip.environment_id, env.id))
      .all()
      .filter(v => v.service_id)
      .map(v => [v.service_id!, v.address])
  )
  const ports = ids.length ? db.select().from(service_port).where(inArray(service_port.service_id, ids)).orderBy(asc(service_port.port)).all() : []
  const portById = new Map(ports.map(p => [p.id, p]))
  const portIds = ports.map(p => p.id)
  const domains = portIds.length ? db.select().from(domain).where(inArray(domain.service_port_id, portIds)).orderBy(asc(domain.hostname)).all() : []
  const exposures = portIds.length
    ? db.select().from(port_allocation).where(and(inArray(port_allocation.service_port_id, portIds), eq(port_allocation.status, 'active'))).orderBy(asc(port_allocation.host_port)).all()
    : []
  const deployments = ids.length ? db.select().from(deployment).where(inArray(deployment.service_id, ids)).orderBy(desc(deployment.number)).all() : []
  const deploymentById = new Map(deployments.map(d => [d.id, d]))
  const draining = new Map(deployments.filter(d => d.status === 'draining').map(d => [d.service_id, d]))
  const cutovers = new Map(
    (draining.size
      ? db
          .select()
          .from(deployment_step)
          .where(and(inArray(deployment_step.deployment_id, [...draining.values()].map(d => d.id)), eq(deployment_step.step, 'cutover'), eq(deployment_step.status, 'done')))
          .orderBy(desc(deployment_step.attempt))
          .all()
      : []
    ).map(step => [step.deployment_id, step])
  )

  const observed = new Map(stationIds.map(id => [id, sources.observedOf(id)]))
  const applied = new Map(
    stationIds.map(id => {
      const number = stations.get(id)?.generation ?? 0
      return [id, number ? generationNumbered(db, id, number)?.document : undefined]
    })
  )
  const staleStation = (id: string) => {
    const st = stations.get(id)
    const seen = st?.last_seen_at?.getTime() ?? 0
    return !sources.isConnected(id) || !observed.get(id) || now.getTime() - seen > staleAfterMs
  }

  const warnings: Warning[] = []

  const switchOf = (svc: (typeof services)[number]): Switch => {
    const green = draining.get(svc.id)
    const current = svc.current_deployment_id ? deploymentById.get(svc.current_deployment_id) : undefined
    if (!longRunning.has(svc.kind) || svc.desired_state !== 'running' || (!current && !green)) return { state: 'no_target', deployment: null, draining: null }
    const report = observed.get(svc.station_id)
    const seen = report?.services[svc.id]
    const switchAddress = seen?.switch_address ?? null
    if (green) {
      const cutover = cutovers.get(green.id)
      const to = text(cutover?.detail.to) ?? null
      const from = text(cutover?.detail.from) ?? null
      const target = { id: green.id, number: green.number, address: to }
      const blue = current && current.id !== green.id ? { id: current.id, number: current.number, address: from, since: iso(cutover?.finished_at) } : null
      const reportedBeforeCutover = !report || !cutover?.finished_at || Date.parse(report.observed_at) < cutover.finished_at.getTime()
      if (!switchAddress || !to || reportedBeforeCutover) return { state: 'pending', deployment: target, draining: blue }
      return { state: switchAddress === to ? 'serving' : 'mismatch', deployment: target, draining: blue }
    }
    const containers = (seen?.containers ?? []).filter(c => c.deployment_id === current!.id && c.address)
    const address = containers.find(c => c.role === 'coupler')?.address ?? containers[0]?.address ?? null
    const target = { id: current!.id, number: current!.number, address }
    const named = applied.get(svc.station_id)?.services[svc.id]?.current?.deployment_id === current!.id
    if (!report || !seen || !switchAddress || !named) return { state: 'pending', deployment: target, draining: null }
    return { state: containers.some(c => c.address === switchAddress) ? 'serving' : 'mismatch', deployment: target, draining: null }
  }

  const entries: ServiceEntry[] = services.map(svc => {
    const report = observed.get(svc.station_id)
    const sw = switchOf(svc)
    const vip = vips.get(svc.id) ?? null
    const st = stations.get(svc.station_id)
    if (sw.state === 'mismatch')
      warnings.push(finding('SWITCH_MISMATCH', `${svc.name}'s Switch entry points at ${report?.services[svc.id]?.switch_address}, which no container of deployment #${sw.deployment?.number} holds.`, { service: svc.name, observed: report?.services[svc.id]?.switch_address ?? null, expected: sw.deployment?.address ?? null }))
    if (sw.state === 'pending') warnings.push(finding('SWITCH_PENDING', `The station has not reported a Switch target for ${svc.name}'s deployment #${sw.deployment?.number} yet.`, { service: svc.name }))
    if (sw.state === 'no_target' && longRunning.has(svc.kind))
      warnings.push(finding('SWITCH_NO_TARGET', `${svc.name} has no running deployment, so connections to ${vip ?? 'its virtual IP'} are rejected.`, { service: svc.name }))
    const servicePorts = ports.filter(p => p.service_id === svc.id)
    const serviceDomains = domains
      .filter(d => portById.get(d.service_port_id)?.service_id === svc.id)
      .map(d => {
        const port = portById.get(d.service_port_id)!
        const result = report?.gateway.routes[d.id]?.result ?? null
        const certificate = { status: d.certificate?.status ?? 'pending', expires_at: d.certificate?.expires_at ?? null }
        if (d.status !== 'active') warnings.push(finding('DOMAIN_NOT_ACTIVE', `${d.hostname} is ${d.status}.`, { service: svc.name, domain: d.id, hostname: d.hostname, status: d.status, error: d.error ?? null }))
        if (d.ingress === 'direct' && certificate.status !== 'valid')
          warnings.push(finding('CERTIFICATE_NOT_VALID', `${d.hostname} has no valid certificate (status ${certificate.status}).`, { service: svc.name, domain: d.id, hostname: d.hostname, certificate: certificate.status }))
        if (result === 'failed' || result === 'blocked') warnings.push(finding('ROUTE_NOT_APPLIED', `The Gateway route for ${d.hostname} is ${result} on the station.`, { service: svc.name, domain: d.id, hostname: d.hostname, result }))
        return {
          id: d.id,
          service_port_id: d.service_port_id,
          hostname: d.hostname,
          kind: d.kind,
          ingress: d.ingress,
          status: d.status,
          certificate,
          port: port.port,
          route: { entrypoint: d.ingress === 'direct' ? ('websecure' as const) : ('web' as const), target: vip ? `${vip}:${port.port}` : null, result }
        }
      })
    const serviceExposures = exposures
      .filter(a => portById.get(a.service_port_id)?.service_id === svc.id)
      .map(a => {
        const port = portById.get(a.service_port_id)!
        const publicAddress = stations.get(a.station_id)?.public_address ?? null
        const address = publicAddress ? `${publicAddress}:${a.host_port}` : null
        const result = observed.get(a.station_id)?.port_allocations[a.id]?.result ?? null
        if (result === 'failed' || result === 'blocked') warnings.push(finding('ROUTE_NOT_APPLIED', `The TCP exposure on host port ${a.host_port} is ${result} on the station.`, { service: svc.name, port_allocation: a.id, host_port: a.host_port, result }))
        return { id: a.id, service_port_id: a.service_port_id, station_id: a.station_id, host_port: a.host_port, status: a.status, address, public: address, port: port.port, result }
      })
    if (!st?.public_address && (serviceExposures.length || serviceDomains.some(d => d.ingress === 'direct')))
      warnings.push(finding('NO_PUBLIC_ADDRESS', `Station ${st?.name ?? svc.station_id} has no public address, so ${svc.name}'s direct domains and TCP exposures cannot be reached.`, { service: svc.name, station: svc.station_id }))
    return {
      id: svc.id,
      name: svc.name,
      kind: svc.kind,
      status: svc.status,
      station_id: svc.station_id,
      dns: `${svc.name}.internal`,
      virtual_ip: vip,
      ports: servicePorts.map(p => ({ port: p.port, protocol: p.protocol, grpc: p.grpc })),
      switch: sw,
      domains: serviceDomains,
      exposures: serviceExposures
    }
  })

  const nameOf = new Map(services.map(s => [s.id, s.name]))
  const edges = sources
    .edgesOf(env.id)
    .map(e => ({ from: nameOf.get(e.from_service)!, to: nameOf.get(e.to_service)!, kind: 'reference' as const, keys: e.keys }))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))

  const subnets = allocations.map(a => {
    const st = stations.get(a.station_id)
    const stale = staleStation(a.station_id)
    return {
      station: { id: a.station_id, name: st?.name ?? a.station_id },
      subnet: a.subnet,
      gateway: a.gateway,
      resolver: `${a.gateway}:53`,
      ...(options.bridges ? { bridge: bridgeName(env.id) } : {}),
      observed_at: observed.get(a.station_id)?.observed_at ?? null,
      stale
    }
  })
  for (const id of stationIds.filter(staleStation)) {
    const report = observed.get(id)
    const name = stations.get(id)?.name ?? id
    const why = !sources.isConnected(id) ? 'is not connected' : report ? 'has not reported for more than 60 s' : 'has sent no observed report since Dispatch started'
    warnings.push(
      finding('STATION_STALE', `Station ${name} ${why}${report ? ` (last report ${report.observed_at})` : ''}; live facts are missing.`, {
        station: id,
        observed_at: report?.observed_at ?? null,
        last_seen_at: iso(stations.get(id)?.last_seen_at)
      })
    )
  }

  const inboundStations = subnets.map(s => s.station.id)
  const webPorts = inboundStations.some(id => applied.get(id)?.station.inbound.web_ports === 'open') ? ('open' as const) : ('closed' as const)
  if (webPorts === 'closed' && entries.some(s => s.domains.some(d => d.ingress === 'direct')))
    warnings.push(finding('WEB_PORTS_CLOSED', 'The station has not applied a generation with a direct route, so inbound 80 and 443 are dropped.', { stations: inboundStations }))
  const inbound = {
    web_ports: webPorts,
    public_address: inboundStations.map(id => stations.get(id)?.public_address ?? null).find(a => a) ?? null,
    entries: entries.flatMap(s => [
      ...s.domains.map(d => ({ kind: 'domain' as const, hostname: d.hostname, service: s.name, port: d.port })),
      ...s.exposures.map(x => ({ kind: 'tcp' as const, public: x.public, service: s.name, port: x.port }))
    ])
  }

  const joined = db
    .select()
    .from(sandbox)
    .where(and(eq(sandbox.environment_id, env.id), eq(sandbox.network, 'environment'), ne(sandbox.status, 'deleting')))
    .orderBy(asc(sandbox.name))
    .all()
  const sandboxes = joined.map(b => ({ id: b.id, name: b.name, status: b.status, station_id: b.station_id, address: b.address, egress: b.egress }))
  const paths = environmentPaths(
    { subnets: allocations.map(a => a.subnet), resolvers: allocations.map(a => a.gateway) },
    { inbound: joined.length > 0, allowlist: joined.some(b => b.egress.mode === 'allowlist') }
  ).map(({ rule, ...p }) => (options.rules ? { ...p, rule } : p))

  const map: MapDoc = {
    environment: { id: env.id, name: env.name, project_id: env.project_id },
    computed_at: now.toISOString(),
    virtual_prefix: readSetting<string>(db, 'ipam.virtual_prefix') ?? '100.64.0.0/16',
    subnets,
    services: entries,
    sandboxes,
    edges,
    inbound,
    paths,
    warnings
  }
  if (!options.service) return map
  const focus = services.find(s => s.id === options.service || s.name === options.service) ?? notFound('service', options.service)
  const touching = edges.filter(e => e.from === focus.name || e.to === focus.name)
  const kept = new Set([focus.name, ...touching.flatMap(e => [e.from, e.to])])
  return {
    ...map,
    services: entries.filter(s => kept.has(s.name)),
    edges: touching,
    inbound: { ...map.inbound, entries: inbound.entries.filter(e => e.service === focus.name) },
    warnings: warnings.filter(w => typeof w.details?.service !== 'string' || kept.has(w.details.service))
  }
}
