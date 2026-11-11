import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ShieldCheck } from 'lucide-react'

import { Trigger } from '@/components/actor'
import { AgentSheet } from '@/components/agent-sheet'
import { AlsoWith } from '@/components/code'
import { Crumbs } from '@/components/crumbs'
import {
  DeployButton,
  RedeployButton,
  RollbackButton,
  StaleBanner,
} from '@/components/deploy-actions'
import { EmptyState, KeyValue, Mono, PageHeader } from '@/components/page'
import { failurePage, Panel } from '@/components/panel'
import { PublicNetworking } from '@/components/public-networking'
import { ServiceNetwork } from '@/components/service-network'
import { DeploymentStatusBadge, ServiceStatus } from '@/components/status'
import { ActionsHead, TableFrame } from '@/components/table-frame'
import { Term } from '@/components/term'
import { Time } from '@/components/time'
import { Badge } from '@/components/ui/badge'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { VariablesPanel } from '@/components/variables-panel'
import { agentHints } from '@/lib/agent-hints'
import type { Service } from '@/lib/api'
import { isOptimistic } from '@/lib/cache'
import { commands, type ServiceScope } from '@/lib/commands'
import { blank, duration, shortDigest, shortSha, sourceText } from '@/lib/format'
import { entityIcon } from '@/lib/icons'
import { deploymentStrategy, serviceKind } from '@/lib/labels'
import { deploymentsQuery, load, serviceQuery, warm } from '@/lib/queries'
import { tabSearch, useSearchTab } from '@/lib/search'
import { loaderTitle } from '@/lib/title'
import { toneText } from '@/lib/tone'
import { highlight, useFresh } from '@/lib/use-fresh'
import { loadTrail, useEnvironmentTrail } from '@/lib/use-trail'
import { cn } from '@/lib/utils'

const tabs = ['deployments', 'variables', 'network'] as const

export const Route = createFileRoute('/_app/services/$service')({
  validateSearch: tabSearch(tabs),
  loader: async ({ context, params }) => {
    const [service] = await Promise.all([
      load(context.queryClient, serviceQuery(params.service)),
      warm(context.queryClient, deploymentsQuery(params.service)),
    ])

    return {
      title: [service.name, await loadTrail(context.queryClient, service.environment_id)],
    }
  },
  head: loaderTitle,
  errorComponent: failurePage('Couldn’t load this service'),
  component: ServicePage,
})

function Deployments({ service, scope }: { service: Service; scope: ServiceScope }) {
  const { data } = useSuspenseQuery(deploymentsQuery(service.id))
  const fresh = useFresh(data.items)

  if (data.items.length === 0) {
    return (
      <EmptyState
        icon={entityIcon.deployment}
        title="Not deployed yet"
        description={`Deploy ${service.name} to start it. You’ll see each step and its logs here.`}
        action={<DeployButton service={service} />}
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
              {deployment.id !== service.current_deployment_id &&
                (deployment.status === 'superseded' || deployment.status === 'active') && (
                  <RollbackButton service={service} deployment={deployment} />
                )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </TableFrame>
  )
}

function ServicePage() {
  const { service: id } = Route.useParams()
  const { tab } = Route.useSearch()
  const selectTab = useSearchTab(tabs)
  const { data: s } = useSuspenseQuery(serviceQuery(id))
  const trail = useEnvironmentTrail(s.environment_id)
  const current = s.current_deployment
  const scope = {
    project: trail.project.name,
    environment: trail.environment.name,
    service: s.name,
  }

  return (
    <div className="space-y-6">
      <div>
        <Crumbs
          items={[
            ...trail.crumbs,
            {
              label: s.name,
            },
          ]}
        />
        <PageHeader
          title={
            <span className="flex items-center gap-2">
              <entityIcon.service className="size-5 text-muted-foreground" aria-hidden />
              {s.name}
              <Badge variant="outline" className="font-normal">
                {serviceKind[s.kind]}
              </Badge>
            </span>
          }
          meta={
            <>
              <ServiceStatus status={s.status} reason={s.status_reason} />
              <Mono>{sourceText(s)}</Mono>
              {trail.environment.protected && (
                <span className="inline-flex items-center gap-1">
                  <ShieldCheck className={cn('size-3.5', toneText.success)} aria-hidden />
                  <Term name="protectedEnvironment">Protected</Term>
                </span>
              )}
            </>
          }
          actions={
            <>
              <AgentSheet hint={agentHints['/_app/services/$service']} scope={scope} />
              <RedeployButton service={s} />
              <DeployButton service={s} shortcut />
            </>
          }
        />
      </div>
      <StaleBanner service={s} />
      {current && (
        <KeyValue
          framed
          items={[
            [
              'Current deployment',
              <Link
                key="d"
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
            ['Started', <Time key="t" value={current.started_at} />],
            ['Strategy', deploymentStrategy[current.strategy]],
          ]}
        />
      )}
      <Tabs value={tab} onValueChange={selectTab}>
        <TabsList>
          <TabsTrigger value="deployments">Deployments</TabsTrigger>
          <TabsTrigger value="variables">Variables</TabsTrigger>
          <TabsTrigger value="network">Network</TabsTrigger>
        </TabsList>
        <TabsContent value="deployments" className="mt-4">
          <Panel rows={5} title="Couldn’t load deployments">
            <Deployments service={s} scope={scope} />
          </Panel>
        </TabsContent>
        <TabsContent value="variables" className="mt-4">
          <VariablesPanel
            target={{
              kind: 'service',
              service: s.id,
            }}
            also={
              <AlsoWith cli={commands.setServiceVariable(scope)} tool="set_service_variables" />
            }
          />
        </TabsContent>
        <TabsContent value="network" className="mt-4 space-y-10">
          <PublicNetworking service={s} protectedEnvironment={trail.environment.protected} />
          <ServiceNetwork service={s} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
