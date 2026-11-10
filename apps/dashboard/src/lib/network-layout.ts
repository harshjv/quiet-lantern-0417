import { MarkerType, type Edge, type Node } from '@xyflow/react'

import type { Connections, NetworkMap } from './api'

export type MapService = NetworkMap['services'][number]
export type MapEntry = NetworkMap['inbound']['entries'][number]

export type InternetData = { label: string }
export type EntryData = { entry: MapEntry; status: string | null }
export type ServiceData = { service: MapService }

export type PeerData = {
  label: string
  tone: 'live' | 'blocked'
  icon: 'internet' | 'gateway' | 'station' | 'blocked'
  side: 'left' | 'right'
  lines: string[]
}

export type MapNode =
  | Node<InternetData, 'internet'>
  | Node<EntryData, 'entry'>
  | Node<ServiceData, 'service'>
  | Node<PeerData, 'peer'>

const columnWidth = 360
const rowHeight = {
  internet: 80,
  entry: 64,
  service: 184,
} as const

export const entryKey = (entry: MapEntry) =>
  entry.kind === 'domain'
    ? `domain:${entry.hostname}`
    : `tcp:${entry.public ?? entry.service}:${entry.port}`

const serviceLayers = (map: NetworkMap) => {
  const names = map.services.map((s) => s.name)
  const out = new Map<string, string[]>(names.map((n) => [n, []]))
  const incoming = new Map<string, number>(names.map((n) => [n, 0]))
  for (const e of map.edges) {
    out.get(e.from)?.push(e.to)
    incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1)
  }
  const layer = new Map<string, number>()
  const exposed = new Set(map.inbound.entries.map((e) => e.service))
  const walk = (starts: string[], base: number) => {
    const queue = starts.filter((n) => !layer.has(n)).map((n) => [n, base] as const)
    for (const [n] of queue) layer.set(n, base)
    while (queue.length) {
      const [name, depth] = queue.shift()!
      for (const next of out.get(name) ?? []) {
        if (layer.has(next)) continue
        layer.set(next, depth + 1)
        queue.push([next, depth + 1])
      }
    }
  }
  walk(
    names.filter((n) => exposed.has(n)),
    0,
  )
  const rest = names.filter((n) => !layer.has(n))
  const roots = rest.filter((n) => !map.edges.some((e) => e.to === n && rest.includes(e.from)))
  walk(roots.length ? roots : rest.slice(0, 1), exposed.size ? 1 : 0)
  for (const n of names) if (!layer.has(n)) walk([n], exposed.size ? 1 : 0)
  return layer
}

const column = <T>(items: T[], height: number, tallest: number) => {
  const offset = (tallest - items.length * height) / 2
  return items.map((item, i) => ({
    item,
    y: offset + i * height,
  }))
}

export const layoutNetwork = (map: NetworkMap): { nodes: MapNode[]; edges: Edge[] } => {
  const layers = serviceLayers(map)
  const depth = Math.max(0, ...layers.values())
  const byLayer = Array.from(
    {
      length: depth + 1,
    },
    (_, i) =>
      map.services
        .filter((s) => layers.get(s.name) === i)
        .sort((a, b) => a.name.localeCompare(b.name)),
  )
  const entries = [...map.inbound.entries].sort(
    (a, b) => a.service.localeCompare(b.service) || entryKey(a).localeCompare(entryKey(b)),
  )
  const tallest = Math.max(
    rowHeight.internet,
    entries.length * rowHeight.entry,
    ...byLayer.map((l) => l.length * rowHeight.service),
  )
  const statusOf = (entry: MapEntry) => {
    const svc = map.services.find((s) => s.name === entry.service)
    if (entry.kind === 'domain')
      return svc?.domains.find((d) => d.hostname === entry.hostname)?.status ?? null
    return (
      svc?.exposures.find((x) => x.public === entry.public && x.port === entry.port)?.result ?? null
    )
  }
  const hasInbound = entries.length > 0
  const firstServiceColumn = hasInbound ? 2 : 0
  const nodes: MapNode[] = []
  if (hasInbound) {
    nodes.push({
      id: 'internet',
      type: 'internet',
      position: {
        x: 0,
        y: (tallest - rowHeight.internet) / 2,
      },
      data: {
        label: 'Internet',
      },
    })
    for (const { item, y } of column(entries, rowHeight.entry, tallest))
      nodes.push({
        id: entryKey(item),
        type: 'entry',
        position: {
          x: columnWidth,
          y,
        },
        data: {
          entry: item,
          status: statusOf(item),
        },
      })
  }
  byLayer.forEach((services, i) => {
    for (const { item, y } of column(services, rowHeight.service, tallest))
      nodes.push({
        id: `svc:${item.name}`,
        type: 'service',
        position: {
          x: (firstServiceColumn + i) * columnWidth,
          y,
        },
        data: {
          service: item,
        },
      })
  })
  const edges: Edge[] = [
    ...entries.flatMap((entry) => [
      {
        id: `in:${entryKey(entry)}`,
        source: 'internet',
        target: entryKey(entry),
        className: 'network-edge-inbound',
      },
      {
        id: `to:${entryKey(entry)}`,
        source: entryKey(entry),
        target: `svc:${entry.service}`,
        targetHandle: 'left',
        className: 'network-edge-inbound',
      },
    ]),
    ...map.edges.map((e) => {
      const from = nodes.find((n) => n.id === `svc:${e.from}`)!.position
      const to = nodes.find((n) => n.id === `svc:${e.to}`)!.position
      const handles =
        from.x < to.x
          ? {
              sourceHandle: 'right',
              targetHandle: 'left',
            }
          : from.x > to.x
            ? {
                sourceHandle: 'bottom-out',
                targetHandle: 'bottom-in',
              }
            : from.y < to.y
              ? {
                  sourceHandle: 'bottom-out',
                  targetHandle: 'top-in',
                }
              : {
                  sourceHandle: 'top-out',
                  targetHandle: 'bottom-in',
                }
      return {
        id: `ref:${e.from}>${e.to}`,
        source: `svc:${e.from}`,
        target: `svc:${e.to}`,
        ...handles,
        type: from.x === to.x ? 'smoothstep' : 'default',
        label: e.keys.join(', '),
        className: 'network-edge-reference',
        markerEnd: {
          type: MarkerType.ArrowClosed,
        },
      }
    }),
  ]
  return {
    nodes,
    edges,
  }
}

const units = ['B/s', 'kB/s', 'MB/s', 'GB/s']

export const rateText = (bps: number | null) => {
  if (bps === null) return '—'
  let value = bps
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit += 1
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
}

const sum = (values: (number | null)[]) =>
  values.some((v) => v !== null) ? values.reduce<number>((a, v) => a + (v ?? 0), 0) : null

type Group = Connections['connections'][number]

export const peerText = (peer: Group['peer']) => {
  if (peer.kind === 'service') return peer.service ?? peer.service_id ?? 'service'
  if (peer.address) return `${peer.kind} ${peer.address}`
  return peer.kind
}

export const endpointText = (endpoint: { address: string; port: number; protocol: string }) =>
  `${endpoint.address}:${endpoint.port}/${endpoint.protocol}`

export const portSpecText = (port: { port: number; protocol: string; grpc: boolean }) =>
  `${port.port}/${port.grpc ? 'grpc' : port.protocol}`

export const ageText = (seconds: number | null) => (seconds === null ? '—' : `${seconds} s`)

const groupLabel = (groups: Group[]) => {
  const flows = groups.reduce((a, g) => a + g.flows, 0)
  return `${flows} ${flows === 1 ? 'flow' : 'flows'} · ${rateText(sum(groups.flatMap((g) => [g.bps_out, g.bps_in])))}`
}

const handlesBetween = (from: { x: number; y: number }, to: { x: number; y: number }) =>
  from.x < to.x
    ? {
        sourceHandle: 'right',
        targetHandle: 'left',
      }
    : from.x > to.x
      ? {
          sourceHandle: 'bottom-out',
          targetHandle: 'bottom-in',
        }
      : from.y < to.y
        ? {
            sourceHandle: 'bottom-out',
            targetHandle: 'top-in',
          }
        : {
            sourceHandle: 'top-out',
            targetHandle: 'bottom-in',
          }

const inboundKinds = ['internet', 'gateway', 'station'] as const

const inboundLabel = {
  internet: 'Internet clients',
  gateway: 'Gateway',
  station: 'Station',
} as const

export const overlayLive = (
  layout: { nodes: MapNode[]; edges: Edge[] },
  samples: Connections[],
): { nodes: MapNode[]; edges: Edge[] } => {
  const nodes = [...layout.nodes]
  const edges = [...layout.edges]
  const serviceNode = (name: string) => nodes.find((n) => n.id === `svc:${name}`)
  const xs = nodes.map((n) => n.position.x)
  const ys = nodes.filter((n) => n.type === 'service').map((n) => n.position.y)
  const left = Math.min(0, ...xs) - columnWidth
  const right = Math.max(0, ...xs) + columnWidth
  const top = Math.min(0, ...ys)
  const leftNodes: {
    kind: (typeof inboundKinds)[number]
    groups: { service: string; groups: Group[] }[]
  }[] = []
  for (const kind of inboundKinds) {
    const groups = samples
      .map((s) => ({
        service: s.service.name,
        groups: s.connections.filter((c) => c.direction === 'in' && c.peer.kind === kind),
      }))
      .filter((g) => g.groups.length && serviceNode(g.service))
    if (groups.length)
      leftNodes.push({
        kind,
        groups,
      })
  }
  leftNodes.forEach(({ kind, groups }, i) => {
    const id = `live:in:${kind}`
    nodes.push({
      id,
      type: 'peer',
      position: {
        x: left,
        y: top + i * rowHeight.entry * 1.5,
      },
      data: {
        label: inboundLabel[kind],
        tone: 'live',
        icon: kind,
        side: 'left',
        lines: [],
      },
    })
    for (const g of groups)
      edges.push({
        id: `${id}>${g.service}`,
        source: id,
        target: `svc:${g.service}`,
        targetHandle: 'left',
        animated: true,
        label: groupLabel(g.groups),
        className: 'network-edge-live',
        markerEnd: {
          type: MarkerType.ArrowClosed,
        },
      })
  })
  for (const s of samples) {
    const from = serviceNode(s.service.name)
    if (!from) continue
    const byPeer = new Map<string, Group[]>()
    for (const c of s.connections)
      if (c.direction === 'out' && c.peer.kind === 'service' && c.peer.service)
        byPeer.set(c.peer.service, [...(byPeer.get(c.peer.service) ?? []), c])
    for (const [peer, groups] of byPeer) {
      const to = serviceNode(peer)
      if (!to || to === from) continue
      edges.push({
        id: `live:${s.service.name}>${peer}`,
        source: from.id,
        target: to.id,
        ...handlesBetween(from.position, to.position),
        animated: true,
        label: groupLabel(groups),
        className: 'network-edge-live',
        markerEnd: {
          type: MarkerType.ArrowClosed,
        },
      })
    }
  }
  const publics = samples.flatMap((s) =>
    s.connections
      .filter((c) => c.direction === 'out' && c.peer.kind === 'public')
      .map((c) => ({
        service: s.service.name,
        group: c,
        name: c.peer.address ? s.untrusted.names[c.peer.address] : undefined,
      })),
  )
  let rightY = top
  if (publics.length) {
    const destinations = [
      ...new Map(
        publics.map((p) => [
          p.group.peer.address ?? '',
          p.name ? `${p.group.peer.address} (${p.name})` : (p.group.peer.address ?? ''),
        ]),
      ).values(),
    ]
    nodes.push({
      id: 'live:public',
      type: 'peer',
      position: {
        x: right,
        y: rightY,
      },
      data: {
        label: 'Internet',
        tone: 'live',
        icon: 'internet',
        side: 'right',
        lines: destinations
          .slice(0, 6)
          .concat(destinations.length > 6 ? [`and ${destinations.length - 6} more`] : []),
      },
    })
    rightY += rowHeight.service
    for (const name of new Set(publics.map((p) => p.service))) {
      if (!serviceNode(name)) continue
      edges.push({
        id: `live:${name}>public`,
        source: `svc:${name}`,
        target: 'live:public',
        sourceHandle: 'right',
        animated: true,
        label: groupLabel(publics.filter((p) => p.service === name).map((p) => p.group)),
        className: 'network-edge-live',
        markerEnd: {
          type: MarkerType.ArrowClosed,
        },
      })
    }
  }
  const refused = samples.flatMap((s) =>
    s.refused.map((r) => ({
      service: s.service.name,
      r,
    })),
  )
  const paths = [...new Set(refused.map((x) => x.r.path))].sort()
  for (const path of paths) {
    const id = `live:blocked:${path}`
    const items = refused.filter((x) => x.r.path === path)
    nodes.push({
      id,
      type: 'peer',
      position: {
        x: right,
        y: rightY,
      },
      data: {
        label: `Blocked: ${path}`,
        tone: 'blocked',
        icon: 'blocked',
        side: 'right',
        lines: [...new Set(items.map((x) => endpointText(x.r)))].slice(0, 4),
      },
    })
    rightY += rowHeight.entry * 2
    for (const name of new Set(items.map((x) => x.service))) {
      if (!serviceNode(name)) continue
      const count = items.filter((x) => x.service === name).reduce((a, x) => a + x.r.count, 0)
      edges.push({
        id: `${id}<${name}`,
        source: `svc:${name}`,
        target: id,
        sourceHandle: 'right',
        label: `${count} refused`,
        className: 'network-edge-refused',
        markerEnd: {
          type: MarkerType.ArrowClosed,
        },
      })
    }
  }
  return {
    nodes,
    edges,
  }
}
