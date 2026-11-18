import {
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react'
import { Globe, ShieldBan, ShieldCheck, Undo2 } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useMemo } from 'react'

import type { NetworkMap } from '@/lib/api'
import { entityIcon } from '@/lib/icons'
import { pathFrom, path as pathLabel, pathResult } from '@/lib/labels'
import { toneText } from '@/lib/tone'
import { cn } from '@/lib/utils'

type TrafficPath = NetworkMap['paths'][number]

type Verdict = TrafficPath['verdict']

type HubData = { label: string; icon: 'app' | 'machine' }

type EndData = { path: TrafficPath; side: 'left' | 'right' }

type TrafficNode = Node<HubData, 'hub'> | Node<EndData, 'end'>

const hidden = '!size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent'

const rowHeight = 52

const laneGap = 40

const x = {
  left: 0,
  hub: 380,
  right: 680,
}

const chartWidth = x.right + 384

const verdictOrder: Verdict[] = ['allowed', 'rejected', 'blocked']

export const verdictIcon = {
  allowed: ShieldCheck,
  blocked: ShieldBan,
  rejected: Undo2,
} as const

const byVerdict = (a: TrafficPath, b: TrafficPath) =>
  verdictOrder.indexOf(a.verdict) - verdictOrder.indexOf(b.verdict)

function HubNode({ data }: NodeProps<Node<HubData, 'hub'>>) {
  const Icon = entityIcon[data.icon]

  return (
    <div className="flex w-44 items-center gap-2 rounded-lg border bg-card px-3 py-3 text-sm font-semibold shadow-xs">
      <Handle type="target" position={Position.Left} isConnectable={false} className={hidden} />
      <Icon className="size-4 text-muted-foreground" aria-hidden />
      {data.label}
      <Handle type="source" position={Position.Right} isConnectable={false} className={hidden} />
    </div>
  )
}

function EndNode({ data }: NodeProps<Node<EndData, 'end'>>) {
  const { path, side } = data
  const result = pathResult[path.verdict]
  const Icon = side === 'left' ? Globe : verdictIcon[path.verdict]

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-lg border bg-card px-3 py-1.5 shadow-xs',
        side === 'left' ? 'w-72' : 'w-96',
      )}
      title={`${pathLabel[path.path]}: ${result.label}. ${result.hint}`}
    >
      {side === 'right' && (
        <Handle type="target" position={Position.Left} isConnectable={false} className={hidden} />
      )}
      <Icon
        className={cn(
          'size-4 shrink-0',
          side === 'left' ? 'text-muted-foreground' : toneText[result.tone],
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium">{pathLabel[path.path]}</p>
        <p className="truncate text-[11px] text-muted-foreground">{path.to}</p>
      </div>
      {side === 'right' && (
        <span className={cn('shrink-0 text-[11px] font-medium', toneText[result.tone])}>
          {result.label}
        </span>
      )}
      {side === 'left' && (
        <Handle type="source" position={Position.Right} isConnectable={false} className={hidden} />
      )}
    </div>
  )
}

const nodeTypes: NodeTypes = {
  hub: HubNode,
  end: EndNode,
}

const edgeFor = (id: string, source: string, target: string, verdict: Verdict): Edge => ({
  id,
  source,
  target,
  type: 'default',
  className: `traffic-edge-${verdict}`,
  ...(verdict === 'allowed'
    ? {
        markerEnd: {
          type: MarkerType.ArrowClosed,
        },
      }
    : {}),
})

const layoutTraffic = (paths: TrafficPath[]) => {
  const nodes: TrafficNode[] = []
  const edges: Edge[] = []
  const lanes = [
    {
      id: 'apps',
      label: pathFrom['every app'],
      icon: 'app' as const,
      left: paths.filter((p) => p.from === 'internet').sort(byVerdict),
      right: paths.filter((p) => p.from === 'every app').sort(byVerdict),
    },
    {
      id: 'machine',
      label: pathFrom['a machine'],
      icon: 'machine' as const,
      left: [],
      right: paths.filter((p) => p.from === 'a machine').sort(byVerdict),
    },
  ].filter((lane) => lane.left.length || lane.right.length)
  let top = 0

  for (const lane of lanes) {
    const rows = Math.max(lane.left.length, lane.right.length, 1)
    const height = rows * rowHeight
    const hub = `hub:${lane.id}`

    nodes.push({
      id: hub,
      type: 'hub',
      position: {
        x: x.hub,
        y: top + height / 2 - 24,
      },
      data: {
        label: lane.label,
        icon: lane.icon,
      },
    })

    for (const side of ['left', 'right'] as const) {
      const items = lane[side]
      const offset = (height - items.length * rowHeight) / 2

      items.forEach((p, i) => {
        const id = `end:${lane.id}:${p.path}`

        nodes.push({
          id,
          type: 'end',
          position: {
            x: x[side],
            y: top + offset + i * rowHeight,
          },
          data: {
            path: p,
            side,
          },
        })
        edges.push(
          side === 'left'
            ? edgeFor(`edge:${id}`, id, hub, p.verdict)
            : edgeFor(`edge:${id}`, hub, id, p.verdict),
        )
      })
    }

    top += height + laneGap
  }

  return {
    nodes,
    edges,
    height: Math.max(top - laneGap, rowHeight),
  }
}

export function TrafficChart({ paths, label }: { paths: TrafficPath[]; label: string }) {
  const { resolvedTheme } = useTheme()
  const { nodes, edges, height } = useMemo(() => layoutTraffic(paths), [paths])

  return (
    <>
      <div
        className="hidden overflow-hidden rounded-lg border md:block"
        style={{
          aspectRatio: `${chartWidth + 48} / ${height + 48}`,
          maxHeight: `${height + 48}px`,
        }}
        data-testid="traffic-chart"
      >
        <ReactFlow
          className="network-canvas"
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          colorMode={resolvedTheme === 'dark' ? 'dark' : 'light'}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          nodesFocusable={false}
          edgesFocusable={false}
          panOnDrag={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          preventScrolling={false}
          fitView
          fitViewOptions={{
            padding: 0.04,
            maxZoom: 1,
          }}
          minZoom={0.4}
          maxZoom={1}
          proOptions={{
            hideAttribution: true,
          }}
          aria-label={label}
        />
      </div>
      <TrafficList paths={paths} className="md:sr-only" />
    </>
  )
}

function TrafficList({ paths, className }: { paths: TrafficPath[]; className?: string }) {
  const groups = (['internet', 'every app', 'a machine'] as const)
    .map((from) => ({
      from,
      items: paths.filter((p) => p.from === from).sort(byVerdict),
    }))
    .filter((g) => g.items.length)

  return (
    <div className={cn('space-y-4', className)}>
      {groups.map((g) => (
        <section key={g.from} className="space-y-1.5">
          <h3 className="text-xs font-medium text-muted-foreground">
            {g.from === 'internet'
              ? `${pathFrom.internet} → ${pathFrom['every app']}`
              : `${pathFrom[g.from]} →`}
          </h3>
          <ul className="divide-y rounded-lg border">
            {g.items.map((p) => {
              const result = pathResult[p.verdict]
              const Icon = verdictIcon[p.verdict]

              return (
                <li key={p.path} className="flex items-start gap-2 px-3 py-2">
                  <Icon
                    className={cn('mt-0.5 size-4 shrink-0', toneText[result.tone])}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{pathLabel[p.path]}</p>
                    <p className="text-xs text-muted-foreground">{p.to}</p>
                  </div>
                  <span className={cn('shrink-0 text-xs font-medium', toneText[result.tone])}>
                    {result.label}
                  </span>
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}
