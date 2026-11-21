import { Link } from '@tanstack/react-router'
import {
  BaseEdge,
  getBezierPath,
  Handle,
  Position,
  type EdgeProps,
  type EdgeTypes,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react'
import { Cloud, Globe } from 'lucide-react'
import { createContext, useContext, type ReactNode } from 'react'

import { Code } from '@/components/code'
import { Name } from '@/components/name'
import { AppStatusDot } from '@/components/status'
import {
  type AppData,
  type CanvasEdge,
  type CanvasNode,
  type HostsData,
  type InternetData,
  type ServerData,
  type TunnelData,
} from '@/lib/canvas-layout'
import { plural } from '@/lib/format'
import { appStatus } from '@/lib/labels'
import { appTo } from '@/lib/links'
import { domainState } from '@/lib/network-text'
import { countPill, toneBorder, toneText } from '@/lib/tone'
import { cn } from '@/lib/utils'

import { ServerChip } from './canvas-parts'

export const CanvasProject = createContext('')

const hidden = '!size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent'

const box = 'flex flex-col gap-2 border bg-card px-3 py-3 text-sm shadow-xs'

const edgeBox = 'border-dashed bg-muted/40'

function Side({
  type,
  position,
  id,
}: {
  type: 'source' | 'target'
  position: Position
  id?: string
}) {
  return <Handle id={id} type={type} position={position} isConnectable={false} className={hidden} />
}

function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="flex flex-col gap-0.5 text-xs">
      {items.map(([label, value]) => (
        <div key={label} className="flex gap-3">
          <dt className="w-10 shrink-0 text-muted-foreground">{label}</dt>
          <dd className="min-w-0 truncate">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function InternetNode({ data }: NodeProps<CanvasNode & { type: 'internet'; data: InternetData }>) {
  return (
    <div className={cn(box, edgeBox, 'w-40')}>
      <span className="flex items-center gap-2 font-medium">
        <Globe className="size-4 text-muted-foreground" aria-hidden />
        Internet
      </span>
      {data.traffic && <Facts items={[['In', plural(data.traffic.flows, 'connection')]]} />}
      <Side id="right" type="source" position={Position.Right} />
    </div>
  )
}

function TunnelNode({ data }: NodeProps<CanvasNode & { type: 'tunnel'; data: TunnelData }>) {
  const tunnel = data.server?.tunnel
  const down = tunnel && !tunnel.ready ? 'Down' : null

  return (
    <div
      className={cn(
        box,
        edgeBox,
        'w-52',
        down && toneBorder.danger,
        data.server !== null && data.server.status !== 'online' && 'opacity-35',
      )}
    >
      <Side id="left" type="target" position={Position.Left} />
      <span className="flex items-center gap-2 font-medium">
        <Cloud className={cn('size-4', toneText.warning)} aria-hidden />
        Cloudflare Tunnel
      </span>
      <Facts
        items={[
          ...(tunnel
            ? [
                [
                  'Links',
                  <span key="links" className={cn(down && toneText.danger)}>
                    {plural(tunnel.connections, 'connection')}
                  </span>,
                ] as [string, ReactNode],
              ]
            : []),
          ...(down
            ? [
                [
                  'Status',
                  <span key="status" className={toneText.danger}>
                    {down}
                  </span>,
                ] as [string, ReactNode],
              ]
            : []),
        ]}
      />
      <Side id="right" type="source" position={Position.Right} />
      <Side id="bottom" type="source" position={Position.Bottom} />
    </div>
  )
}

function AppNode({ data }: NodeProps<CanvasNode & { type: 'app'; data: AppData }>) {
  const project = useContext(CanvasProject)
  const { app } = data
  const status = appStatus[app.status]
  const domain = app.domains[0]
  const domainStatus = domain ? domainState(domain) : null
  const deployment = app.switch.deployment

  return (
    <Link
      {...appTo(project, app.id)}
      className={cn(
        box,
        'nodrag nopan relative min-h-24 w-60 gap-1.5 text-foreground transition-colors hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        app.status === 'failing' && toneBorder.danger,
        data.focused && 'ring-2 ring-ring',
      )}
      aria-current={data.focused ? 'page' : undefined}
      data-testid="canvas-app"
    >
      <Side id="left" type="target" position={Position.Left} />
      <Side id="top" type="target" position={Position.Top} />
      <Side id="bottom-in" type="target" position={Position.Bottom} />
      <span className="flex items-center gap-2">
        <Name kind="app">{app.name}</Name>
        {deployment && (
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            #{deployment.number}
          </span>
        )}
      </span>
      <span className="flex items-center gap-1.5 text-xs">
        <AppStatusDot status={app.status} />
        <span>{status.label}</span>
      </span>
      {domain ? (
        <span className="flex min-w-0 items-center gap-2 text-xs">
          <Code className="min-w-0 truncate text-xs">{domain.hostname}</Code>
          {domainStatus && domainStatus.tone !== 'success' && (
            <span className={cn('shrink-0', toneText[domainStatus.tone])}>
              {domainStatus.label}
            </span>
          )}
          {app.domains.length > 1 && (
            <span className="shrink-0 text-muted-foreground">+{app.domains.length - 1}</span>
          )}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">No domain</span>
      )}
      {data.badge && (
        <span className={cn('absolute -top-2.5 right-2 h-5 px-2 text-xs', countPill)}>
          {data.badge}
        </span>
      )}
      <Side id="right" type="source" position={Position.Right} />
      <Side id="bottom" type="source" position={Position.Bottom} />
      <Side id="top-out" type="source" position={Position.Top} />
    </Link>
  )
}

const shownHosts = 3

function HostsNode({ data }: NodeProps<CanvasNode & { type: 'hosts'; data: HostsData }>) {
  const extra = data.hosts.length - shownHosts

  return (
    <div className={cn(box, edgeBox, 'w-56', toneBorder.warning)}>
      <Side id="left" type="target" position={Position.Left} />
      <Side id="top" type="target" position={Position.Top} />
      <span className={cn('flex items-center gap-2 font-medium', toneText.warning)}>
        <Globe className="size-4" aria-hidden />
        Any host
      </span>
      {data.hosts.length ? (
        <ul className="flex flex-col items-start gap-0.5 text-xs">
          {data.hosts.slice(0, shownHosts).map((host) => (
            <li key={host} className="max-w-full truncate">
              <Code className="text-xs">{host}</Code>
            </li>
          ))}
          {extra > 0 && <li className="text-muted-foreground">+{extra}</li>}
        </ul>
      ) : (
        <span className="text-xs text-muted-foreground">None seen</span>
      )}
    </div>
  )
}

function ServerNode({ data }: NodeProps<CanvasNode & { type: 'server'; data: ServerData }>) {
  return (
    <div className="pointer-events-none size-full border border-dashed p-2">
      {data.server && <ServerChip server={data.server} />}
    </div>
  )
}

export const nodeTypes: NodeTypes = {
  internet: InternetNode,
  tunnel: TunnelNode,
  app: AppNode,
  hosts: HostsNode,
  server: ServerNode,
}

function TrafficEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data,
}: EdgeProps<CanvasEdge>) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  })
  const busy = Boolean(data?.traffic?.flows)

  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      className={cn(
        'canvas-edge',
        busy && 'canvas-edge-busy',
        data?.outbound && 'canvas-edge-outbound',
      )}
      labelX={labelX}
      labelY={labelY}
      label={data?.traffic ? plural(data.traffic.flows, 'connection') : undefined}
      labelShowBg
      labelBgPadding={[4, 2]}
    />
  )
}

export const edgeTypes: EdgeTypes = {
  traffic: TrafficEdge,
}
