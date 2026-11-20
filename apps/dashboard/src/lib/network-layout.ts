import { MarkerType, type Edge, type Node } from '@xyflow/react'

import type { Connections, NetworkMap } from './api'
import { plural } from './format'
import { inboundPeer, path as pathLabel, peerKind, type Status } from './labels'
import { domainState, endpointText, rateText } from './network-text'

export type MapApp = NetworkMap['apps'][number]
export type MapEntry = NetworkMap['inbound']['entries'][number]

export type InternetData = { label: string }
export type EntryData = {
  entry: MapEntry
  status: Status | null
}
export type AppData = { app: MapApp }

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
  | Node<AppData, 'app'>
  | Node<PeerData, 'peer'>

const gap = 80
const width = {
  internet: 160,
  entry: 288,
  app: 288,
  peer: 240,
} as const
const appStep = width.app + gap
const entryX = width.internet + gap
const rowHeight = {
  internet: 80,
  entry: 64,
  app: 184,
} as const

export const entryKey = (entry: MapEntry) => `domain:${entry.hostname}`

const appLayers = (map: NetworkMap) => {
  const names = map.apps.map((s) => s.name)
  const out = new Map<string, string[]>(names.map((n) => [n, []]))
  const incoming = new Map<string, number>(names.map((n) => [n, 0]))

  for (const e of map.edges) {
    out.get(e.from)?.push(e.to)
    incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1)
  }

  const layer = new Map<string, number>()
  const reachable = new Set(map.inbound.entries.map((e) => e.app))
  const walk = (starts: string[], base: number) => {
    const queue = starts.filter((n) => !layer.has(n)).map((n) => [n, base] as const)

    for (const [n] of queue) {
      layer.set(n, base)
    }

    while (queue.length) {
      const [name, depth] = queue.shift()!

      for (const next of out.get(name) ?? []) {
        if (layer.has(next)) {
          continue
        }

        layer.set(next, depth + 1)
        queue.push([next, depth + 1])
      }
    }
  }

  const isolated = names.filter(
    (n) => !reachable.has(n) && !map.edges.some((e) => e.from === n || e.to === n),
  )

  walk(
    names.filter((n) => reachable.has(n) || isolated.includes(n)),
    0,
  )
  const rest = names.filter((n) => !layer.has(n))
  const roots = rest.filter((n) => !map.edges.some((e) => e.to === n && rest.includes(e.from)))

  walk(roots.length ? roots : rest.slice(0, 1), reachable.size ? 1 : 0)

  for (const n of names) {
    if (!layer.has(n)) {
      walk([n], reachable.size ? 1 : 0)
    }
  }

  return layer
}

const column = <T>(items: T[], height: number, tallest: number) => {
  const offset = (tallest - items.length * height) / 2

  return items.map((item, i) => ({
    item,
    y: offset + i * height,
  }))
}

export const mapHeight = (nodes: MapNode[]) => {
  const ys = nodes.map((node) => node.position.y)

  return ys.length ? Math.max(...ys) - Math.min(...ys) + rowHeight.app : rowHeight.app
}

export const layoutNetwork = (map: NetworkMap): { nodes: MapNode[]; edges: Edge[] } => {
  const layers = appLayers(map)
  const depth = Math.max(0, ...layers.values())
  const byLayer = Array.from(
    {
      length: depth + 1,
    },
    (_, i) =>
      map.apps.filter((s) => layers.get(s.name) === i).sort((a, b) => a.name.localeCompare(b.name)),
  )
  const entries = [...map.inbound.entries].sort(
    (a, b) => a.app.localeCompare(b.app) || entryKey(a).localeCompare(entryKey(b)),
  )
  const tallest = Math.max(
    rowHeight.internet,
    entries.length * rowHeight.entry,
    ...byLayer.map((l) => l.length * rowHeight.app),
  )
  const statusOf = (entry: MapEntry) => {
    const domain = map.apps
      .find((s) => s.name === entry.app)
      ?.domains.find((d) => d.hostname === entry.hostname)

    return domain ? domainState(domain) : null
  }
  const hasInbound = entries.length > 0
  const firstAppX = hasInbound ? entryX + width.entry + gap : 0
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
        label: peerKind.internet,
      },
    })

    for (const { item, y } of column(entries, rowHeight.entry, tallest)) {
      nodes.push({
        id: entryKey(item),
        type: 'entry',
        position: {
          x: entryX,
          y,
        },
        data: {
          entry: item,
          status: statusOf(item),
        },
      })
    }
  }

  byLayer.forEach((apps, i) => {
    for (const { item, y } of column(apps, rowHeight.app, tallest)) {
      nodes.push({
        id: `svc:${item.name}`,
        type: 'app',
        position: {
          x: firstAppX + i * appStep,
          y,
        },
        data: {
          app: item,
        },
      })
    }
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
        target: `svc:${entry.app}`,
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
        label: e.environment_variables.join(', '),
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

const sum = (values: (number | null)[]) =>
  values.some((v) => v !== null) ? values.reduce<number>((a, v) => a + (v ?? 0), 0) : null

type Group = Connections['connections'][number]

const groupLabel = (groups: Group[]) =>
  `${plural(
    groups.reduce((a, g) => a + g.flows, 0),
    'connection',
  )} · ${rateText(sum(groups.flatMap((g) => [g.bps_out, g.bps_in])))}`

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

const inboundKinds = Object.keys(inboundPeer) as (keyof typeof inboundPeer)[]

export const overlayLive = (
  layout: { nodes: MapNode[]; edges: Edge[] },
  samples: Connections[],
): { nodes: MapNode[]; edges: Edge[] } => {
  const nodes = [...layout.nodes]
  const edges = [...layout.edges]
  const appNode = (name: string) => nodes.find((n) => n.id === `svc:${name}`)
  const xs = nodes.map((n) => n.position.x)
  const ys = nodes.filter((n) => n.type === 'app').map((n) => n.position.y)
  const left = Math.min(0, ...xs) - width.peer - gap
  const right = Math.max(0, ...xs) + appStep
  const top = Math.min(0, ...ys)
  const leftNodes: {
    kind: (typeof inboundKinds)[number]
    groups: { app: string; groups: Group[] }[]
  }[] = []

  for (const kind of inboundKinds) {
    const groups = samples
      .map((s) => ({
        app: s.app.name,
        groups: s.connections.filter((c) => c.direction === 'in' && c.peer.kind === kind),
      }))
      .filter((g) => g.groups.length && appNode(g.app))

    if (groups.length) {
      leftNodes.push({
        kind,
        groups,
      })
    }
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
        label: inboundPeer[kind],
        tone: 'live',
        icon: kind,
        side: 'left',
        lines: [],
      },
    })

    for (const g of groups) {
      edges.push({
        id: `${id}>${g.app}`,
        source: id,
        target: `svc:${g.app}`,
        targetHandle: 'left',
        animated: true,
        label: groupLabel(g.groups),
        className: 'network-edge-live',
        markerEnd: {
          type: MarkerType.ArrowClosed,
        },
      })
    }
  })

  for (const s of samples) {
    const from = appNode(s.app.name)

    if (!from) {
      continue
    }

    const byPeer = new Map<string, Group[]>()

    for (const c of s.connections) {
      if (c.direction === 'out' && c.peer.kind === 'service' && c.peer.app) {
        byPeer.set(c.peer.app, [...(byPeer.get(c.peer.app) ?? []), c])
      }
    }

    for (const [peer, groups] of byPeer) {
      const to = appNode(peer)

      if (!to || to === from) {
        continue
      }

      edges.push({
        id: `live:${s.app.name}>${peer}`,
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
        app: s.app.name,
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
        label: peerKind.internet,
        tone: 'live',
        icon: 'internet',
        side: 'right',
        lines: destinations
          .slice(0, 6)
          .concat(destinations.length > 6 ? [`and ${destinations.length - 6} more`] : []),
      },
    })
    rightY += rowHeight.app

    for (const name of new Set(publics.map((p) => p.app))) {
      if (!appNode(name)) {
        continue
      }

      edges.push({
        id: `live:${name}>public`,
        source: `svc:${name}`,
        target: 'live:public',
        sourceHandle: 'right',
        animated: true,
        label: groupLabel(publics.filter((p) => p.app === name).map((p) => p.group)),
        className: 'network-edge-live',
        markerEnd: {
          type: MarkerType.ArrowClosed,
        },
      })
    }
  }

  const refused = samples.flatMap((s) =>
    s.refused.map((r) => ({
      app: s.app.name,
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
        label: pathLabel[path],
        tone: 'blocked',
        icon: 'blocked',
        side: 'right',
        lines: [...new Set(items.map((x) => endpointText(x.r)))].slice(0, 4),
      },
    })
    rightY += rowHeight.entry * 2

    for (const name of new Set(items.map((x) => x.app))) {
      if (!appNode(name)) {
        continue
      }

      const count = items.filter((x) => x.app === name).reduce((a, x) => a + x.r.count, 0)

      edges.push({
        id: `${id}<${name}`,
        source: `svc:${name}`,
        target: id,
        sourceHandle: 'right',
        label: `${count} blocked`,
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
