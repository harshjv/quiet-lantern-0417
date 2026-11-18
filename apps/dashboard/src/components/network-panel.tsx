import { useSuspenseQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react'
import {
  Box,
  CircleAlert,
  Globe,
  Info,
  Network,
  Plug,
  Plus,
  Server,
  ShieldBan,
  Waypoints,
} from 'lucide-react'
import { useTheme } from 'next-themes'
import { useMemo, useState, type ReactNode } from 'react'

import { Code, Command } from '@/components/code'
import { ConnectionsTable } from '@/components/connections-table'
import { FixActions } from '@/components/fix'
import { NewApp } from '@/components/new-service'
import { EmptyState } from '@/components/page'
import { AppStatusDot } from '@/components/status'
import { EmptyRow, TableFrame } from '@/components/table-frame'
import { Term } from '@/components/term'
import { Time } from '@/components/time'
import { TrafficChart, verdictIcon } from '@/components/traffic-chart'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { NetworkMap } from '@/lib/api'
import { commands, type Scope } from '@/lib/commands'
import { findingPlan } from '@/lib/fixes'
import { ago, plural } from '@/lib/format'
import { appKind, explanationVerdict, finding, path as pathLabel, pathResult } from '@/lib/labels'
import { appTo } from '@/lib/links'
import {
  layoutNetwork,
  mapHeight,
  overlayLive,
  type AppData,
  type EntryData,
  type InternetData,
  type MapApp,
  type MapNode,
  type PeerData,
} from '@/lib/network-layout'
import { useLiveNetwork, type LiveNetwork } from '@/lib/network-live'
import {
  domainState,
  drainingText,
  endpointText,
  exposureState,
  exposureText,
  portSpecText,
  servingText,
} from '@/lib/network-text'
import { scopeOf, type PlaceView } from '@/lib/place'
import { networkQuery } from '@/lib/queries'
import { toneDot, toneText } from '@/lib/tone'
import { cn } from '@/lib/utils'

const hidden = '!size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent'

const notAssigned = 'Not assigned'

function None({ children = 'None', className }: { children?: ReactNode; className?: string }) {
  return <span className={cn('text-muted-foreground', className)}>{children}</span>
}

function Serving({ app }: { app: MapApp }) {
  const serving = servingText(app)
  const draining = drainingText(app.switch)
  const deployment = app.switch.state === 'serving' ? app.switch.deployment : null
  const tone = serving.tone && toneText[serving.tone]

  return (
    <span className="flex flex-wrap items-center gap-x-2">
      {deployment ? (
        <Link
          to="/deployments/$deployment"
          params={{
            deployment: deployment.id,
          }}
          title={serving.hint ?? undefined}
          className="underline-offset-4 hover:underline"
        >
          {serving.label}
        </Link>
      ) : serving.hint ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className={cn('cursor-help', tone)}>
              {serving.label}
            </span>
          </TooltipTrigger>
          <TooltipContent>{serving.hint}</TooltipContent>
        </Tooltip>
      ) : (
        <span className={cn(tone)}>{serving.label}</span>
      )}
      {draining && <span className="text-muted-foreground">{draining}</span>}
    </span>
  )
}

function Ports({ app }: { app: MapApp }) {
  return app.ports.length ? app.ports.map(portSpecText).join(' · ') : <None />
}

function InternetNode({ data }: NodeProps<MapNode & { type: 'internet'; data: InternetData }>) {
  return (
    <div className="flex w-40 items-center gap-2 rounded-lg border bg-card px-3 py-3 text-sm font-medium shadow-xs">
      <Globe className="size-4 text-muted-foreground" aria-hidden />
      {data.label}
      <Handle type="source" position={Position.Right} isConnectable={false} className={hidden} />
    </div>
  )
}

const noPublicAddress = (station: string | null) =>
  `${station ? `Server ${station}` : 'The server'} has no public address yet.`

function EntryNode({ data }: NodeProps<MapNode & { type: 'entry'; data: EntryData }>) {
  const { entry, status, hostPort, station } = data
  const label =
    entry.kind === 'domain'
      ? entry.hostname
      : (entry.public ?? `Public TCP port ${hostPort ?? ''}`.trim())
  const problem = status && status.tone !== 'success' ? status : null

  return (
    <div className="flex w-72 items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-xs shadow-xs">
      <Handle type="target" position={Position.Left} isConnectable={false} className={hidden} />
      {entry.kind === 'domain' ? (
        <Globe className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      ) : (
        <Plug className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <span
        className={cn(
          'min-w-0 flex-1 truncate',
          (entry.kind === 'domain' || entry.public !== null) && 'font-mono',
        )}
        title={label}
      >
        {label}
      </span>
      <span className="shrink-0 text-muted-foreground">
        {entry.kind === 'domain' ? 'HTTPS' : `TCP ${entry.port}`}
      </span>
      {entry.kind === 'tcp' && entry.public === null && (
        <span
          className={cn('size-1.5 shrink-0 rounded-full', toneDot.warning)}
          role="img"
          title={noPublicAddress(station)}
          aria-label={noPublicAddress(station)}
        />
      )}
      {problem && (
        <span className={cn('shrink-0', toneText[problem.tone])} title={problem.label}>
          {problem.label}
        </span>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} className={hidden} />
    </div>
  )
}

function AppNode({ data }: NodeProps<MapNode & { type: 'app'; data: AppData }>) {
  const s = data.app

  return (
    <div className="w-72 rounded-lg border bg-card text-card-foreground shadow-xs">
      <Handle
        id="left"
        type="target"
        position={Position.Left}
        isConnectable={false}
        className={hidden}
      />
      <Handle
        id="top-in"
        type="target"
        position={Position.Top}
        isConnectable={false}
        className={hidden}
      />
      <Handle
        id="top-out"
        type="source"
        position={Position.Top}
        isConnectable={false}
        className={hidden}
      />
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <AppStatusDot status={s.status} />
        <Link
          {...appTo(s.id)}
          className="min-w-0 flex-1 truncate text-sm font-semibold underline-offset-4 hover:underline"
        >
          {s.name}
        </Link>
        <span className="text-xs text-muted-foreground">{appKind[s.kind]}</span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 py-2 text-xs">
        <dt className="text-muted-foreground">
          <Term name="internalName" />
        </dt>
        <dd className="truncate font-mono" title={s.dns}>
          {s.dns}
        </dd>
        <dt className="text-muted-foreground">
          <Term name="stableAddress" />
        </dt>
        <dd className="font-mono">
          {s.virtual_ip ?? <None className="font-sans">{notAssigned}</None>}
        </dd>
        <dt className="text-muted-foreground">Ports</dt>
        <dd>
          <Ports app={s} />
        </dd>
        <dt className="text-muted-foreground">Serving</dt>
        <dd>
          <Serving app={s} />
        </dd>
      </dl>
      <Handle
        id="right"
        type="source"
        position={Position.Right}
        isConnectable={false}
        className={hidden}
      />
      <Handle
        id="bottom-in"
        type="target"
        position={Position.Bottom}
        isConnectable={false}
        className={hidden}
      />
      <Handle
        id="bottom-out"
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        className={hidden}
      />
    </div>
  )
}

const peerIcon = {
  internet: Globe,
  gateway: Waypoints,
  station: Server,
  blocked: ShieldBan,
} as const

function PeerNode({ data }: NodeProps<MapNode & { type: 'peer'; data: PeerData }>) {
  const Icon = peerIcon[data.icon]

  return (
    <div
      className={cn(
        'w-60 rounded-lg border bg-card px-3 py-2 text-sm shadow-xs',
        data.tone === 'blocked' && 'border-red-300 dark:border-red-800',
      )}
    >
      {data.side === 'right' && (
        <Handle type="target" position={Position.Left} isConnectable={false} className={hidden} />
      )}
      {data.tone === 'blocked' && (
        <p className="text-xs text-muted-foreground">{explanationVerdict.blocked.label}</p>
      )}
      <div
        className={cn(
          'flex items-center gap-2 font-medium',
          data.tone === 'blocked' && toneText.danger,
        )}
      >
        <Icon className="size-4 shrink-0" aria-hidden />
        <span className="truncate" title={data.label}>
          {data.label}
        </span>
      </div>
      {data.lines.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
          {data.lines.map((line) => (
            <li key={line} className="truncate font-mono" title={line}>
              {line}
            </li>
          ))}
        </ul>
      )}
      {data.side === 'left' && (
        <Handle type="source" position={Position.Right} isConnectable={false} className={hidden} />
      )}
    </div>
  )
}

const nodeTypes: NodeTypes = {
  internet: InternetNode,
  entry: EntryNode,
  app: AppNode,
  peer: PeerNode,
}

function Legend({ live }: { live: boolean }) {
  const item = 'inline-flex items-center gap-1.5'
  const line = 'inline-block h-0 w-5 border-t-2'

  return (
    <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span className={item}>
        <span className={cn(line, 'border-t border-muted-foreground/70')} aria-hidden />
        Public route
      </span>
      <span className={item}>
        <span className={cn(line, 'border-foreground')} aria-hidden />
        Uses, through a key reference
      </span>
      {live && (
        <>
          <span className={item}>
            <span className={cn(line, 'border-(--chart-2)')} aria-hidden />
            Live traffic
          </span>
          <span className={item}>
            <span className={cn(line, 'border-dashed border-destructive')} aria-hidden />
            Blocked
          </span>
        </>
      )}
    </p>
  )
}

function Canvas({ map, live }: { map: NetworkMap; live: LiveNetwork }) {
  const { resolvedTheme } = useTheme()
  const { nodes, edges } = useMemo(() => {
    const base = layoutNetwork(map)

    return live.state === 'off' ? base : overlayLive(base, live.samples)
  }, [map, live])
  const shape = useMemo(() => nodes.map((n) => n.id).join('|'), [nodes])

  return (
    <div className="space-y-2">
      <div
        className="overflow-hidden rounded-lg border"
        style={{
          height: `clamp(20rem, ${mapHeight(nodes) + 64}px, 44rem)`,
        }}
        data-testid="network-canvas"
      >
        <ReactFlow
          key={shape}
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
          fitView
          fitViewOptions={{
            padding: 0.08,
            maxZoom: 1,
          }}
          minZoom={0.2}
          maxZoom={1.5}
          zoomOnScroll={false}
          preventScrolling={false}
          aria-label={`Network map of ${map.preview?.name ?? 'production'}${live.state === 'off' ? '' : ' with live traffic'}`}
        >
          <Background gap={20} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <Legend live={live.state !== 'off'} />
    </div>
  )
}

function InboundSummary({ map }: { map: NetworkMap }) {
  const station = map.subnets[0]?.server.name

  return (
    <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
      <div className="flex items-center gap-2">
        <dt className="text-muted-foreground">Web traffic</dt>
        <dd>{map.inbound.web_ports === 'open' ? 'Open' : 'Closed until a domain exists'}</dd>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <dt className="text-muted-foreground">Public address</dt>
        <dd className="flex flex-wrap items-center gap-2">
          {map.inbound.public_address ? (
            <Code copy={map.inbound.public_address}>{map.inbound.public_address}</Code>
          ) : (
            <>
              <span>None. Set one so domains and public TCP ports work.</span>
              {station && <Command command={commands.setPublicAddress(station)} />}
            </>
          )}
        </dd>
      </div>
    </dl>
  )
}

function TableView({ map }: { map: NetworkMap }) {
  return (
    <div className="space-y-6">
      <section className="space-y-2" aria-labelledby="network-apps">
        <h2 id="network-apps" className="text-sm font-semibold">
          Apps
        </h2>
        <TableFrame>
          <TableHeader>
            <TableRow>
              <TableHead>App</TableHead>
              <TableHead className="hidden md:table-cell">
                <Term name="internalName" />
              </TableHead>
              <TableHead className="hidden sm:table-cell">
                <Term name="stableAddress" />
              </TableHead>
              <TableHead className="hidden lg:table-cell">Ports</TableHead>
              <TableHead>Serving</TableHead>
              <TableHead className="hidden lg:table-cell">Domains</TableHead>
              <TableHead className="hidden lg:table-cell">
                <Term name="publicTcpPort">Public TCP</Term>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {map.apps.map((s) => (
              <TableRow key={s.id}>
                <TableCell>
                  <Link
                    {...appTo(s.id)}
                    className="inline-flex items-center gap-2 font-medium underline-offset-4 hover:underline"
                  >
                    <Box className="size-4 text-muted-foreground" aria-hidden />
                    {s.name}
                  </Link>
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <Code copy={s.dns}>{s.dns}</Code>
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  {s.virtual_ip ? <Code>{s.virtual_ip}</Code> : <None>{notAssigned}</None>}
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  <Ports app={s} />
                </TableCell>
                <TableCell className="whitespace-normal">
                  <Serving app={s} />
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  {s.domains.length ? (
                    s.domains.map((d) => (
                      <Code key={d.id} className="block w-fit">
                        {d.hostname}
                      </Code>
                    ))
                  ) : (
                    <None />
                  )}
                </TableCell>
                <TableCell className="hidden whitespace-normal lg:table-cell">
                  {s.exposures.length ? (
                    s.exposures.map((x) => (
                      <span key={x.id} className="block">
                        {exposureText(map, x)}
                      </span>
                    ))
                  ) : (
                    <None />
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </TableFrame>
      </section>
      <section className="space-y-3" aria-labelledby="network-inbound">
        <div>
          <h2 id="network-inbound" className="text-sm font-semibold">
            From the internet
          </h2>
          <p className="text-sm text-muted-foreground">
            Domains and public TCP ports that reach apps here.
          </p>
        </div>
        <InboundSummary map={map} />
        <TableFrame>
          <TableHeader>
            <TableRow>
              <TableHead className="hidden sm:table-cell">Kind</TableHead>
              <TableHead>Address</TableHead>
              <TableHead>App</TableHead>
              <TableHead className="hidden sm:table-cell">App port</TableHead>
              <TableHead className="hidden md:table-cell">State</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {map.inbound.entries.length === 0 && (
              <EmptyRow columns={5}>Nothing here is reachable from the internet.</EmptyRow>
            )}
            {map.inbound.entries.map((e) => {
              const svc = map.apps.find((s) => s.name === e.app)
              const domain =
                e.kind === 'domain'
                  ? svc?.domains.find((d) => d.hostname === e.hostname)
                  : undefined
              const exposure =
                e.kind === 'tcp'
                  ? svc?.exposures.find((x) => x.public === e.public && x.port === e.port)
                  : undefined
              const state = domain ? domainState(domain) : exposureState(exposure)

              return (
                <TableRow key={e.kind === 'domain' ? e.hostname : `${e.public}-${e.port}`}>
                  <TableCell className="hidden sm:table-cell">
                    {e.kind === 'domain' ? 'Domain' : 'Public TCP port'}
                  </TableCell>
                  <TableCell className="max-w-48 truncate sm:max-w-none">
                    {e.kind === 'domain' ? (
                      <Code>{e.hostname}</Code>
                    ) : e.public ? (
                      <Code>{e.public}</Code>
                    ) : exposure ? (
                      exposureText(map, exposure)
                    ) : (
                      <None>No public address</None>
                    )}
                  </TableCell>
                  <TableCell>{e.app}</TableCell>
                  <TableCell className="hidden tabular-nums sm:table-cell">{e.port}</TableCell>
                  <TableCell className={cn('hidden text-sm md:table-cell', toneText[state.tone])}>
                    {state.label}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </TableFrame>
      </section>
      <TrafficRules map={map} />
    </div>
  )
}

function TrafficRules({ map }: { map: NetworkMap }) {
  return (
    <section className="space-y-3" aria-labelledby="network-rules">
      <div className="space-y-1">
        <h2 id="network-rules" className="text-sm font-semibold">
          <Term name="trafficRule">Traffic rules</Term>
        </h2>
        <p className="text-sm text-muted-foreground">
          What apps here can reach, and what can reach them. Stationly enforces these on every
          server.
        </p>
        <ul className="flex flex-wrap gap-x-5 gap-y-1 pt-1 text-xs text-muted-foreground">
          {(['allowed', 'blocked', 'rejected'] as const).map((verdict) => {
            const Icon = verdictIcon[verdict]

            return (
              <li key={verdict} className="inline-flex items-center gap-1.5">
                <Icon className={cn('size-3.5', toneText[pathResult[verdict].tone])} aria-hidden />
                <span className="font-medium text-foreground">{pathResult[verdict].label}</span>
                {pathResult[verdict].hint}
              </li>
            )
          })}
        </ul>
      </div>
      <TrafficChart
        paths={map.paths}
        label={`Traffic rules for ${map.preview?.name ?? 'production'}`}
      />
    </section>
  )
}

function LiveTables({ live }: { live: LiveNetwork }) {
  const rows = live.samples.flatMap((s) =>
    s.connections.map((connection, i) => ({
      key: `${s.app.id}-${i}`,
      app: s.app.name,
      names: s.untrusted.names,
      connection,
    })),
  )
  const refused = live.samples.flatMap((s) =>
    s.refused.map((r, i) => ({
      key: `${s.app.id}-r${i}`,
      app: s.app.name,
      r,
    })),
  )

  return (
    <div className="space-y-6">
      <section className="space-y-2" aria-labelledby="network-live-connections">
        <div>
          <h2 id="network-live-connections" className="text-sm font-semibold">
            <Term name="liveTraffic" />
          </h2>
          <p className="text-sm text-muted-foreground">
            Open connections, updated every 5 seconds while live traffic is on.
          </p>
        </div>
        <ConnectionsTable
          live
          rows={rows}
          empty={live.at ? 'No open connections right now.' : 'Waiting for the first update…'}
        />
      </section>
      <section className="space-y-2" aria-labelledby="network-live-refused">
        <div>
          <h2 id="network-live-refused" className="text-sm font-semibold">
            Blocked attempts
          </h2>
          <p className="text-sm text-muted-foreground">
            Connections a traffic rule stopped in the last 10 minutes.
          </p>
        </div>
        <TableFrame>
          <TableHeader>
            <TableRow>
              <TableHead>App</TableHead>
              <TableHead>Tried to reach</TableHead>
              <TableHead className="hidden sm:table-cell">Rule</TableHead>
              <TableHead className="hidden text-right sm:table-cell">Attempts</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {refused.length === 0 && (
              <EmptyRow columns={4}>Nothing was blocked in the last 10 minutes.</EmptyRow>
            )}
            {refused.map(({ key, app, r }) => (
              <TableRow key={key}>
                <TableCell>{app}</TableCell>
                <TableCell>
                  <Code>{endpointText(r)}</Code>
                  <span className="block text-xs text-muted-foreground sm:hidden">
                    {pathLabel[r.path]}
                  </span>
                </TableCell>
                <TableCell className="hidden whitespace-normal sm:table-cell" title={r.path}>
                  {pathLabel[r.path]}
                </TableCell>
                <TableCell className="hidden text-right tabular-nums sm:table-cell">
                  {r.count}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </TableFrame>
      </section>
    </div>
  )
}

function LiveState({ live }: { live: LiveNetwork }) {
  if (live.state === 'connecting') {
    return <>Connecting…</>
  }

  if (live.state === 'offline') {
    return <>Live traffic stopped. Turn it on again to reconnect.</>
  }

  if (live.state === 'live') {
    return live.at ? (
      <Time value={live.at} live prefix="Updated" />
    ) : (
      <>Waiting for the first update…</>
    )
  }

  return null
}

function LiveToggle({
  enabled,
  onChange,
  live,
}: {
  enabled: boolean
  onChange: (next: boolean) => void
  live: LiveNetwork
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <div className="flex items-center gap-2">
        <Switch id="network-live" checked={enabled} onCheckedChange={onChange} />
        <Label htmlFor="network-live" className="text-sm font-normal">
          Show live traffic
        </Label>
      </div>
      <span className="text-xs text-muted-foreground" role="status" aria-live="polite">
        {enabled ? <LiveState live={live} /> : 'Updates every 5 s'}
        {enabled && live.problem ? ` · ${live.problem}` : ''}
      </span>
    </div>
  )
}

function Addresses({ map }: { map: NetworkMap }) {
  return (
    <HoverCard openDelay={150}>
      <HoverCardTrigger asChild>
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Network addresses">
          <Info />
        </Button>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-80">
        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5 text-xs">
          {map.subnets.map((s) => (
            <div key={`${s.server.id}-${s.subnet}`} className="contents">
              <dt className="text-muted-foreground">Subnet on {s.server.name}</dt>
              <dd>
                <Code copy={s.subnet}>{s.subnet}</Code>
              </dd>
              <dt className="text-muted-foreground">Name server</dt>
              <dd>
                <Code copy={s.resolver}>{s.resolver}</Code>
              </dd>
            </div>
          ))}
          <dt className="text-muted-foreground">Stable address range</dt>
          <dd>
            <Code copy={map.virtual_prefix}>{map.virtual_prefix}</Code>
          </dd>
        </dl>
      </HoverCardContent>
    </HoverCard>
  )
}

function Summary({ map }: { map: NetworkMap }) {
  if (map.subnets.length === 0) {
    return null
  }

  return (
    <div className="space-y-1 text-sm">
      {map.subnets.map((s, i) => (
        <p key={`${s.server.id}-${s.subnet}`} className="flex flex-wrap items-center gap-x-1.5">
          <Network className="size-4 text-muted-foreground" aria-hidden />
          <span>
            Network on <span className="font-medium">{s.server.name}</span>
          </span>
          {s.stale ? (
            <span className={toneText.warning}>
              {s.observed_at
                ? `· Server ${s.server.name} last reported ${ago(s.observed_at)}. Addresses may be out of date.`
                : `· Server ${s.server.name} hasn’t reported its network yet.`}
            </span>
          ) : (
            <span className="text-muted-foreground">
              · <Time value={s.observed_at} prefix="updated" />
            </span>
          )}
          {i === 0 && <Addresses map={map} />}
        </p>
      ))}
    </div>
  )
}

function Warnings({ map, scope }: { map: NetworkMap; scope: Scope }) {
  if (map.warnings.length === 0) {
    return null
  }

  return (
    <Alert>
      <CircleAlert className={toneText.warning} />
      <AlertTitle>
        {plural(map.warnings.length, 'thing')} {map.warnings.length === 1 ? 'needs' : 'need'}{' '}
        attention
      </AlertTitle>
      <AlertDescription>
        <ul className="space-y-1.5">
          {map.warnings.map((w, i) => {
            const plan = findingPlan(w, map.apps, scope)

            return (
              <li key={`${w.code}-${i}`} className="space-y-1.5">
                <p>
                  <span className="font-medium text-foreground">{finding[w.code]}.</span>{' '}
                  {w.explanation}{' '}
                  <span className="font-mono text-xs text-muted-foreground">{w.code}</span>
                </p>
                {plan && <FixActions plan={plan} primary={false} />}
              </li>
            )
          })}
        </ul>
      </AlertDescription>
    </Alert>
  )
}

export function NetworkPanel({ place }: { place: PlaceView }) {
  const { data: map } = useSuspenseQuery(networkQuery(place))
  const [view, setView] = useState<'map' | 'table'>('map')
  const [liveOn, setLiveOn] = useState(false)
  const [creating, setCreating] = useState(false)
  const live = useLiveNetwork(place, liveOn)

  return (
    <div className="space-y-4">
      <Summary map={map} />
      <Warnings map={map} scope={scopeOf(place)} />
      <Tabs value={view} onValueChange={(value) => setView(value as 'map' | 'table')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList aria-label="Network view">
            <TabsTrigger value="map">Map</TabsTrigger>
            <TabsTrigger value="table">Table</TabsTrigger>
          </TabsList>
          <LiveToggle enabled={liveOn} onChange={setLiveOn} live={live} />
        </div>
        <TabsContent value="map" className="mt-3 space-y-6">
          {map.apps.length === 0 ? (
            <EmptyState
              icon={Network}
              title="No apps yet"
              description="Apps you create here appear on the map with their routes."
              action={
                <Button size="sm" onClick={() => setCreating(true)}>
                  <Plus /> New app
                </Button>
              }
            />
          ) : (
            <Canvas map={map} live={live} />
          )}
          <TrafficRules map={map} />
        </TabsContent>
        <TabsContent value="table" className="mt-3 space-y-6">
          {liveOn && <LiveTables live={live} />}
          <TableView map={map} />
        </TabsContent>
      </Tabs>
      {creating && <NewApp place={place} open={creating} onOpenChange={setCreating} />}
    </div>
  )
}
