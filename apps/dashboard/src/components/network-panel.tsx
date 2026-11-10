import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Background, Controls, Handle, Position, ReactFlow, type NodeProps, type NodeTypes } from '@xyflow/react'
import { Activity, Box, CircleAlert, Globe, Network, Plug, Server, ShieldBan, ShieldCheck, Undo2, Waypoints } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useMemo, useState } from 'react'
import { ConnectionsTable } from '@/components/connections-table'
import { Mono } from '@/components/page'
import { QueryState } from '@/components/query-state'
import { EmptyRow, TableFrame } from '@/components/table-frame'
import { ServiceStatusDot } from '@/components/status'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import type { Environment, NetworkMap } from '@/lib/api'
import { ago } from '@/lib/format'
import {
  ageText,
  endpointText,
  layoutNetwork,
  overlayLive,
  portSpecText,
  type EntryData,
  type InternetData,
  type MapNode,
  type MapService,
  type PeerData,
  type ServiceData
} from '@/lib/network-layout'
import { useLiveNetwork, type LiveNetwork } from '@/lib/network-live'
import { networkQuery } from '@/lib/queries'
import { toneOutline, toneText, type Tone } from '@/lib/tone'
import { cn } from '@/lib/utils'

const hidden = '!size-1 !min-h-0 !min-w-0 !border-0 !bg-transparent'

const switchText = (sw: MapService['switch']) => {
  if (!sw.deployment) return 'no target'
  return `#${sw.deployment.number}${sw.deployment.address ? ` ${sw.deployment.address}` : ''}`
}

const switchTone: Record<MapService['switch']['state'], Tone> = {
  serving: 'success',
  pending: 'warning',
  mismatch: 'danger',
  no_target: 'neutral'
}

function SwitchBadge({ sw }: { sw: MapService['switch'] }) {
  return (
    <Badge variant="outline" className={cn('font-normal', toneOutline[switchTone[sw.state]])}>
      {sw.state.replace('_', ' ')}
    </Badge>
  )
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

function EntryNode({ data }: NodeProps<MapNode & { type: 'entry'; data: EntryData }>) {
  const { entry, status } = data
  const label = entry.kind === 'domain' ? entry.hostname : (entry.public ?? 'no public address')
  return (
    <div className="flex w-72 items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-xs shadow-xs">
      <Handle type="target" position={Position.Left} isConnectable={false} className={hidden} />
      {entry.kind === 'domain' ? <Globe className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /> : <Plug className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
      <span className="min-w-0 flex-1 truncate font-mono" title={label}>
        {label}
      </span>
      <span className="shrink-0 text-muted-foreground">{entry.kind === 'domain' ? `:${entry.port}` : `→ ${entry.port}`}</span>
      {status && status !== 'active' && status !== 'ok' && <span className={cn('shrink-0', toneText.warning)}>{status}</span>}
      <Handle type="source" position={Position.Right} isConnectable={false} className={hidden} />
    </div>
  )
}

function ServiceNode({ data }: NodeProps<MapNode & { type: 'service'; data: ServiceData }>) {
  const s = data.service
  return (
    <div className="w-72 rounded-lg border bg-card text-card-foreground shadow-xs">
      <Handle id="left" type="target" position={Position.Left} isConnectable={false} className={hidden} />
      <Handle id="top-in" type="target" position={Position.Top} isConnectable={false} className={hidden} />
      <Handle id="top-out" type="source" position={Position.Top} isConnectable={false} className={hidden} />
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <ServiceStatusDot status={s.status} />
        <Link to="/services/$service" params={{ service: s.id }} className="min-w-0 flex-1 truncate text-sm font-semibold underline-offset-4 hover:underline">
          {s.name}
        </Link>
        <span className="text-xs text-muted-foreground">{s.kind}</span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-3 py-2 text-xs">
        <dt className="text-muted-foreground">DNS</dt>
        <dd className="truncate font-mono" title={s.dns}>
          {s.dns}
        </dd>
        <dt className="text-muted-foreground">VIP</dt>
        <dd className="font-mono">{s.virtual_ip ?? '—'}</dd>
        <dt className="text-muted-foreground">Ports</dt>
        <dd className="font-mono">{s.ports.length ? s.ports.map(portSpecText).join(' ') : '—'}</dd>
        <dt className="text-muted-foreground">Switch</dt>
        <dd className="flex flex-wrap items-center gap-1">
          <span className="font-mono">{switchText(s.switch)}</span>
          {s.switch.state !== 'serving' && s.switch.state !== 'no_target' && <SwitchBadge sw={s.switch} />}
          {s.switch.draining && (
            <Badge variant="outline" className={cn('font-normal', toneOutline.info)}>
              draining #{s.switch.draining.number}
            </Badge>
          )}
        </dd>
      </dl>
      <Handle id="right" type="source" position={Position.Right} isConnectable={false} className={hidden} />
      <Handle id="bottom-in" type="target" position={Position.Bottom} isConnectable={false} className={hidden} />
      <Handle id="bottom-out" type="source" position={Position.Bottom} isConnectable={false} className={hidden} />
    </div>
  )
}

const peerIcon = { internet: Globe, gateway: Waypoints, station: Server, blocked: ShieldBan } as const

function PeerNode({ data }: NodeProps<MapNode & { type: 'peer'; data: PeerData }>) {
  const Icon = peerIcon[data.icon]
  return (
    <div className={cn('w-60 rounded-lg border bg-card px-3 py-2 text-sm shadow-xs', data.tone === 'blocked' && 'border-red-300 dark:border-red-800')}>
      {data.side === 'right' && <Handle type="target" position={Position.Left} isConnectable={false} className={hidden} />}
      <div className={cn('flex items-center gap-2 font-medium', data.tone === 'blocked' && toneText.danger)}>
        <Icon className="size-4 shrink-0" aria-hidden />
        <span className="truncate">{data.label}</span>
      </div>
      {data.lines.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
          {data.lines.map(line => (
            <li key={line} className="truncate font-mono" title={line}>
              {line}
            </li>
          ))}
        </ul>
      )}
      {data.side === 'left' && <Handle type="source" position={Position.Right} isConnectable={false} className={hidden} />}
    </div>
  )
}

const nodeTypes: NodeTypes = { internet: InternetNode, entry: EntryNode, service: ServiceNode, peer: PeerNode }

function Canvas({ map, live }: { map: NetworkMap; live: LiveNetwork }) {
  const { resolvedTheme } = useTheme()
  const { nodes, edges } = useMemo(() => {
    const base = layoutNetwork(map)
    return live.state === 'off' ? base : overlayLive(base, live.samples)
  }, [map, live])
  const shape = useMemo(() => nodes.map(n => n.id).join('|'), [nodes])
  return (
    <div className="h-[28rem] overflow-hidden rounded-lg border sm:h-[32rem]" data-testid="network-canvas">
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
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.2}
        maxZoom={1.5}
        aria-label={`Network map of ${map.environment.name}${live.state === 'off' ? '' : ' with live connections'}`}
      >
        <Background gap={20} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}

const verdictIcon = { allowed: ShieldCheck, blocked: ShieldBan, rejected: Undo2 } as const
const verdictTone = { allowed: toneText.success, blocked: toneText.danger, rejected: toneText.warning } as const

function TableView({ map }: { map: NetworkMap }) {
  return (
    <div className="space-y-6">
      <section className="space-y-2" aria-labelledby="network-services">
        <h2 id="network-services" className="text-sm font-semibold">
          Services
        </h2>
        <TableFrame>
          <TableHeader>
            <TableRow>
              <TableHead>Service</TableHead>
              <TableHead className="hidden md:table-cell">DNS name</TableHead>
              <TableHead className="hidden sm:table-cell">Virtual IP</TableHead>
              <TableHead className="hidden lg:table-cell">Ports</TableHead>
              <TableHead>Switch</TableHead>
              <TableHead className="hidden lg:table-cell">Domains</TableHead>
              <TableHead className="hidden lg:table-cell">TCP</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {map.services.map(s => (
              <TableRow key={s.id}>
                <TableCell>
                  <Link to="/services/$service" params={{ service: s.id }} className="inline-flex items-center gap-2 font-medium underline-offset-4 hover:underline">
                    <Box className="size-4 text-muted-foreground" aria-hidden />
                    {s.name}
                  </Link>
                </TableCell>
                <TableCell className="hidden md:table-cell">
                  <Mono>{s.dns}</Mono>
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <Mono>{s.virtual_ip ?? '—'}</Mono>
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  <Mono>{s.ports.map(portSpecText).join(', ') || '—'}</Mono>
                </TableCell>
                <TableCell className="whitespace-normal">
                  <span className="flex flex-wrap items-center gap-1">
                    {s.switch.deployment && <Mono>{switchText(s.switch)}</Mono>}
                    <SwitchBadge sw={s.switch} />
                    {s.switch.draining && (
                      <span className="text-xs text-muted-foreground">
                        draining #{s.switch.draining.number}
                        {s.switch.draining.address ? ` ${s.switch.draining.address}` : ''}
                      </span>
                    )}
                  </span>
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  {s.domains.length ? (
                    s.domains.map(d => (
                      <Mono key={d.id} className="block">
                        {d.hostname}
                      </Mono>
                    ))
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  {s.exposures.length ? (
                    s.exposures.map(x => <Mono key={x.id} className="block">{`${x.public ?? `:${x.host_port}`} → ${x.port}`}</Mono>)
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </TableFrame>
      </section>
      <section className="space-y-2" aria-labelledby="network-inbound">
        <h2 id="network-inbound" className="text-sm font-semibold">
          Inbound
        </h2>
        <p className="text-sm text-muted-foreground">
          Web ports {map.inbound.web_ports} · public address <Mono>{map.inbound.public_address ?? 'not set'}</Mono>
        </p>
        <TableFrame>
          <TableHeader>
            <TableRow>
              <TableHead className="hidden sm:table-cell">Kind</TableHead>
              <TableHead>Entry</TableHead>
              <TableHead>Service</TableHead>
              <TableHead className="hidden sm:table-cell">Port</TableHead>
              <TableHead className="hidden md:table-cell">State</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {map.inbound.entries.length === 0 && <EmptyRow columns={5}>Nothing in this environment is reachable from the internet.</EmptyRow>}
            {map.inbound.entries.map(e => {
              const svc = map.services.find(s => s.name === e.service)
              const domain = e.kind === 'domain' ? svc?.domains.find(d => d.hostname === e.hostname) : undefined
              const exposure = e.kind === 'tcp' ? svc?.exposures.find(x => x.public === e.public && x.port === e.port) : undefined
              return (
                <TableRow key={e.kind === 'domain' ? e.hostname : `${e.public}-${e.port}`}>
                  <TableCell className="hidden sm:table-cell">{e.kind === 'domain' ? 'Domain' : 'TCP'}</TableCell>
                  <TableCell className="max-w-48 truncate sm:max-w-none">
                    <Mono>{e.kind === 'domain' ? e.hostname : (e.public ?? 'no public address')}</Mono>
                  </TableCell>
                  <TableCell>{e.service}</TableCell>
                  <TableCell className="hidden tabular-nums sm:table-cell">{e.port}</TableCell>
                  <TableCell className="hidden text-sm md:table-cell">
                    {domain
                      ? `${domain.status}, certificate ${domain.certificate.status}, route ${domain.route.result ?? 'not reported'}`
                      : `${exposure?.status ?? '—'}, ${exposure?.result ?? 'not reported'}`}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </TableFrame>
      </section>
      <PathsTable map={map} />
    </div>
  )
}

function PathsTable({ map }: { map: NetworkMap }) {
  return (
    <section className="space-y-2" aria-labelledby="network-paths">
      <h2 id="network-paths" className="text-sm font-semibold">
        Paths
      </h2>
      <TableFrame>
        <TableHeader>
          <TableRow>
            <TableHead>Path</TableHead>
            <TableHead className="hidden md:table-cell">From</TableHead>
            <TableHead>To</TableHead>
            <TableHead>Verdict</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {map.paths.map(p => {
            const Icon = verdictIcon[p.verdict]
            return (
              <TableRow key={p.path}>
                <TableCell>
                  <Mono>{p.path}</Mono>
                </TableCell>
                <TableCell className="hidden text-muted-foreground md:table-cell">{p.from}</TableCell>
                <TableCell className="whitespace-normal sm:min-w-56">{p.to}</TableCell>
                <TableCell>
                  <span className={cn('inline-flex items-center gap-1.5 text-sm font-medium', verdictTone[p.verdict])}>
                    <Icon className="size-4" aria-hidden />
                    {p.verdict}
                  </span>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </TableFrame>
    </section>
  )
}

function LiveTables({ live }: { live: LiveNetwork }) {
  const rows = live.samples.flatMap(s => s.connections.map((connection, i) => ({ key: `${s.service.id}-${i}`, service: s.service.name, names: s.untrusted.names, connection })))
  const refused = live.samples.flatMap(s => s.refused.map((r, i) => ({ key: `${s.service.id}-r${i}`, service: s.service.name, r })))
  return (
    <div className="space-y-6">
      <section className="space-y-2" aria-labelledby="network-live-connections">
        <h2 id="network-live-connections" className="text-sm font-semibold">
          Live connections
        </h2>
        <ConnectionsTable live rows={rows} empty={live.at ? 'No open connections in the last sample.' : 'Waiting for the first sample.'} />
      </section>
      <section className="space-y-2" aria-labelledby="network-live-refused">
        <h2 id="network-live-refused" className="text-sm font-semibold">
          Refused attempts
        </h2>
        <TableFrame>
          <TableHeader>
            <TableRow>
              <TableHead>Service</TableHead>
              <TableHead>Path</TableHead>
              <TableHead className="hidden sm:table-cell">Destination</TableHead>
              <TableHead className="hidden sm:table-cell">Count</TableHead>
              <TableHead className="hidden md:table-cell">Expires in</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {refused.length === 0 && <EmptyRow columns={5}>No refused attempts recorded.</EmptyRow>}
            {refused.map(({ key, service, r }) => (
              <TableRow key={key}>
                <TableCell>{service}</TableCell>
                <TableCell>
                  <Mono className="block">{r.path}</Mono>
                  <Mono className="block text-muted-foreground sm:hidden">{endpointText(r)}</Mono>
                </TableCell>
                <TableCell className="hidden sm:table-cell">
                  <Mono>{endpointText(r)}</Mono>
                </TableCell>
                <TableCell className="hidden tabular-nums sm:table-cell">{r.count}</TableCell>
                <TableCell className="hidden tabular-nums md:table-cell">{ageText(r.expires_in_s)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </TableFrame>
      </section>
    </div>
  )
}

const liveStateText = (live: LiveNetwork) => {
  if (live.state === 'connecting') return 'Connecting…'
  if (live.state === 'offline') return 'Live stream closed'
  if (live.state === 'live') return live.at ? `Sample at ${new Date(live.at).toLocaleTimeString()}` : 'Waiting for the first sample'
  return ''
}

function LiveToggle({ enabled, onChange, live }: { enabled: boolean; onChange: (next: boolean) => void; live: LiveNetwork }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant={enabled ? 'secondary' : 'outline'} size="sm" aria-pressed={enabled} onClick={() => onChange(!enabled)}>
        <Activity aria-hidden />
        Live
      </Button>
      {enabled && (
        <span className="text-xs text-muted-foreground" role="status" aria-live="polite">
          {liveStateText(live)}
          {live.problem ? ` · ${live.problem}` : ''}
        </span>
      )}
    </div>
  )
}

function Summary({ map }: { map: NetworkMap }) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-2 rounded-lg border bg-card px-4 py-3 text-sm">
      {map.subnets.length === 0 && <span className="text-muted-foreground">No subnet is allocated until the environment has a service.</span>}
      {map.subnets.map(s => (
        <span key={`${s.station.id}-${s.subnet}`} className="inline-flex flex-wrap items-center gap-x-2">
          <Network className="size-4 text-muted-foreground" aria-hidden />
          <Mono>{s.subnet}</Mono>
          <span className="text-muted-foreground">
            on {s.station.name}, resolver <Mono>{s.resolver}</Mono>
          </span>
          {s.stale ? (
            <Badge variant="outline" className={cn('font-normal', toneOutline.warning)}>
              stale{s.observed_at ? `, reported ${ago(s.observed_at)}` : ', never reported'}
            </Badge>
          ) : (
            <span className="text-xs text-muted-foreground">reported {ago(s.observed_at)}</span>
          )}
        </span>
      ))}
      <span className="text-muted-foreground">
        virtual prefix <Mono>{map.virtual_prefix}</Mono>
      </span>
    </div>
  )
}

function Warnings({ map }: { map: NetworkMap }) {
  if (map.warnings.length === 0) return null
  return (
    <Alert>
      <CircleAlert />
      <AlertTitle>
        {map.warnings.length} network {map.warnings.length === 1 ? 'finding' : 'findings'}
      </AlertTitle>
      <AlertDescription>
        <ul className="space-y-1">
          {map.warnings.map((w, i) => (
            <li key={`${w.code}-${i}`}>
              <Mono className="mr-2 text-foreground">{w.code}</Mono>
              {w.explanation}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  )
}

export function NetworkPanel({ environment }: { environment: Environment }) {
  const network = useQuery(networkQuery(environment.id))
  return (
    <QueryState query={network} rows={4} errorTitle="The network map could not be loaded">
      {map => <NetworkView environment={environment} map={map} />}
    </QueryState>
  )
}

function NetworkView({ environment, map }: { environment: Environment; map: NetworkMap }) {
  const [view, setView] = useState<'map' | 'table'>('map')
  const [liveOn, setLiveOn] = useState(false)
  const live = useLiveNetwork(environment.id, liveOn)
  return (
    <div className="space-y-4">
      <Summary map={map} />
      <Warnings map={map} />
      <Tabs value={view} onValueChange={value => setView(value as 'map' | 'table')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList aria-label="Network view">
            <TabsTrigger value="map">Map</TabsTrigger>
            <TabsTrigger value="table">Table</TabsTrigger>
          </TabsList>
          <LiveToggle enabled={liveOn} onChange={setLiveOn} live={live} />
        </div>
        <TabsContent value="map" className="mt-3 space-y-6">
          {map.services.length === 0 ? <p className="text-sm text-muted-foreground">This environment has no services yet.</p> : <Canvas map={map} live={live} />}
          <PathsTable map={map} />
        </TabsContent>
        <TabsContent value="table" className="mt-3 space-y-6">
          {liveOn && <LiveTables live={live} />}
          <TableView map={map} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
