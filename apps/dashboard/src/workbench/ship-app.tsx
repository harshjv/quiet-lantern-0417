import { useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { ArrowLeft, ExternalLink, ShieldCheck, TriangleAlert } from 'lucide-react'

import { Trigger } from '@/components/actor'
import { AgentSheet } from '@/components/agent-sheet'
import { AlsoWith } from '@/components/code'
import {
  DeployButton,
  RedeployButton,
  RollbackButton,
  StaleBanner,
} from '@/components/deploy-actions'
import { LogViewer } from '@/components/log-viewer'
import { EmptyState, KeyValue, Mono } from '@/components/page'
import { Panel } from '@/components/panel'
import { PublicNetworking } from '@/components/public-networking'
import { AppHealth } from '@/components/service-health'
import { AppNetwork } from '@/components/service-network'
import { AppStatus, DeploymentStatusBadge } from '@/components/status'
import { ActionsHead, TableFrame } from '@/components/table-frame'
import { Term } from '@/components/term'
import { Time } from '@/components/time'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { TabsList, TabsTrigger } from '@/components/ui/tabs'
import { KeysPanel } from '@/components/variables-panel'
import { agentHints } from '@/lib/agent-hints'
import type { App, Deployment } from '@/lib/api'
import { isOptimistic } from '@/lib/cache'
import { commands, type AppScope } from '@/lib/commands'
import { blank, duration, shortDigest, shortSha, sourceText } from '@/lib/format'
import { healthChangeText } from '@/lib/health-text'
import { entityIcon } from '@/lib/icons'
import { appKind, deploymentStrategy } from '@/lib/labels'
import { placeTo } from '@/lib/links'
import { appQuery, deploymentsQuery, diagnosisQuery } from '@/lib/queries'
import { useShortcut } from '@/lib/shortcuts'
import { toneText } from '@/lib/tone'
import { highlight, useFresh } from '@/lib/use-fresh'
import { useTrail } from '@/lib/use-trail'
import { cn } from '@/lib/utils'

import { appLink } from './ops-live'
import { Notice, Page, PageBoundary, PageTabPanel, PageTabs, Section } from './parts'

const appTabs = ['deployments', 'logs', 'keys', 'network'] as const

type AppTab = (typeof appTabs)[number]

const tabLabel: Record<AppTab, string> = {
  deployments: 'Deployments',
  logs: 'Logs',
  keys: 'Keys',
  network: 'Network',
}

export function AppPage({ appId, tab }: { appId: string; tab: string | null }) {
  return (
    <PageBoundary title="Couldn’t load this app" resetKey={appId}>
      <AppView key={appId} id={appId} tab={tab} />
    </PageBoundary>
  )
}

function AppView({ id, tab: shown }: { id: string; tab: string | null }) {
  const { data: app } = useSuspenseQuery(appQuery(id))
  const navigate = useNavigate()
  const tab = appTabs.find((t) => t === shown) ?? 'deployments'
  const trail = useTrail(app)
  const scope: AppScope = {
    ...trail.scope,
    app: app.name,
  }
  const link = appLink(app)
  const select = (next: string) => {
    const found = appTabs.find((t) => t === next)

    if (found) {
      void navigate({
        to: '/apps/$app/{-$tab}',
        params: {
          app: id,
          tab: found === 'deployments' ? undefined : found,
        },
      })
    }
  }

  useShortcut('tab', (index) => {
    const next = appTabs[index]

    if (next) {
      select(next)
    }
  })

  return (
    <Page
      title={app.name}
      actions={
        <span className="flex flex-wrap items-center gap-2">
          {link && (
            <Button asChild size="sm" variant="outline">
              <a href={link} target="_blank" rel="noreferrer">
                <ExternalLink /> Open
              </a>
            </Button>
          )}
          <AgentSheet hint={agentHints.app} scope={scope} />
          <RedeployButton app={app} />
          <DeployButton app={app} shortcut />
        </span>
      }
    >
      <div className="-mt-4 flex flex-col gap-2">
        <Link
          {...placeTo(trail.project.name, trail.place.previewName)}
          className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          {trail.project.name} / {trail.place.previewName ?? 'production'}
        </Link>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <Badge variant="outline" className="font-normal">
            {appKind[app.kind]}
          </Badge>
          <AppStatus status={app.status} reason={app.status_reason} />
          {app.last_health_change && (
            <span>
              {healthChangeText(app.last_health_change)}
              {app.last_health_change.last_check && (
                <>
                  {', last checked '}
                  <Time value={app.last_health_change.last_check} />
                </>
              )}
            </span>
          )}
          <Mono>{sourceText(app)}</Mono>
          {trail.production && (
            <span className="inline-flex items-center gap-1 text-foreground">
              <ShieldCheck className={cn('size-3.5', toneText.success)} aria-hidden />
              <Term name="production">Production</Term>
            </span>
          )}
        </p>
      </div>
      <StaleBanner app={app} />
      <FailedNotice app={app} />
      <CurrentDeployment app={app} scope={scope} />
      <PageTabs value={tab} onValueChange={select}>
        <TabsList>
          {appTabs.map((t) => (
            <TabsTrigger key={t} value={t}>
              {tabLabel[t]}
            </TabsTrigger>
          ))}
        </TabsList>
        <PageTabPanel value="deployments">
          <Panel rows={5} title="Couldn’t load deployments">
            <Deployments app={app} scope={scope} />
          </Panel>
        </PageTabPanel>
        <PageTabPanel value="logs">
          <Section
            title="Logs"
            note="The newest lines of every container of this app. Stationly hides known secret values."
          >
            <LogViewer
              selector={{
                app: app.id,
              }}
              follow
              label="App logs"
            />
          </Section>
        </PageTabPanel>
        <PageTabPanel value="keys">
          <KeysPanel
            target={{
              kind: 'app',
              app: app.id,
            }}
            also={<AlsoWith cli={commands.setAppKey(scope)} tool="set_app_keys" />}
          />
        </PageTabPanel>
        <PageTabPanel value="network">
          <PublicNetworking app={app} production={trail.production} />
          <AppNetwork app={app} />
        </PageTabPanel>
      </PageTabs>
    </Page>
  )
}

function CurrentDeployment({ app, scope }: { app: App; scope: AppScope }) {
  const current = app.current_deployment

  return (
    <KeyValue
      framed
      items={
        current
          ? [
              [
                'Current deployment',
                <Link
                  key="deployment"
                  to="/deployments/$deployment"
                  params={{
                    deployment: current.id,
                  }}
                  className="inline-flex items-center gap-2 underline-offset-4 hover:underline"
                >
                  #{current.number} <DeploymentStatusBadge status={current.status} />
                </Link>,
              ],
              ['Trigger', <Trigger key="trigger" trigger={current.trigger} />],
              ['Started', <Time key="started" value={current.started_at} />],
              ['Strategy', deploymentStrategy[current.strategy]],
            ]
          : []
      }
    >
      <AppHealth app={app} scope={scope} />
    </KeyValue>
  )
}

function FailedNotice({ app }: { app: App }) {
  const deployments = useQuery(deploymentsQuery(app.id))
  const newest = deployments.data?.items[0]
  const failed = newest?.status === 'failed' ? newest : undefined
  const diagnosis = useQuery({
    ...diagnosisQuery(failed?.id ?? ''),
    enabled: Boolean(failed),
  })

  if (!failed) {
    return null
  }

  return (
    <Notice
      tone="danger"
      title={`Deployment #${failed.number} failed`}
      action={
        <>
          <Button asChild size="sm" variant="outline">
            <Link
              to="/deployments/$deployment"
              params={{
                deployment: failed.id,
              }}
            >
              Open deployment
            </Link>
          </Button>
          <Button asChild size="sm">
            <Link
              to="/build/new"
              search={{
                fix: `deployment:${failed.id}`,
              }}
            >
              <TriangleAlert /> Fix with an agent
            </Link>
          </Button>
        </>
      }
    >
      <span className="flex flex-col gap-1">
        <span>
          {diagnosis.data?.summary ?? failed.failure?.summary ?? 'The deployment failed.'}
        </span>
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

function Deployments({ app, scope }: { app: App; scope: AppScope }) {
  const { data } = useSuspenseQuery(deploymentsQuery(app.id))
  const fresh = useFresh(data.items)

  if (data.items.length === 0) {
    return (
      <EmptyState
        icon={entityIcon.deployment}
        title="Not deployed yet"
        description={`Deploy ${app.name} to start it. You’ll see each step and its logs here.`}
        action={<DeployButton app={app} />}
        also={<AlsoWith cli={commands.deploy(scope)} tool="deploy" />}
      />
    )
  }

  return (
    <TableFrame>
      <TableHeader>
        <TableRow>
          <TableHead className="w-16">#</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="hidden sm:table-cell">Trigger</TableHead>
          <TableHead className="hidden md:table-cell">Image or commit</TableHead>
          <TableHead>Started</TableHead>
          <TableHead className="hidden sm:table-cell">Duration</TableHead>
          <ActionsHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {data.items.map((deployment) => (
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
                  {deployment.number}
                </Link>
              )}
            </TableCell>
            <TableCell>
              <div className="flex flex-col gap-1">
                <DeploymentStatusBadge status={deployment.status} />
                {deployment.failure?.summary && (
                  <span className={cn('max-w-80 truncate text-xs', toneText.danger)}>
                    {deployment.failure.summary}
                  </span>
                )}
              </div>
            </TableCell>
            <TableCell className="hidden text-muted-foreground sm:table-cell">
              <Trigger trigger={deployment.trigger} />
            </TableCell>
            <TableCell className="hidden max-w-72 truncate md:table-cell">
              <Mono className="text-muted-foreground">
                {shortSha(deployment.trigger.source_sha) ??
                  (deployment.image_ref ? shortDigest(deployment.image_ref) : null) ??
                  blank}
              </Mono>
            </TableCell>
            <TableCell className="text-muted-foreground">
              <Time value={deployment.started_at ?? deployment.created_at} />
            </TableCell>
            <TableCell className="hidden text-muted-foreground tabular-nums sm:table-cell">
              {duration(deployment.started_at, deployment.finished_at)}
            </TableCell>
            <TableCell className="relative z-10 text-right">
              {rollbackable(app, deployment) && (
                <RollbackButton app={app} deployment={deployment} />
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </TableFrame>
  )
}
