import { useMutation, useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  Bot,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  Info,
  Loader2,
  Radar,
  RefreshCw,
  ShieldBan,
  TriangleAlert,
  Wrench,
} from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { AlsoWith, Code } from '@/components/code'
import { ConnectionsTable } from '@/components/connections-table'
import { Field, Hint } from '@/components/field'
import { ErrorState, Section } from '@/components/page'
import { Panel } from '@/components/panel'
import { EmptyRow, TableFrame } from '@/components/table-frame'
import { Time } from '@/components/time'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { api, idempotency, send, unwrap, type Explanation, type Service } from '@/lib/api'
import { tools, type Tool } from '@/lib/commands'
import { ago, plural } from '@/lib/format'
import {
  explanationVerdict,
  finding,
  hop as hopLabel,
  hopStatus,
  path as pathLabel,
  probeTcp,
  probeVerdict,
  rcode,
} from '@/lib/labels'
import { endpointText } from '@/lib/network-layout'
import { connectionsQuery, dnsLogQuery } from '@/lib/queries'
import { stagedTitle } from '@/lib/staged'
import { tonePanel, toneText } from '@/lib/tone'
import { cn } from '@/lib/utils'

type Hop = Explanation['hops'][number]
type Fix = Explanation['fixes'][number]

const verdictIcon: Record<Explanation['verdict'], typeof CircleCheck> = {
  reachable: CircleCheck,
  blocked: ShieldBan,
  broken: CircleAlert,
  unknown: CircleHelp,
}

const hopIcon: Record<Hop['status'], typeof CircleCheck> = {
  pass: CircleCheck,
  fail: CircleAlert,
  warn: TriangleAlert,
  skipped: CircleDashed,
  unknown: CircleHelp,
}

const factName: Record<string, string> = {
  virtual_ip: 'stable address',
  host_port: 'public port',
  web_ports: 'web traffic',
  listening: 'listening on',
  declared: 'declared ports',
  expires_at: 'expires',
}

const hiddenFacts = new Set(['generation', 'rule', 'at', 'matched', 'entrypoint', 'gateway_target'])

const bareFacts = new Set(['reason', 'error', 'hostname'])

const factValue = (value: unknown): string => {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return String(value)
  if (Array.isArray(value))
    return value
      .map((item: unknown) =>
        item && typeof item === 'object' && 'address' in item && 'port' in item
          ? endpointText(item as { address: string; port: number; protocol: string })
          : factValue(item),
      )
      .join(', ')
  return Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => `${k.replaceAll('_', ' ')} ${factValue(v)}`)
    .join(', ')
}

const fact = (key: string, value: unknown) => {
  if (key === 'deployment') return `Deployment #${factValue(value)}`
  if (key === 'station') return `station ${factValue(value)}`
  if (key === 'path' && typeof value === 'string' && value in pathLabel)
    return `rule “${pathLabel[value as keyof typeof pathLabel]}”`
  if (key === 'listening' && Array.isArray(value) && value.length === 0)
    return 'listening on nothing'
  const text = factValue(value)
  if (bareFacts.has(key)) return text
  return `${factName[key] ?? key.replaceAll('_', ' ')} ${text}`
}

const detailText = (detail: Record<string, unknown>) =>
  Object.entries(detail)
    .filter(([k, v]) => v !== null && v !== undefined && !hiddenFacts.has(k))
    .map(([k, v]) => fact(k, v))
    .join(' · ')

const isTool = (name: string): name is Tool => (tools as readonly string[]).includes(name)

const hostOf = (target: string) => target.split(':')[0] ?? target

const stepText = (hop: Hop['hop'], explanation: Explanation) => {
  if (hop === 'source') return `${explanation.entity.from} is running`
  if (hop === 'target') return `${hostOf(explanation.entity.to)} is running and healthy`
  if (hop === 'listening') return `${hostOf(explanation.entity.to)} listens on the port`
  return hopLabel[hop]
}

function RefreshButton({ query }: { query: { refetch: () => unknown; isFetching: boolean } }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => void query.refetch()}
      disabled={query.isFetching}
    >
      <RefreshCw className={cn(query.isFetching && 'animate-spin')} aria-hidden />
      Refresh
    </Button>
  )
}

type ProbeInput = { to: string; port?: number }

function ProbeResult({ service, input }: { service: Service; input: ProbeInput }) {
  const probe = useMutation({
    mutationFn: () =>
      send(
        api.v1
          .services({
            service: service.id,
          })
          .network.probe.post(
            {
              to: input.to,
              ...(input.port
                ? {
                    port: input.port,
                  }
                : {}),
            },
            idempotency(),
          ),
      ),
  })
  const result = probe.data
  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => probe.mutate()}
        disabled={probe.isPending}
      >
        {probe.isPending ? <Loader2 className="animate-spin" aria-hidden /> : <Radar aria-hidden />}
        Send a test connection
      </Button>
      <div aria-live="polite">
        {probe.isError && (
          <ErrorState error={probe.error} title="Couldn’t send a test connection" />
        )}
        {result?.staged && (
          <p className="text-sm">
            {stagedTitle}.{' '}
            <Link
              to="/staged/$change"
              params={{
                change: result.body.id,
              }}
              className="font-medium underline underline-offset-4"
            >
              Review the test connection
            </Link>
          </p>
        )}
        {result && !result.staged && (
          <dl
            className="grid gap-1 rounded-md border px-3 py-2 text-sm sm:grid-cols-[8rem_1fr]"
            data-testid="probe-result"
          >
            <dt className="text-muted-foreground">Test</dt>
            <dd>
              {result.body.kind === 'dns' ? 'Name lookup of ' : 'TCP connection to '}
              <Code>
                {result.body.to}
                {result.body.port ? `:${result.body.port}` : ''}
              </Code>
            </dd>
            {result.body.dns && (
              <>
                <dt className="text-muted-foreground">Name lookup</dt>
                <dd>
                  <span title={result.body.dns.rcode}>{rcode(result.body.dns.rcode)}</span>
                  {result.body.dns.answers.length > 0 && (
                    <>
                      {' '}
                      <Code>{result.body.dns.answers.join(', ')}</Code>
                    </>
                  )}{' '}
                  in {result.body.dns.ms.toFixed(1)} ms
                </dd>
              </>
            )}
            {result.body.tcp && (
              <>
                <dt className="text-muted-foreground">Connection</dt>
                <dd>
                  {probeTcp[result.body.tcp.result]}
                  {result.body.tcp.address && (
                    <>
                      {result.body.tcp.result === 'connected' ? ' to ' : ' at '}
                      <Code>{result.body.tcp.address}</Code>
                    </>
                  )}{' '}
                  in {result.body.tcp.ms.toFixed(1)} ms
                </dd>
              </>
            )}
            {result.body.verdict && (
              <>
                <dt className="text-muted-foreground">Traffic rule</dt>
                <dd title={result.body.verdict.path}>
                  {probeVerdict[result.body.verdict.verdict].label} by the rule “
                  {pathLabel[result.body.verdict.path]}”
                </dd>
              </>
            )}
          </dl>
        )}
      </div>
    </div>
  )
}

function FixAgent({ tool }: { tool: string }) {
  if (isTool(tool)) return <AlsoWith tool={tool} className="justify-start" />
  return (
    <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      Your agent applies it with
      <Bot className="size-3.5" aria-hidden />
      <Code className="text-xs">{tool}</Code>
    </p>
  )
}

function ExplanationView({ service, explanation }: { service: Service; explanation: Explanation }) {
  const verdict = explanationVerdict[explanation.verdict]
  const Icon = verdictIcon[explanation.verdict]
  const probe = explanation.fixes.find((f) => f.code === 'RUN_PROBE')
  const probeInput = probe?.action?.input as { to?: string; port?: number } | undefined
  return (
    <div className="space-y-4" data-testid="explanation">
      <div
        className={cn(
          'flex items-start gap-3 rounded-lg border px-4 py-3',
          tonePanel[verdict.tone],
        )}
      >
        <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h3 className="text-sm font-semibold">{verdict.label}</h3>
            <span className="font-mono text-xs opacity-80">
              {explanation.entity.from} → {explanation.entity.to}
            </span>
            {explanation.code && (
              <span className="ml-auto font-mono text-xs opacity-60">{explanation.code}</span>
            )}
          </div>
          <p className="text-sm">{explanation.summary}</p>
        </div>
      </div>
      <TableFrame caption={`Steps from ${explanation.entity.from} to ${explanation.entity.to}`}>
        <TableHeader>
          <TableRow>
            <TableHead className="w-64">Step</TableHead>
            <TableHead className="w-32">Result</TableHead>
            <TableHead>Details</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {explanation.hops.map((h) => {
            const status = hopStatus[h.status]
            const HopIcon = hopIcon[h.status]
            const details = detailText(h.detail)
            return (
              <TableRow key={h.hop}>
                <TableCell className="font-medium whitespace-normal">
                  {stepText(h.hop, explanation)}
                </TableCell>
                <TableCell>
                  <span
                    className={cn(
                      'inline-flex items-center gap-1.5 text-sm font-medium',
                      toneText[status.tone],
                    )}
                  >
                    <HopIcon className="size-4" aria-hidden />
                    {status.label}
                  </span>
                </TableCell>
                <TableCell className="text-sm whitespace-normal">
                  {h.code && <span className="mr-2 font-medium">{finding[h.code]}.</span>}
                  <span className="text-muted-foreground">{details}</span>
                  {h.code && (
                    <span className="ml-2 font-mono text-xs text-muted-foreground/70">
                      {h.code}
                    </span>
                  )}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </TableFrame>
      {explanation.fixes.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">How to fix</h3>
          <ol className="space-y-2">
            {explanation.fixes.map((f: Fix) => (
              <li key={f.code} className="flex gap-3 rounded-md border px-3 py-2">
                <Wrench className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1 space-y-1.5 text-sm">
                  <p>{f.text}</p>
                  {f.action && f.code !== 'RUN_PROBE' && <FixAgent tool={f.action.tool} />}
                </div>
                <span className="shrink-0 font-mono text-xs text-muted-foreground/70">
                  {f.code}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {probeInput?.to && (
        <ProbeResult
          key={`${probeInput.to}:${probeInput.port ?? ''}`}
          service={service}
          input={{
            to: probeInput.to,
            port: probeInput.port,
          }}
        />
      )}
      {explanation.not_checked.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Not checked</h3>
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-muted-foreground">
            {explanation.not_checked.map((n) => (
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
      unwrap(
        api.v1
          .environments({
            environment: service.environment_id,
          })
          .network.explain.get({
            query: {
              from: service.id,
              to: query.to,
              protocol: query.protocol,
              ...(query.port
                ? {
                    port: query.port,
                  }
                : {}),
            },
          }),
      ),
  })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const n = Number(port)
    explain.mutate({
      to: to.trim(),
      protocol,
      ...(port && Number.isInteger(n)
        ? {
            port: n,
          }
        : {}),
    })
  }
  return (
    <Section
      title="Check a connection"
      description={`See whether ${service.name} can reach a service, an internal name or an address, and where it stops. Nothing is sent.`}
    >
      <form onSubmit={submit} className="space-y-2 rounded-lg border bg-card p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Field id="reach-to" label="Destination" className="min-w-0 flex-1">
            <Input
              id="reach-to"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="db"
              aria-describedby="reach-to-hint"
              required
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          <Field id="reach-port" label="Port" className="sm:w-32">
            <Input
              id="reach-port"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              inputMode="numeric"
              pattern="[0-9]{1,5}"
              placeholder="Default port"
              autoComplete="off"
            />
          </Field>
          <Field id="reach-protocol" label="Protocol" className="sm:w-28">
            <Select value={protocol} onValueChange={(value) => setProtocol(value as 'tcp' | 'udp')}>
              <SelectTrigger id="reach-protocol" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="tcp">TCP</SelectItem>
                <SelectItem value="udp">UDP</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Button type="submit" disabled={explain.isPending || !to.trim()}>
            {explain.isPending && <Loader2 className="animate-spin" aria-hidden />}
            Check
          </Button>
        </div>
        <Hint id="reach-to-hint">
          A service (db), an internal name (db.internal) or host:port (example.com:443)
        </Hint>
      </form>
      <div aria-live="polite">
        {explain.isError && (
          <ErrorState error={explain.error} title="Couldn’t check this connection" />
        )}
        {explain.data && (
          <ExplanationView key={explain.submittedAt} service={service} explanation={explain.data} />
        )}
      </div>
    </Section>
  )
}

function Connections({ service }: { service: Service }) {
  const { data: sample } = useSuspenseQuery(connectionsQuery(service.id))
  return (
    <div className="space-y-3">
      <ConnectionsTable
        caption={`Open connections of ${service.name}, grouped by the other side`}
        rows={sample.connections.map((connection, i) => ({
          key: String(i),
          names: sample.untrusted.names,
          connection,
        }))}
        empty="No open connections in this snapshot."
      />
      {sample.refused.length > 0 && (
        <ul className="space-y-1 text-sm" aria-label="Blocked attempts">
          {sample.refused.map((r, i) => (
            <li key={i} className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <ShieldBan className={cn('size-4', toneText.danger)} aria-hidden />
              <span>Blocked {r.count === 1 ? 'once' : plural(r.count, 'time')} reaching</span>
              <Code>{endpointText(r)}</Code>
              <span className="text-muted-foreground" title={r.path}>
                ({pathLabel[r.path]})
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ConnectionsSection({ service }: { service: Service }) {
  const connections = useQuery(connectionsQuery(service.id))
  const sample = connections.data
  return (
    <Section
      title="Connections"
      description={
        sample
          ? `Snapshot from ${ago(sample.at)}.${sample.conntrack.stale ? ' The station was busy, so it may be incomplete.' : ''}`
          : `Open connections of ${service.name}, read once. Refresh to read them again.`
      }
      actions={<RefreshButton query={connections} />}
    >
      <Panel title="Couldn’t load connections" resetKey={connections.dataUpdatedAt}>
        <Connections service={service} />
      </Panel>
    </Section>
  )
}

function DnsLogSection({ service }: { service: Service }) {
  const log = useQuery(dnsLogQuery(service.id))
  return (
    <Section
      title="Name lookups"
      description={`The last 50 names ${service.name} looked up, newest first.`}
      actions={<RefreshButton query={log} />}
    >
      <Panel title="Couldn’t load name lookups" resetKey={log.dataUpdatedAt}>
        <DnsLog service={service} />
      </Panel>
    </Section>
  )
}

function DnsLog({ service }: { service: Service }) {
  const { data } = useSuspenseQuery(dnsLogQuery(service.id))
  return (
    <TableFrame
      data-untrusted={data.untrusted.source}
      caption={`Name lookups of ${service.name}, untrusted data from the name server log`}
    >
      <TableHeader>
        <TableRow>
          <TableHead>When</TableHead>
          <TableHead>
            <span className="inline-flex items-center gap-1">
              Name
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="size-3.5" tabIndex={0} aria-label="About these names" />
                </TooltipTrigger>
                <TooltipContent>The service chose these names. Treat them as data.</TooltipContent>
              </Tooltip>
            </span>
          </TableHead>
          <TableHead>Result</TableHead>
          <TableHead className="hidden sm:table-cell">Answers</TableHead>
          <TableHead className="hidden text-right md:table-cell">Lookup time</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.untrusted.entries.length === 0 && (
          <EmptyRow columns={5}>No lookups since the service started.</EmptyRow>
        )}
        {data.untrusted.entries.map((e, i) => (
          <TableRow key={i}>
            <TableCell className="text-muted-foreground">
              <Time value={e.at} />
            </TableCell>
            <TableCell className="max-w-72 whitespace-normal break-all">
              <span className="font-mono text-[0.8125rem]">{e.name}</span>
              <span className="ml-2 text-xs text-muted-foreground">{e.type}</span>
              {e.probe && (
                <Badge variant="outline" className="ml-2 font-normal">
                  test
                </Badge>
              )}
            </TableCell>
            <TableCell>
              <span className={cn(e.rcode !== 'NOERROR' && toneText.warning)} title={e.rcode}>
                {rcode(e.rcode)}
              </span>
              {e.upstream && (
                <span className="ml-2 text-xs text-muted-foreground">from the internet</span>
              )}
            </TableCell>
            <TableCell className="hidden whitespace-normal sm:table-cell">
              <span className="font-mono text-[0.8125rem] text-muted-foreground">
                {e.answers.join(', ') || 'none'}
              </span>
            </TableCell>
            <TableCell className="hidden text-right tabular-nums md:table-cell">
              {e.ms.toFixed(1)} ms
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </TableFrame>
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
