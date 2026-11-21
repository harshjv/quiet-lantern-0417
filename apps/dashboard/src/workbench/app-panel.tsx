import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { Link, useNavigate, type LinkOptions } from '@tanstack/react-router'
import { TriangleAlert } from 'lucide-react'
import type { ReactNode } from 'react'

import { Trigger } from '@/components/actor'
import { AlsoWith, Code } from '@/components/code'
import { DeployButton, RollbackButton, StaleBanner } from '@/components/deploy-actions'
import { LogViewer } from '@/components/log-viewer'
import { EmptyState } from '@/components/page'
import { Panel } from '@/components/panel'
import { PublicNetworking } from '@/components/public-networking'
import { AppHealth } from '@/components/service-health'
import { AppStatus, DeploymentStatusBadge } from '@/components/status'
import { ActionsHead, EmptyRow, TableFrame } from '@/components/table-frame'
import { Time } from '@/components/time'
import { Button } from '@/components/ui/button'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { TabsList, TabsTrigger } from '@/components/ui/tabs'
import { VariablesPanel } from '@/components/variables-panel'
import type { App, Connections, Deployment } from '@/lib/api'
import { isOptimistic } from '@/lib/cache'
import { hostOf, type Connection } from '@/lib/canvas-layout'
import { commands, type AppScope } from '@/lib/commands'
import { blank, bytes, duration, plural, shortDigest, shortSha, sourceText } from '@/lib/format'
import { entityIcon } from '@/lib/icons'
import { appKind } from '@/lib/labels'
import { appTo, newTaskTo } from '@/lib/links'
import type { LiveNetwork } from '@/lib/network-live'
import { rateText } from '@/lib/network-text'
import { scopeOf, type PlaceView } from '@/lib/place'
import { appMetricsQuery, deploymentsQuery, diagnosisQuery } from '@/lib/queries'
import { useShortcut } from '@/lib/shortcuts'
import { toneText } from '@/lib/tone'
import { highlight, useFresh } from '@/lib/use-fresh'
import { cn } from '@/lib/utils'

import { appLink, reportsMetrics } from './ops-live'
import { Notice, PageTabPanel, PageTabs } from './parts'
import { SidePanel } from './side-panel'

const appTabs = [
  'overview',
  'deployments',
  'logs',
  'metrics',
  'environment-variables',
  'domains-and-ports',
  'settings',
] as const

type AppTab = (typeof appTabs)[number]

const tabLabel: Record<AppTab, string> = {
  overview: 'Overview',
  deployments: 'Deployments',
  logs: 'Logs',
  metrics: 'Metrics',
  'environment-variables': 'Environment variables',
  'domains-and-ports': 'Domains and ports',
  settings: 'Settings',
}

const failedOf = (deployments: Deployment[] | undefined) =>
  deployments?.[0]?.status === 'failed' ? deployments[0] : undefined

export function AppPanel({
  app,
  place,
  live,
  tab: shown,
  closeTo,
}: {
  app: App
  place: PlaceView
  live: LiveNetwork
  tab: string | null
  closeTo: LinkOptions
}) {
  const navigate = useNavigate()
  const tab = appTabs.find((t) => t === shown) ?? 'overview'
  const scope: AppScope = {
    ...scopeOf(place),
    app: app.name,
  }
  const link = appLink(app)
  const deployments = useQuery(deploymentsQuery(app.id))
  const failed = failedOf(deployments.data?.items)
  const select = (next: string) => {
    const found = appTabs.find((t) => t === next)

    if (found) {
      void navigate(appTo(place.projectName, app.id, found === 'overview' ? undefined : found))
    }
  }

  useShortcut('tab', (index) => {
    const next = appTabs[index]

    if (next) {
      select(next)
    }
  })

  return (
    <SidePanel
      title={app.name}
      icon={entityIcon.app}
      status={<AppStatus status={app.status} reason={app.status_reason} />}
      closeTo={closeTo}
      subtitle={
        link ? (
          <a
            href={link}
            target="_blank"
            rel="noreferrer"
            className={cn('truncate text-xs underline-offset-4 hover:underline', toneText.info)}
          >
            {link}
          </a>
        ) : null
      }
      action={
        failed ? (
          <Button asChild size="sm">
            <Link {...newTaskTo(place.projectName, `deployment:${failed.id}`)}>
              <TriangleAlert /> Fix with an agent
            </Link>
          </Button>
        ) : (
          <DeployButton app={app} shortcut />
        )
      }
    >
      <PageTabs value={tab} onValueChange={select} className="gap-4">
        <TabsList className="h-auto! w-full flex-wrap justify-start gap-1">
          {appTabs.map((t) => (
            <TabsTrigger key={t} value={t} className="h-8 flex-none px-2">
              {tabLabel[t]}
            </TabsTrigger>
          ))}
        </TabsList>
        <PageTabPanel value="overview" className="gap-6">
          <StaleBanner app={app} />
          {failed && <FailedNotice app={app} deployment={failed} />}
          <MetricTiles app={app} />
          <Block title="Deployments">
            <Panel rows={2} title="Couldn’t load deployments">
              <Deployments app={app} scope={scope} limit={3} />
            </Panel>
          </Block>
          <Block title="Connections">
            <AppConnections app={app} live={live} />
          </Block>
        </PageTabPanel>
        <PageTabPanel value="deployments">
          <Panel rows={5} title="Couldn’t load deployments">
            <Deployments app={app} scope={scope} />
          </Panel>
        </PageTabPanel>
        <PageTabPanel value="logs">
          <LogViewer
            selector={{
              app: app.id,
            }}
            follow
            label="App logs"
          />
        </PageTabPanel>
        <PageTabPanel value="metrics">
          <MetricTiles app={app} />
        </PageTabPanel>
        <PageTabPanel value="environment-variables">
          <VariablesPanel
            target={{
              kind: 'app',
              app: app.id,
            }}
            also={
              <AlsoWith cli={commands.setAppVariable(scope)} tool="set_app_environment_variables" />
            }
          />
        </PageTabPanel>
        <PageTabPanel value="domains-and-ports">
          <PublicNetworking app={app} production={place.preview === null} />
        </PageTabPanel>
        <PageTabPanel value="settings">
          <AppSettings app={app} scope={scope} />
        </PageTabPanel>
      </PageTabs>
    </SidePanel>
  )
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
}

function Tile({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="flex flex-col gap-1 border bg-card px-3 py-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn('text-lg font-medium tabular-nums', tone)}>{value}</span>
    </div>
  )
}

function MetricTiles({ app }: { app: App }) {
  const metered = reportsMetrics(app)
  const sample = useQuery({
    ...appMetricsQuery(app.id),
    enabled: metered,
  }).data

  if (!metered || !sample) {
    return null
  }

  return (
    <div className="grid grid-cols-3 gap-2">
      <Tile label="CPU" value={`${Math.round(sample.cpu_pct)}%`} />
      <Tile
        label="Memory"
        value={
          <span className="flex flex-col">
            {bytes(sample.memory_bytes)}
            {sample.memory_limit_bytes > 0 && (
              <span className="text-xs font-normal text-muted-foreground">
                of {bytes(sample.memory_limit_bytes)}
              </span>
            )}
          </span>
        }
      />
      <Tile
        label="Restarts"
        value={sample.restarts === null ? blank : plural(sample.restarts, 'restart')}
        tone={sample.restarts ? toneText.warning : undefined}
      />
    </div>
  )
}

function FailedNotice({ app, deployment }: { app: App; deployment: Deployment }) {
  const diagnosis = useQuery(diagnosisQuery(deployment.id))

  return (
    <Notice
      tone="danger"
      title={`#${deployment.number} failed`}
      action={
        <>
          <Button asChild size="sm" variant="outline">
            <Link
              to="/deployments/$deployment"
              params={{
                deployment: deployment.id,
              }}
            >
              Open deployment
            </Link>
          </Button>
          <DeployButton app={app} />
        </>
      }
    >
      <span className="flex flex-col gap-1">
        <span>{diagnosis.data?.summary ?? deployment.failure?.summary}</span>
        {(diagnosis.data?.fixes ?? []).map((fix) => (
          <span key={fix.code}>{fix.text}</span>
        ))}
      </span>
    </Notice>
  )
}

const rollbackable = (app: App, deployment: Deployment) =>
  deployment.id !== app.current_deployment_id &&
  (deployment.status === 'superseded' || deployment.status === 'active')

const fromText = (deployment: Deployment) =>
  shortSha(deployment.trigger.source_sha) ??
  (deployment.image_ref ? shortDigest(deployment.image_ref) : null)

function Deployments({ app, scope, limit }: { app: App; scope: AppScope; limit?: number }) {
  const { data } = useSuspenseQuery(deploymentsQuery(app.id))
  const fresh = useFresh(data.items)
  const items = limit ? data.items.slice(0, limit) : data.items
  const full = limit === undefined

  if (data.items.length === 0) {
    return (
      <EmptyState
        icon={entityIcon.deployment}
        title="Not deployed"
        action={<DeployButton app={app} />}
        also={<AlsoWith cli={commands.deploy(scope)} tool="deploy" />}
      />
    )
  }

  return (
    <TableFrame>
      <TableHeader>
        <TableRow>
          <TableHead className="w-16">Deploy</TableHead>
          <TableHead>Status</TableHead>
          {full && <TableHead className="hidden xl:table-cell">Trigger</TableHead>}
          <TableHead>From</TableHead>
          <TableHead className="text-right">When</TableHead>
          {full && <TableHead className="hidden text-right xl:table-cell">Took</TableHead>}
          {full && <ActionsHead />}
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((deployment) => (
          <TableRow
            key={deployment.id}
            className={cn('relative', fresh.has(deployment.id) && highlight)}
          >
            <TableCell className="tabular-nums">
              {!isOptimistic(deployment) && (
                <Link
                  to="/deployments/$deployment"
                  params={{
                    deployment: deployment.id,
                  }}
                  className="font-medium after:absolute after:inset-0"
                  aria-label={`Deployment ${deployment.number}`}
                >
                  #{deployment.number}
                </Link>
              )}
            </TableCell>
            <TableCell>
              <div className="flex flex-col gap-1">
                <DeploymentStatusBadge status={deployment.status} />
                {full && deployment.failure?.summary && (
                  <span className={cn('max-w-64 truncate text-xs', toneText.danger)}>
                    {deployment.failure.summary}
                  </span>
                )}
              </div>
            </TableCell>
            {full && (
              <TableCell className="hidden text-muted-foreground xl:table-cell">
                <Trigger trigger={deployment.trigger} />
              </TableCell>
            )}
            <TableCell className="max-w-40 truncate">
              {fromText(deployment) ? <Code>{fromText(deployment)}</Code> : blank}
            </TableCell>
            <TableCell className="text-right text-muted-foreground">
              <Time value={deployment.started_at ?? deployment.created_at} />
            </TableCell>
            {full && (
              <TableCell className="hidden text-right text-muted-foreground tabular-nums xl:table-cell">
                {duration(deployment.started_at, deployment.finished_at)}
              </TableCell>
            )}
            {full && (
              <TableCell className="relative z-10 text-right">
                {rollbackable(app, deployment) && (
                  <RollbackButton app={app} deployment={deployment} />
                )}
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </TableFrame>
  )
}

type Line = { key: string; from: string; to: string; outside: boolean; connection: Connection }

const peerName = (sample: Connections, connection: Connection) => {
  switch (connection.peer.kind) {
    case 'gateway':
      return 'Tunnel'
    case 'service':
      return connection.peer.app ?? 'App'
    case 'sandbox':
      return 'Task'
    case 'station':
      return 'Health checks'
    case 'public':
      return hostOf(sample, connection)
    default:
      return connection.peer.address ?? connection.peer.kind
  }
}

const linesOf = (sample: Connections): Line[] =>
  sample.connections
    .filter((c) => c.peer.kind !== 'resolver')
    .map((c, index) => {
      const peer = peerName(sample, c)

      return {
        key: `${index}:${c.direction}:${peer}:${c.port}`,
        from: c.direction === 'in' ? peer : sample.app.name,
        to: c.direction === 'in' ? sample.app.name : peer,
        outside: c.peer.kind === 'public',
        connection: c,
      }
    })

function AppConnections({ app, live }: { app: App; live: LiveNetwork }) {
  const sample = live.samples.find((s) => s.app.id === app.id)
  const lines = sample ? linesOf(sample) : []

  return (
    <TableFrame>
      <TableHeader>
        <TableRow>
          <TableHead>From</TableHead>
          <TableHead>To</TableHead>
          <TableHead className="text-right">Port</TableHead>
          <TableHead className="text-right">Open</TableHead>
          <TableHead className="text-right">Rate</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {lines.length === 0 && (
          <EmptyRow columns={5}>{live.at === null ? 'Listening' : 'None'}</EmptyRow>
        )}
        {lines.map(({ key, from, to, outside, connection: c }) => (
          <TableRow key={key}>
            <TableCell className="max-w-32 truncate">{from}</TableCell>
            <TableCell className={cn('max-w-40 truncate', outside && toneText.warning)}>
              {to}
            </TableCell>
            <TableCell className="text-right tabular-nums">{c.port}</TableCell>
            <TableCell className="text-right tabular-nums">
              {plural(c.flows, 'connection')}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {c.bps_in === null && c.bps_out === null
                ? blank
                : rateText((c.bps_in ?? 0) + (c.bps_out ?? 0))}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </TableFrame>
  )
}

function AppSettings({ app, scope }: { app: App; scope: AppScope }) {
  return (
    <div className="flex flex-col gap-6">
      <dl className="flex flex-col gap-2 text-sm">
        <div className="flex gap-6">
          <dt className="w-16 shrink-0 text-muted-foreground">Kind</dt>
          <dd>{appKind[app.kind]}</dd>
        </div>
        <div className="flex gap-6">
          <dt className="w-16 shrink-0 text-muted-foreground">Source</dt>
          <dd className="min-w-0 truncate">
            <Code>{sourceText(app)}</Code>
          </dd>
        </div>
      </dl>
      <AppHealth app={app} scope={scope} />
    </div>
  )
}
