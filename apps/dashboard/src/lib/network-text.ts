import type { Connections, Explanation, NetworkMap } from './api.ts'
import { blank, plural, span, stamp } from './format.ts'
import {
  domainLive,
  domainStatus,
  hiddenHopFacts,
  hopFact,
  hop as hopLabel,
  path as pathLabel,
  peerKind,
  routeResult,
  routing,
  type Status,
} from './labels.ts'
import type { Tone } from './tone.ts'

type MapService = NetworkMap['services'][number]
type MapDomain = MapService['domains'][number]
type MapExposure = MapService['exposures'][number]
type Peer = Connections['connections'][number]['peer']
type Hop = Explanation['hops'][number]

export type Serving = { label: string; tone: Tone | null; hint: string | null }

export const protocolText = (protocol: string) =>
  protocol === 'grpc' ? 'gRPC' : protocol.toUpperCase()

export const endpointText = (endpoint: { address: string; port: number; protocol: string }) =>
  `${endpoint.address}:${endpoint.port} ${protocolText(endpoint.protocol)}`

export const portText = (port: number, protocol: string) => `${port} ${protocolText(protocol)}`

export const portSpecText = (port: { port: number; protocol: string; grpc: boolean }) =>
  portText(port.port, port.grpc ? 'grpc' : port.protocol)

const rateUnits = ['B/s', 'kB/s', 'MB/s', 'GB/s']

export const rateText = (bps: number | null) => {
  if (bps === null) return blank
  let value = bps
  let unit = 0
  while (value >= 1000 && unit < rateUnits.length - 1) {
    value /= 1000
    unit += 1
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${rateUnits[unit]}`
}

export const ageText = (seconds: number | null) => (seconds === null ? blank : span(seconds))

export const peerText = (peer: Peer) => {
  if (peer.kind === 'service') return peer.service ?? peer.service_id ?? peerKind.service
  if (peer.kind === 'sandbox') return peer.sandbox ?? peer.sandbox_id ?? peerKind.sandbox
  if (peer.kind === 'public' && peer.address) return peer.address
  if (peer.address) return `${peerKind[peer.kind]} ${peer.address}`
  return peerKind[peer.kind]
}

export const deploymentText = (number: number) => `Deployment #${number}`

export const servingText = (service: Pick<MapService, 'name' | 'switch'>): Serving => {
  const { state, deployment } = service.switch
  if (state === 'serving')
    return {
      label: deployment ? deploymentText(deployment.number) : routing.serving.label,
      tone: null,
      hint: deployment?.address ?? null,
    }
  if (state === 'pending')
    return {
      label: `${routing.pending.label} to ${deployment ? `#${deployment.number}` : 'a new deployment'}`,
      tone: routing.pending.tone,
      hint: null,
    }
  if (state === 'mismatch')
    return {
      label: routing.mismatch.label,
      tone: routing.mismatch.tone,
      hint: `Traffic still goes to an old container. Redeploy ${service.name} or wait for the station to catch up.`,
    }
  return {
    label: `${routing.no_target.label}. Calls to ${service.name} are refused.`,
    tone: routing.no_target.tone,
    hint: null,
  }
}

export const drainingText = (sw: MapService['switch']) =>
  sw.draining ? `#${sw.draining.number} finishing open connections` : null

export const domainState = (
  domain: Pick<MapDomain, 'status' | 'certificate' | 'route'>,
): Status => {
  if (domain.status === 'error') return domainStatus.error
  if (domain.certificate.status !== 'valid') return domainStatus.pending
  if (domain.route.result !== 'ok') return routeResult[domain.route.result ?? 'pending']
  return domainLive
}

export const exposureState = (exposure: Pick<MapExposure, 'result'> | undefined) =>
  routeResult[exposure?.result ?? 'pending']

export const stationName = (map: Pick<NetworkMap, 'subnets'>, id: string) =>
  map.subnets.find((s) => s.station.id === id)?.station.name ?? 'the station'

export const exposureText = (map: Pick<NetworkMap, 'subnets'>, exposure: MapExposure) =>
  exposure.public
    ? `${exposure.public} to port ${exposure.port}`
    : `Port ${exposure.host_port} on ${stationName(map, exposure.station_id)} (no public address)`

export const blockedText = (count: number) =>
  `Blocked ${count === 1 ? 'once' : plural(count, 'time')}`

const isEndpoint = (item: unknown): item is { address: string; port: number; protocol: string } =>
  typeof item === 'object' && item !== null && 'address' in item && 'port' in item

const factValue = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return String(value)
  if (Array.isArray(value))
    return value.map((item) => (isEndpoint(item) ? endpointText(item) : factValue(item))).join(', ')
  return Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => `${k.replaceAll('_', ' ')} ${factValue(v)}`)
    .join(', ')
}

const isPath = (value: unknown): value is keyof typeof pathLabel =>
  typeof value === 'string' && Object.hasOwn(pathLabel, value)

const factText = (key: string, value: unknown) => {
  if (key === 'deployment') return deploymentText(Number(value))
  if (key === 'path' && isPath(value)) return `rule “${pathLabel[value]}”`
  if (key === 'listening' && Array.isArray(value) && value.length === 0)
    return 'listening on nothing'
  const name = hopFact[key] ?? key.replaceAll('_', ' ')
  const text = key.endsWith('_at') && typeof value === 'string' ? stamp(value) : factValue(value)
  return name ? `${name} ${text}` : text
}

export const hopDetail = (detail: Record<string, unknown>) =>
  Object.entries(detail)
    .filter(([k, v]) => v !== null && v !== undefined && !hiddenHopFacts.has(k))
    .map(([k, v]) => factText(k, v))
    .join(' · ')

const hostOf = (target: string) => target.split(':')[0] ?? target

export const stepText = (hop: Hop['hop'], entity: Pick<Explanation['entity'], 'from' | 'to'>) => {
  if (hop === 'source') return `${entity.from} is running`
  if (hop === 'target') return `${hostOf(entity.to)} is running and healthy`
  if (hop === 'listening') return `${hostOf(entity.to)} listens on the port`
  return hopLabel[hop]
}
