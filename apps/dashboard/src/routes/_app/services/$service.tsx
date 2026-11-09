import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { Box } from 'lucide-react'
import { Crumbs } from '@/components/crumbs'
import { DeployButton, RedeployButton, RollbackButton, StaleBanner } from '@/components/deploy-actions'
import { PublicNetworking } from '@/components/public-networking'
import { ServiceNetwork } from '@/components/service-network'
import { Empty, ErrorState, KeyValue, Mono, PageHeader, Rows } from '@/components/page'
import { DeploymentStatusBadge, ServiceStatus } from '@/components/status'
import { VariablesPanel } from '@/components/variables-panel'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ago, duration, shortDigest, shortSha, sourceText } from '@/lib/format'
import { deploymentsQuery, environmentQuery, projectQuery, serviceQuery } from '@/lib/queries'
import type { Service } from '@/lib/api'

const tabs = ['deployments', 'variables', 'network'] as const
type Tab = (typeof tabs)[number]

export const Route = createFileRoute('/_app/services/$service')({
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } => (tabs.includes(search.tab as Tab) ? { tab: search.tab as Tab } : {}),
  component: ServicePage
})

function Deployments({ service }: { service: Service }) {
  const deployments = useQuery(deploymentsQuery(service.id))
  if (deployments.isPending) return <Rows count={5} />
  if (deployments.isError) return <ErrorState error={deployments.error} />
  if (deployments.data.items.length === 0) return <Empty title="No deployments yet">Deploy from here, with sly deploy, or with the deploy MCP tool.</Empty>
  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">#</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="hidden sm:table-cell">Trigger</TableHead>
            <TableHead className="hidden md:table-cell">Image or commit</TableHead>
            <TableHead>Started</TableHead>
            <TableHead className="hidden sm:table-cell">Duration</TableHead>
            <TableHead className="text-right">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {deployments.data.items.map(deployment => (
            <TableRow key={deployment.id} className="relative">
              <TableCell className="tabular-nums">
                <Link to="/deployments/$deployment" params={{ deployment: deployment.id }} className="font-medium after:absolute after:inset-0" aria-label={`Deployment ${deployment.number}`}>
                  {deployment.number}
                </Link>
              </TableCell>
              <TableCell>
                <div className="flex flex-col gap-1">
                  <DeploymentStatusBadge status={deployment.status} />
                  {deployment.failure?.summary && <span className="max-w-80 truncate text-xs text-red-700 dark:text-red-400">{deployment.failure.summary}</span>}
                </div>
              </TableCell>
              <TableCell className="hidden text-muted-foreground sm:table-cell">{deployment.trigger.type}</TableCell>
              <TableCell className="hidden max-w-72 truncate md:table-cell">
                <Mono className="text-muted-foreground">{shortSha(deployment.trigger.source_sha) ?? (deployment.image_ref ? shortDigest(deployment.image_ref) : null) ?? '—'}</Mono>
              </TableCell>
              <TableCell className="text-muted-foreground">{ago(deployment.started_at ?? deployment.created_at)}</TableCell>
              <TableCell className="hidden text-muted-foreground tabular-nums sm:table-cell">{duration(deployment.started_at, deployment.finished_at)}</TableCell>
              <TableCell className="relative z-10 text-right">
                {deployment.id !== service.current_deployment_id && (deployment.status === 'superseded' || deployment.status === 'active') && <RollbackButton service={service} deployment={deployment} />}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function ServicePage() {
  const { service: id } = Route.useParams()
  const { tab = 'deployments' } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const service = useQuery(serviceQuery(id))
  const environment = useQuery({ ...environmentQuery(service.data?.environment_id ?? ''), enabled: Boolean(service.data) })
  const project = useQuery({ ...projectQuery(environment.data?.project_id ?? ''), enabled: Boolean(environment.data) })

  if (service.isPending) return <Rows count={6} />
  if (service.isError) return <ErrorState error={service.error} title="The service could not be loaded" />
  const s = service.data
  const current = s.current_deployment

  return (
    <div className="space-y-6">
      <div>
        <Crumbs
          items={[
            { label: 'Projects', to: '/' },
            ...(project.data && environment.data
              ? [
                  { label: project.data.name, to: '/projects/$project', params: { project: project.data.name } },
                  { label: environment.data.name, to: '/projects/$project/$environment', params: { project: project.data.name, environment: environment.data.name } }
                ]
              : []),
            { label: s.name }
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
              {environment.data?.protected && <span>protected environment: changes are staged</span>}
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
        <div className="rounded-lg border bg-card p-4">
          <KeyValue
            items={[
              [
                'Current deployment',
                <Link key="d" to="/deployments/$deployment" params={{ deployment: current.id }} className="inline-flex items-center gap-2 underline-offset-4 hover:underline">
                  #{current.number} <DeploymentStatusBadge status={current.status} />
                </Link>
              ],
              ['Trigger', current.trigger.type],
              ['Started', ago(current.started_at)],
              ['Strategy', current.strategy]
            ]}
          />
        </div>
      )}
      <Tabs value={tab} onValueChange={value => void navigate({ search: { tab: value as Tab }, replace: true })}>
        <TabsList>
          <TabsTrigger value="deployments">Deployments</TabsTrigger>
          <TabsTrigger value="variables">Variables</TabsTrigger>
          <TabsTrigger value="network">Network</TabsTrigger>
        </TabsList>
        <TabsContent value="deployments" className="mt-4">
          <Deployments service={s} />
        </TabsContent>
        <TabsContent value="variables" className="mt-4">
          <VariablesPanel target={{ kind: 'service', service: s.id }} />
        </TabsContent>
        <TabsContent value="network" className="mt-4 space-y-10">
          <PublicNetworking service={s} protectedEnvironment={environment.data?.protected ?? false} />
          <ServiceNetwork service={s} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
