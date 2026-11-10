import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Box } from 'lucide-react'

import { Crumbs } from '@/components/crumbs'
import {
  DeployButton,
  RedeployButton,
  RollbackButton,
  StaleBanner,
} from '@/components/deploy-actions'
import { Empty, KeyValue, Mono, PageHeader } from '@/components/page'
import { PublicNetworking } from '@/components/public-networking'
import { noItems, QueryState } from '@/components/query-state'
import { ServiceNetwork } from '@/components/service-network'
import { DeploymentStatusBadge, ServiceStatus } from '@/components/status'
import { ActionsHead, TableFrame } from '@/components/table-frame'
import { Badge } from '@/components/ui/badge'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { VariablesPanel } from '@/components/variables-panel'
import type { Service } from '@/lib/api'
import { ago, duration, shortDigest, shortSha, sourceText } from '@/lib/format'
import { deploymentsQuery, serviceQuery } from '@/lib/queries'
import { toneText } from '@/lib/tone'
import { useEnvironmentTrail } from '@/lib/use-trail'
import { cn } from '@/lib/utils'

const tabs = ['deployments', 'variables', 'network'] as const
type Tab = (typeof tabs)[number]

export const Route = createFileRoute('/_app/services/$service')({
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } =>
    tabs.includes(search.tab as Tab)
      ? {
          tab: search.tab as Tab,
        }
      : {},
  component: ServicePage,
})

function Deployments({ service }: { service: Service }) {
  const deployments = useQuery(deploymentsQuery(service.id))
  return (
    <QueryState
      query={deployments}
      rows={5}
      isEmpty={noItems}
      empty={
        <Empty title="No deployments yet">
          Deploy from here, with sly deploy, or with the deploy MCP tool.
        </Empty>
      }
    >
      {(data) => (
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
              <TableRow key={deployment.id} className="relative">
                <TableCell className="tabular-nums">
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
                  {deployment.trigger.type}
                </TableCell>
                <TableCell className="hidden max-w-72 truncate md:table-cell">
                  <Mono className="text-muted-foreground">
                    {shortSha(deployment.trigger.source_sha) ??
                      (deployment.image_ref ? shortDigest(deployment.image_ref) : null) ??
                      '—'}
                  </Mono>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {ago(deployment.started_at ?? deployment.created_at)}
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
      )}
    </QueryState>
  )
}

function ServicePage() {
  const { service: id } = Route.useParams()
  const service = useQuery(serviceQuery(id))
  return (
    <QueryState query={service} rows={6} errorTitle="The service could not be loaded">
      {(s) => <ServiceView s={s} />}
    </QueryState>
  )
}

function ServiceView({ s }: { s: Service }) {
  const { tab = 'deployments' } = Route.useSearch()
  const navigate = useNavigate({
    from: Route.fullPath,
  })
  const trail = useEnvironmentTrail(s.environment_id)
  const current = s.current_deployment

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
              <Box className="size-5 text-muted-foreground" aria-hidden />
              {s.name}
              <Badge variant="outline" className="font-normal">
                {s.kind}
              </Badge>
            </span>
          }
          meta={
            <>
              <ServiceStatus status={s.status} reason={s.status_reason} />
              <Mono>{sourceText(s)}</Mono>
              {trail.environment?.protected && (
                <span>protected environment: changes are staged</span>
              )}
            </>
          }
          actions={
            <>
              <RedeployButton service={s} />
              <DeployButton service={s} />
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
            ['Trigger', current.trigger.type],
            ['Started', ago(current.started_at)],
            ['Strategy', current.strategy],
          ]}
        />
      )}
      <Tabs
        value={tab}
        onValueChange={(value) =>
          void navigate({
            search: {
              tab: value as Tab,
            },
            replace: true,
          })
        }
      >
        <TabsList>
          <TabsTrigger value="deployments">Deployments</TabsTrigger>
          <TabsTrigger value="variables">Variables</TabsTrigger>
          <TabsTrigger value="network">Network</TabsTrigger>
        </TabsList>
        <TabsContent value="deployments" className="mt-4">
          <Deployments service={s} />
        </TabsContent>
        <TabsContent value="variables" className="mt-4">
          <VariablesPanel
            target={{
              kind: 'service',
              service: s.id,
            }}
          />
        </TabsContent>
        <TabsContent value="network" className="mt-4 space-y-10">
          <PublicNetworking
            service={s}
            protectedEnvironment={trail.environment?.protected ?? false}
          />
          <ServiceNetwork service={s} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
