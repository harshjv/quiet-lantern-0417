import type { NetworkMap } from './api.ts'
import { blank } from './format.ts'
import { domainStatus, routeResult, type Status } from './labels.ts'

type MapDomain = NetworkMap['apps'][number]['domains'][number]

const protocolText = (protocol: string) => (protocol === 'grpc' ? 'gRPC' : protocol.toUpperCase())

export const endpointText = (endpoint: { address: string; port: number; protocol: string }) =>
  `${endpoint.address}:${endpoint.port} ${protocolText(endpoint.protocol)}`

const rateUnits = ['B/s', 'kB/s', 'MB/s', 'GB/s']

export const rateText = (bps: number | null) => {
  if (bps === null) {
    return blank
  }

  let value = bps
  let unit = 0

  while (value >= 1000 && unit < rateUnits.length - 1) {
    value /= 1000
    unit += 1
  }

  return `${unit === 0 ? value : value.toFixed(1)} ${rateUnits[unit]}`
}

export const domainState = (domain: Pick<MapDomain, 'status' | 'route'>): Status => {
  if (domain.status === 'error') {
    return domainStatus.error
  }

  if (domain.status === 'pending') {
    return domainStatus.pending
  }

  if (domain.route.result !== 'ok') {
    return routeResult[domain.route.result ?? 'pending']
  }

  return domainStatus.active
}
