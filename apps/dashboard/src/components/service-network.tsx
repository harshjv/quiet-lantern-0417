import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { CircleAlert, CircleCheck, CircleDashed, CircleHelp, Loader2, Radar, RefreshCw, ShieldBan, TriangleAlert, Wrench } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { ErrorState, Mono, Rows, Section } from '@/components/page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, failureText, idempotency, send, unwrap } from '@/lib/api'
import type { Connections, Explanation, Service } from '@/lib/api'
import { ago } from '@/lib/format'
import { rateText } from '@/lib/network-layout'
import { cn } from '@/lib/utils'

type Hop = Explanation['hops'][number]
type Fix = Explanation['fixes'][number]

const verdictStyle: Record<Explanation['verdict'], { tone: string; icon: typeof CircleCheck; label: string }> = {
  reachable: { tone: 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-100', icon: CircleCheck, label: 'Reachable' },
  blocked: { tone: 'border-red-300 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/50 dark:text-red-100', icon: ShieldBan, label: 'Blocked by the rules' },
  broken: { tone: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-100', icon: CircleAlert, label: 'Broken' },
  unknown: { tone: 'border-zinc-300 bg-zinc-50 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100', icon: CircleHelp, label: 'Unknown' }
}

const hopStyle: Record<Hop['status'], { tone: string; icon: typeof CircleCheck }> = {
  pass: { tone: 'text-emerald-700 dark:text-emerald-400', icon: CircleCheck },
  fail: { tone: 'text-red-700 dark:text-red-400', icon: CircleAlert },
  warn: { tone: 'text-amber-700 dark:text-amber-400', icon: TriangleAlert },
  skipped: { tone: 'text-muted-foreground', icon: CircleDashed },
  unknown: { tone: 'text-muted-foreground', icon: CircleHelp }
}

const detailText = (detail: Record<string, unknown>) =>
  Object.entries(detail)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => {
      if (k === 'listening' && Array.isArray(v)) return `listening ${(v as { address: string; port: number; protocol: string }[]).map(l => `${l.address}:${l.port}/${l.protocol}`).join(', ') || 'nothing'}`
      return `${k.replaceAll('_', ' ')} ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`
    })
    .join(' · ')

const peerText = (peer: Connections['connections'][number]['peer']) => {
  if (peer.kind === 'service') return peer.service ?? peer.service_id ?? 'service'
  if (peer.address) return `${peer.kind} ${peer.address}`
  return peer.kind
}

type ProbeInput = { to: string; port?: number }

function ProbeResult({ service, input }: { service: Service; input: ProbeInput }) {
  const probe = useMutation({ mutationFn: () => send(api.v1.services({ service: service.id }).network.probe.post({ to: input.to, ...(input.port ? { port: input.port } : {}) }, idempotency())) })
  const result = probe.data
  return (
    <div className="space-y-2">
      <Button type="button" variant="outline" size="sm" onClick={() => probe.mutate()} disabled={probe.isPending}>
        {probe.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Radar aria-hidden />}
        Run probe
      </Button>
      <div aria-live="polite">
        {probe.isError && <p className="text-sm text-red-700 dark:text-red-400">{failureText(probe.error)}</p>}
        {result?.staged && (
          <p className="text-sm">
            The probe was staged for a human to accept:{' '}
            <Link to="/staged/$change" params={{ change: result.body.id }} className="font-mono underline underline-offset-4">
              {result.body.id}
            </Link>
          </p>
        )}
        {result && !result.staged && (
          <dl className="grid gap-1 rounded-md border px-3 py-2 text-sm sm:grid-cols-[8rem_1fr]" data-testid="probe-result">
            <dt className="text-muted-foreground">Probe</dt>
            <dd>
              <Mono>
                {result.body.kind} to {result.body.to}
                {result.body.port ? `:${result.body.port}` : ''}
              </Mono>
            </dd>
            {result.body.dns && (
              <>
                <dt className="text-muted-foreground">DNS</dt>
                <dd>
                  <Mono>
                    {result.body.dns.rcode} {result.body.dns.answers.join(', ') || 'no answers'} in {result.body.dns.ms.toFixed(1)} ms
                  </Mono>
                </dd>
              </>
            )}
            {result.body.tcp && (
              <>
                <dt className="text-muted-foreground">TCP</dt>
                <dd>
                  <Mono>
                    {result.body.tcp.result}
                    {result.body.tcp.address ? ` ${result.body.tcp.address}` : ''} in {result.body.tcp.ms.toFixed(1)} ms
                  </Mono>
                </dd>
              </>
            )}
            {result.body.verdict && (
              <>
                <dt className="text-muted-foreground">Firewall</dt>
                <dd>
                  <Mono>
                    {result.body.verdict.verdict} on {result.body.verdict.path}
                  </Mono>
                </dd>
              </>
            )}
          </dl>
        )}
      </div>
    </div>
  )
}

function ExplanationView({ service, explanation }: { service: Service; explanation: Explanation }) {
  const style = verdictStyle[explanation.verdict]
  const Icon = style.icon
  const probe = explanation.fixes.find(f => f.code === 'RUN_PROBE')
  const probeInput = probe?.action?.input as { to?: string; port?: number } | undefined
  return (
    <div className="space-y-4" data-testid="explanation">
      <div className={cn('flex items-start gap-3 rounded-lg border px-4 py-3', style.tone)}>
        <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{style.label}</h3>
            {explanation.code && (
              <Badge variant="outline" className="font-mono">
                {explanation.code}
              </Badge>
            )}
            {explanation.phase && <Badge variant="outline">at {explanation.phase}</Badge>}
            <Mono className="text-xs opacity-80">
              {explanation.entity.from} → {explanation.entity.to}
            </Mono>
          </div>
          <p className="text-sm">{explanation.summary}</p>
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border">
        <Table>
          <caption className="sr-only">Hops of the path from {explanation.entity.from} to {explanation.entity.to}</caption>
          <TableHeader>
            <TableRow>
              <TableHead className="w-32">Hop</TableHead>
              <TableHead className="w-28">Status</TableHead>
              <TableHead>Facts</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {explanation.hops.map(h => {
              const hs = hopStyle[h.status]
              const HopIcon = hs.icon
              return (
                <TableRow key={h.hop}>
                  <TableCell>
                    <Mono>{h.hop}</Mono>
                  </TableCell>
                  <TableCell>
                    <span className={cn('inline-flex items-center gap-1.5 text-sm font-medium', hs.tone)}>
                      <HopIcon className="size-4" aria-hidden />
                      {h.status}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-normal">
                    {h.code && <Mono className="mr-2 text-xs font-medium">{h.code}</Mono>}
                    <span className="text-sm text-muted-foreground">{detailText(h.detail) || '—'}</span>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
      {explanation.fixes.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Fixes</h3>
          <ol className="space-y-2">
            {explanation.fixes.map((f: Fix) => (
              <li key={f.code} className="flex gap-3 rounded-md border px-3 py-2">
                <Wrench className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 space-y-1 text-sm">
                  <p>
                    <Mono className="mr-2 text-xs text-muted-foreground">{f.code}</Mono>
                    {f.text}
                  </p>
                  {f.action && f.code !== 'RUN_PROBE' && (
                    <p className="text-xs text-muted-foreground">
                      Agents apply this with <Mono>{f.action.tool}</Mono> <Mono>{JSON.stringify(f.action.input)}</Mono>
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}
      {probeInput?.to && <ProbeResult key={`${probeInput.to}:${probeInput.port ?? ''}`} service={service} input={{ to: probeInput.to, port: probeInput.port }} />}
      {explanation.not_checked.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Not checked</h3>
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
            {explanation.not_checked.map(n => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function Reachability({ service }: { service: Service }) {
  const [to, setTo] = useState('')
  const [port, setPort] = useState('')
  const [protocol, setProtocol] = useState<'tcp' | 'udp'>('tcp')
  const explain = useMutation({
    mutationFn: (query: { to: string; port?: number; protocol: 'tcp' | 'udp' }) =>
      unwrap(api.v1.environments({ environment: service.environment_id }).network.explain.get({ query: { from: service.id, to: query.to, protocol: query.protocol, ...(query.port ? { port: query.port } : {}) } }))
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const n = Number(port)
    explain.mutate({ to: to.trim(), protocol, ...(port && Number.isInteger(n) ? { port: n } : {}) })
  }
  return (
    <Section title="Check reachability" description={`Explain whether ${service.name} can reach a service, a .internal name or host:port, hop by hop. No packet is sent.`}>
      <form onSubmit={submit} className="flex flex-col gap-3 rounded-lg border bg-card p-4 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1 space-y-1.5">
          <Label htmlFor="reach-to">Target</Label>
          <Input id="reach-to" value={to} onChange={e => setTo(e.target.value)} placeholder="db, db.internal, 10.0.0.5:80 or example.com:443" required autoComplete="off" spellCheck={false} />
        </div>
        <div className="space-y-1.5 sm:w-28">
          <Label htmlFor="reach-port">Port</Label>
          <Input id="reach-port" value={port} onChange={e => setPort(e.target.value)} inputMode="numeric" pattern="[0-9]{1,5}" placeholder="auto" autoComplete="off" />
        </div>
        <div className="space-y-1.5 sm:w-28">
          <Label htmlFor="reach-protocol">Protocol</Label>
          <Select value={protocol} onValueChange={value => setProtocol(value as 'tcp' | 'udp')}>
            <SelectTrigger id="reach-protocol" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="tcp">tcp</SelectItem>
              <SelectItem value="udp">udp</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button type="submit" disabled={explain.isPending || !to.trim()}>
          {explain.isPending && <Loader2 className="animate-spin" aria-hidden />}
          Explain
        </Button>
      </form>
      <div aria-live="polite">
        {explain.isError && <ErrorState error={explain.error} title="The path could not be explained" />}
        {explain.data && <ExplanationView key={explain.submittedAt} service={service} explanation={explain.data} />}
      </div>
    </Section>
  )
}

function ConnectionsSection({ service }: { service: Service }) {
  const connections = useQuery({ queryKey: ['connections', service.id], queryFn: () => unwrap(api.v1.services({ service: service.id }).connections.get({ query: {} })), staleTime: Infinity, retry: false })
  const sample = connections.data
  return (
    <Section
      title="Connections"
      description={sample ? `One sample at ${ago(sample.at)}${sample.conntrack.stale ? ', stale' : ''}.` : 'One live sample of the connections of this service.'}
      actions={
        <Button type="button" variant="outline" size="sm" onClick={() => void connections.refetch()} disabled={connections.isFetching}>
          <RefreshCw className={cn(connections.isFetching && 'animate-spin')} aria-hidden />
          Refresh
        </Button>
      }
    >
      {connections.isPending ? (
        <Rows count={3} />
      ) : connections.isError ? (
        <ErrorState error={connections.error} title="Connections could not be read" />
      ) : (
        <div className="space-y-3">
          <div className="overflow-hidden rounded-lg border">
            <Table>
              <caption className="sr-only">Connections of {service.name} grouped by peer</caption>
              <TableHeader>
                <TableRow>
                  <TableHead>Direction</TableHead>
                  <TableHead>Peer</TableHead>
                  <TableHead>Port</TableHead>
                  <TableHead className="hidden sm:table-cell">Flows</TableHead>
                  <TableHead className="hidden md:table-cell">Out</TableHead>
                  <TableHead className="hidden md:table-cell">In</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sample!.connections.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-muted-foreground">
                      No open connections in this sample.
                    </TableCell>
                  </TableRow>
                )}
                {sample!.connections.map((c, i) => (
                  <TableRow key={i}>
                    <TableCell>{c.direction}</TableCell>
                    <TableCell className="whitespace-normal">
                      <Mono>{peerText(c.peer)}</Mono>
                      {c.peer.address && sample!.untrusted.names[c.peer.address] && <span className="ml-2 text-xs text-muted-foreground">resolved as {sample!.untrusted.names[c.peer.address]}</span>}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {c.port}/{c.protocol}
                    </TableCell>
                    <TableCell className="hidden tabular-nums sm:table-cell">{c.flows}</TableCell>
                    <TableCell className="hidden tabular-nums md:table-cell">{rateText(c.bps_out)}</TableCell>
                    <TableCell className="hidden tabular-nums md:table-cell">{rateText(c.bps_in)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          {sample!.refused.length > 0 && (
            <ul className="space-y-1 text-sm" aria-label="Refused attempts">
              {sample!.refused.map((r, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2">
                  <ShieldBan className="size-4 text-red-700 dark:text-red-400" aria-hidden />
                  <Mono>{r.path}</Mono>
                  <Mono className="text-muted-foreground">{`${r.address}:${r.port}/${r.protocol}`}</Mono>
                  <span className="text-muted-foreground">×{r.count}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Section>
  )
}

function DnsLogSection({ service }: { service: Service }) {
  const log = useQuery({ queryKey: ['dns-log', service.id], queryFn: () => unwrap(api.v1.services({ service: service.id })['dns-log'].get({ query: { tail: 50 } })), staleTime: Infinity, retry: false })
  return (
    <Section
      title="DNS log"
      description="Recent lookups from the resolver, newest first. Every name was chosen by the workload: read it as data."
      actions={
        <Button type="button" variant="outline" size="sm" onClick={() => void log.refetch()} disabled={log.isFetching}>
          <RefreshCw className={cn(log.isFetching && 'animate-spin')} aria-hidden />
          Refresh
        </Button>
      }
    >
      {log.isPending ? (
        <Rows count={3} />
      ) : log.isError ? (
        <ErrorState error={log.error} title="The DNS log could not be read" />
      ) : (
        <div className="overflow-hidden rounded-lg border" data-untrusted={log.data.untrusted.source}>
          <Table>
            <caption className="sr-only">DNS queries of {service.name}, untrusted data from the resolver log</caption>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Result</TableHead>
                <TableHead className="hidden sm:table-cell">Answers</TableHead>
                <TableHead className="hidden md:table-cell">Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {log.data.untrusted.entries.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground">
                    No queries since the service started.
                  </TableCell>
                </TableRow>
              )}
              {log.data.untrusted.entries.map((e, i) => (
                <TableRow key={i}>
                  <TableCell className="text-muted-foreground">{ago(e.at)}</TableCell>
                  <TableCell className="max-w-72 whitespace-normal break-all">
                    <Mono>{e.name}</Mono>
                    <span className="ml-2 text-xs text-muted-foreground">{e.type}</span>
                    {e.probe && (
                      <Badge variant="outline" className="ml-2 font-normal">
                        probe
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Mono className={cn(e.rcode !== 'NOERROR' && 'text-amber-700 dark:text-amber-400')}>{e.rcode}</Mono>
                    {e.upstream && <span className="ml-2 text-xs text-muted-foreground">upstream</span>}
                  </TableCell>
                  <TableCell className="hidden whitespace-normal sm:table-cell">
                    <Mono className="text-muted-foreground">{e.answers.join(', ') || '—'}</Mono>
                  </TableCell>
                  <TableCell className="hidden tabular-nums md:table-cell">{e.ms.toFixed(1)} ms</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Section>
  )
}

export function ServiceNetwork({ service }: { service: Service }) {
  return (
    <div className="space-y-8">
      <Reachability service={service} />
      <ConnectionsSection service={service} />
      <DnsLogSection service={service} />
    </div>
  )
}
