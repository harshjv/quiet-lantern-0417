import { MarkerType, type Edge, type Node } from '@xyflow/react'

import type { Connections, NetworkMap, Project } from './api'

export type CanvasApp = NetworkMap['apps'][number]
export type CanvasServer = NonNullable<Project['servers']>[number]
export type Connection = Connections['connections'][number]

export type Traffic = { flows: number }

export type InternetData = { traffic: Traffic | null }
export type TunnelData = { server: CanvasServer | null; traffic: Traffic | null }
export type AppData = { app: CanvasApp; badge: string | null; focused: boolean }
export type HostsData = { hosts: string[] }
export type ServerData = { server: CanvasServer | null; height: number }

export type CanvasNode =
  | Node<InternetData, 'internet'>
  | Node<TunnelData, 'tunnel'>
  | Node<AppData, 'app'>
  | Node<HostsData, 'hosts'>
  | Node<ServerData, 'server'>

export type TrafficData = { traffic: Traffic | null; outbound: boolean }

export type CanvasEdge = Edge<TrafficData, 'traffic'>

export type CanvasLayout = { nodes: CanvasNode[]; edges: CanvasEdge[] }

export const size = {
  internet: {
    width: 160,
    height: 76,
  },
  tunnel: {
    width: 208,
    height: 96,
  },
  app: {
    width: 240,
    height: 96,
  },
  hosts: {
    width: 224,
    height: 128,
  },
} as const

const gap = {
  column: 96,
  row: 28,
  group: 40,
  groupHead: 36,
  groupPad: 16,
} as const

const x = {
  internet: 0,
  tunnel: size.internet.width + gap.column,
  apps: size.internet.width + size.tunnel.width + gap.column * 2,
} as const

const appStep = size.app.width + gap.column

const rowStep = size.app.height + gap.row

export const appNodeId = (app: string) => `app:${app}`

const tunnelId = (server: string) => `tunnel:${server}`

const serverId = (server: string) => `server:${server}`

const hostsId = 'hosts'

const internetId = 'internet'

const noServer = ''

const columnsOf = (apps: CanvasApp[], references: NetworkMap['edges']) => {
  const names = new Set(apps.map((app) => app.name))
  const links = references.filter((e) => names.has(e.from) && names.has(e.to) && e.from !== e.to)
  const column = new Map<string, number>()
  const roots = apps
    .filter((app) => app.domains.length > 0 || !links.some((e) => e.to === app.name))
    .map((app) => app.name)
  const queue: [string, number][] = (
    roots.length ? roots : apps.slice(0, 1).map((app) => app.name)
  ).map((name) => [name, 0])

  for (const [name] of queue) {
    column.set(name, 0)
  }

  while (queue.length) {
    const [name, depth] = queue.shift()!

    for (const next of links.filter((e) => e.from === name).map((e) => e.to)) {
      if (!column.has(next)) {
        column.set(next, depth + 1)
        queue.push([next, depth + 1])
      }
    }
  }

  for (const app of apps) {
    if (!column.has(app.name)) {
      column.set(app.name, 0)
    }
  }

  return column
}

const sumTraffic = (items: Traffic[]): Traffic | null =>
  items.length
    ? {
        flows: items.reduce((total, t) => total + t.flows, 0),
      }
    : null

const trafficOf = (connections: Connection[]): Traffic => ({
  flows: connections.reduce((total, c) => total + c.flows, 0),
})

export const hostOf = (sample: Connections, connection: Connection) => {
  const address = connection.peer.address ?? ''

  return sample.untrusted.names[address] ?? address
}

const handlesBetween = (from: { x: number; y: number }, to: { x: number; y: number }) =>
  to.x > from.x
    ? {
        sourceHandle: 'right',
        targetHandle: 'left',
      }
    : to.y > from.y
      ? {
          sourceHandle: 'bottom',
          targetHandle: 'top',
        }
      : {
          sourceHandle: 'top-out',
          targetHandle: 'bottom-in',
        }

export const layoutCanvas = ({
  servers,
  apps,
  references,
  samples,
  badges,
  focus,
}: {
  servers: CanvasServer[]
  apps: CanvasApp[]
  references: NetworkMap['edges']
  samples: Connections[] | null
  badges: Map<string, string>
  focus: string | null
}): CanvasLayout => {
  const sampleOf = new Map((samples ?? []).map((s) => [s.app.id, s]))
  const known = new Set(servers.map((s) => s.id))
  const groupKeys = [
    ...servers.filter((s) => apps.some((app) => app.server_id === s.id)).map((s) => s.id),
    ...(apps.some((app) => !known.has(app.server_id)) ? [noServer] : []),
  ]
  const grouped = groupKeys.length > 1
  const sorted = [...apps].sort(
    (a, b) =>
      Number(b.domains.length > 0) - Number(a.domains.length > 0) || a.name.localeCompare(b.name),
  )
  const nodes: CanvasNode[] = []
  const edges: CanvasEdge[] = []
  const appPosition = new Map<string, { x: number; y: number }>()
  const inbound = (app: CanvasApp) => {
    const sample = sampleOf.get(app.id)

    return sample
      ? trafficOf(
          sample.connections.filter((c) => c.direction === 'in' && c.peer.kind === 'gateway'),
        )
      : null
  }
  let top = 0
  let widest = 0

  for (const key of groupKeys) {
    const members = sorted.filter((app) =>
      key === noServer ? !known.has(app.server_id) : app.server_id === key,
    )
    const columns = columnsOf(members, references)
    const depth = Math.max(0, ...columns.values()) + 1
    const tallest = Math.max(
      1,
      ...Array.from(
        {
          length: depth,
        },
        (_, i) => members.filter((app) => columns.get(app.name) === i).length,
      ),
    )
    const head = grouped ? gap.groupHead : 0
    const bodyHeight = Math.max(tallest * rowStep - gap.row, size.tunnel.height)
    const server = servers.find((s) => s.id === key) ?? null
    const withDomain = members.filter((app) => app.domains.length > 0)

    if (grouped) {
      nodes.push({
        id: serverId(key),
        type: 'server',
        position: {
          x: x.tunnel - gap.groupPad,
          y: top,
        },
        data: {
          server,
          height: head + bodyHeight + gap.groupPad,
        },
        width: x.apps - x.tunnel + depth * appStep - gap.column + gap.groupPad * 2,
        height: head + bodyHeight + gap.groupPad,
        selectable: false,
        focusable: false,
        zIndex: -1,
      })
    }

    const bodyTop = top + head

    if (withDomain.length) {
      const traffic = sumTraffic(withDomain.flatMap((app) => inbound(app) ?? []))

      nodes.push({
        id: tunnelId(key),
        type: 'tunnel',
        position: {
          x: x.tunnel,
          y: bodyTop + (bodyHeight - size.tunnel.height) / 2,
        },
        data: {
          server,
          traffic,
        },
      })
      edges.push({
        id: `${internetId}>${tunnelId(key)}`,
        source: internetId,
        target: tunnelId(key),
        sourceHandle: 'right',
        targetHandle: 'left',
        type: 'traffic',
        data: {
          traffic,
          outbound: false,
        },
      })
    }

    for (let i = 0; i < depth; i += 1) {
      const inColumn = members.filter((app) => columns.get(app.name) === i)
      const offset = (bodyHeight - (inColumn.length * rowStep - gap.row)) / 2

      inColumn.forEach((app, row) => {
        const position = {
          x: x.apps + i * appStep,
          y: bodyTop + offset + row * rowStep,
        }

        appPosition.set(app.name, position)
        nodes.push({
          id: appNodeId(app.id),
          type: 'app',
          position,
          style: {
            pointerEvents: 'all',
          },
          data: {
            app,
            badge: badges.get(app.id) ?? null,
            focused: false,
          },
        })

        if (app.domains.length) {
          edges.push({
            id: `${tunnelId(key)}>${app.id}`,
            source: tunnelId(key),
            target: appNodeId(app.id),
            sourceHandle: 'right',
            targetHandle: 'left',
            type: 'traffic',
            data: {
              traffic: inbound(app),
              outbound: false,
            },
          })
        }
      })
    }

    widest = Math.max(widest, x.apps + depth * appStep)
    top = bodyTop + bodyHeight + (grouped ? gap.groupPad + gap.group : 0)
  }

  const height = Math.max(top - (grouped ? gap.group : 0), size.tunnel.height)
  const byName = new Map(apps.map((app) => [app.name, app]))
  const hosts = new Map<string, number>()

  for (const app of sorted) {
    const sample = sampleOf.get(app.id)

    if (!sample) {
      continue
    }

    const peers = new Map<string, Connection[]>()
    const outside: Connection[] = []

    for (const c of sample.connections) {
      if (c.direction !== 'out') {
        continue
      }

      if (c.peer.kind === 'service' && c.peer.app && byName.has(c.peer.app)) {
        peers.set(c.peer.app, [...(peers.get(c.peer.app) ?? []), c])
      }

      if (c.peer.kind === 'public') {
        outside.push(c)
        hosts.set(hostOf(sample, c), (hosts.get(hostOf(sample, c)) ?? 0) + c.flows)
      }
    }

    for (const [peer, connections] of peers) {
      const target = byName.get(peer)!
      const from = appPosition.get(app.name)
      const to = appPosition.get(peer)

      if (!from || !to || target.id === app.id) {
        continue
      }

      edges.push({
        id: `${app.id}>${target.id}`,
        source: appNodeId(app.id),
        target: appNodeId(target.id),
        ...handlesBetween(from, to),
        type: 'traffic',
        data: {
          traffic: trafficOf(connections),
          outbound: false,
        },
      })
    }

    if (outside.length) {
      edges.push({
        id: `${app.id}>${hostsId}`,
        source: appNodeId(app.id),
        target: hostsId,
        sourceHandle: 'right',
        targetHandle: 'left',
        type: 'traffic',
        data: {
          traffic: trafficOf(outside),
          outbound: true,
        },
      })
    }
  }

  if (apps.some((app) => app.domains.length)) {
    nodes.push({
      id: internetId,
      type: 'internet',
      position: {
        x: x.internet,
        y: (height - size.internet.height) / 2,
      },
      data: {
        traffic: sumTraffic(apps.flatMap((app) => inbound(app) ?? [])),
      },
    })
  }

  if (apps.length) {
    nodes.push({
      id: hostsId,
      type: 'hosts',
      position: {
        x: widest,
        y: (height - size.hosts.height) / 2,
      },
      data: {
        hosts: [...hosts.entries()].sort((a, b) => b[1] - a[1]).map(([host]) => host),
      },
    })
  }

  for (const edge of edges) {
    edge.markerEnd = {
      type: MarkerType.ArrowClosed,
    }
  }

  return focus
    ? focused(
        {
          nodes,
          edges,
        },
        appNodeId(focus),
        referenced(apps, references, focus),
      )
    : {
        nodes,
        edges,
      }
}

const referenced = (apps: CanvasApp[], references: NetworkMap['edges'], focus: string) => {
  const name = apps.find((app) => app.id === focus)?.name
  const idOf = (other: string) => {
    const app = apps.find((a) => a.name === other)

    return app ? [appNodeId(app.id)] : []
  }
  const into = references.flatMap((e) => (e.to === name && e.from !== name ? idOf(e.from) : []))
  const from = references.flatMap((e) => (e.from === name && e.to !== name ? idOf(e.to) : []))

  return {
    into: [...new Set(into)],
    from: [...new Set(from)].filter((id) => !into.includes(id)),
  }
}

const focusGap = {
  row: 56,
  column: 32,
} as const

const widthOf = (node: CanvasNode) => (node.type === 'server' ? 0 : size[node.type].width)

const heightOf = (node: CanvasNode) => (node.type === 'server' ? 0 : size[node.type].height)

const pairs = <T>(items: T[]) =>
  Array.from(
    {
      length: Math.ceil(items.length / 2),
    },
    (_, i) => items.slice(i * 2, i * 2 + 2),
  )

const focused = (
  { nodes, edges }: { nodes: CanvasNode[]; edges: CanvasEdge[] },
  center: string,
  neighbours: { into: string[]; from: string[] },
): CanvasLayout => {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const tunnel = edges.find((e) => e.target === center && e.source.startsWith('tunnel:'))?.source
  const entry = [tunnel ? internetId : null, tunnel ?? null].filter((id): id is string => !!id)
  const rows = [
    entry,
    ...pairs(neighbours.into),
    [center],
    ...pairs(neighbours.from),
    byId.has(hostsId) ? [hostsId] : [],
  ]
    .map((row) => row.flatMap((id) => byId.get(id) ?? []))
    .filter((row) => row.length)
  const spacing = (row: CanvasNode[]) => (row[0]?.id === internetId ? gap.column : focusGap.column)
  const rowWidth = (row: CanvasNode[]) =>
    row.reduce((total, node) => total + widthOf(node), 0) + (row.length - 1) * spacing(row)
  const width = Math.max(...rows.map(rowWidth))
  const placed: CanvasNode[] = []
  let top = 0

  for (const row of rows) {
    let left = (width - rowWidth(row)) / 2

    for (const node of row) {
      placed.push({
        ...node,
        position: {
          x: left,
          y: top,
        },
        data: {
          ...node.data,
          ...(node.type === 'app'
            ? {
                focused: node.id === center,
              }
            : {}),
        },
      } as CanvasNode)
      left += widthOf(node) + spacing(row)
    }

    top += Math.max(...row.map(heightOf)) + focusGap.row
  }

  const kept = new Set(placed.map((node) => node.id))

  return {
    nodes: placed,
    edges: edges
      .filter((edge) => kept.has(edge.source) && kept.has(edge.target))
      .map((edge) =>
        edge.source === internetId
          ? edge
          : {
              ...edge,
              sourceHandle: 'bottom',
              targetHandle: 'top',
            },
      ),
  }
}
