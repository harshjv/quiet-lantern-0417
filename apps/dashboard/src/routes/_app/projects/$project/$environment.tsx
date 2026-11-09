import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { Box, Clock, Plus, ShieldCheck } from 'lucide-react'
import { lazy, Suspense, useState } from 'react'
import { toast } from 'sonner'
import { Crumbs } from '@/components/crumbs'
import { NewEnvironment } from '@/components/new-environment'
import { NewService } from '@/components/new-service'
import { SandboxesPanel } from '@/components/sandboxes-panel'
import { Empty, ErrorState, Mono, PageHeader, Rows } from '@/components/page'
import { DeploymentStatusBadge, ServiceStatus, StagedStatusBadge } from '@/components/status'
import { VariablesPanel } from '@/components/variables-panel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, ApiFailure, idempotency, unwrap } from '@/lib/api'
import { ago, shortSha, sourceText } from '@/lib/format'
import { environmentStagedQuery, environmentsQuery, servicesQuery } from '@/lib/queries'
import type { Environment } from '@/lib/api'

const NetworkPanel = lazy(() => import('@/components/network-panel').then(m => ({ default: m.NetworkPanel })))

const tabs = ['services', 'sandboxes', 'network', 'variables', 'staged', 'settings'] as const
type Tab = (typeof tabs)[number]

export const Route = createFileRoute('/_app/projects/$project/$environment')({
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } => (tabs.includes(search.tab as Tab) ? { tab: search.tab as Tab } : {}),
  component: EnvironmentPage
})

function Services({ environment }: { environment: Environment }) {
  const [creating, setCreating] = useState(false)
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{environment.protected ? 'A new service in this protected environment is staged until a human accepts it.' : 'Services and their current deployments.'}</p>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus /> New service
        </Button>
      </div>
      <ServicesTable environment={environment} />
      {creating && <NewService environment={environment} open={creating} onOpenChange={setCreating} />}
    </div>
  )
}

function ServicesTable({ environment }: { environment: Environment }) {
  const services = useQuery(servicesQuery(environment.id))
  if (services.isPending) return <Rows count={4} />
  if (services.isError) return <ErrorState error={services.error} />
  if (services.data.items.length === 0)
    return (
      <Empty title="No services in this environment">
        Create one with New service, <Mono>sly services create</Mono> or <Mono>sly apply</Mono> from a Manifest.
      </Empty>
    )
  return (
    <div className="overflow-hidden rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Service</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Deployment</TableHead>
            <TableHead className="hidden lg:table-cell">Source</TableHead>
            <TableHead className="hidden md:table-cell">Domain</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {[...services.data.items]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(service => {
              const current = service.current_deployment
              return (
                <TableRow key={service.id} className="relative">
                  <TableCell>
                    <Link to="/services/$service" params={{ service: service.id }} className="flex items-center gap-2 font-medium after:absolute after:inset-0 focus-visible:outline-none" data-testid="service-link">
                      <Box className="size-4 text-muted-foreground" aria-hidden />
                      {service.name}
                      <Badge variant="outline" className="font-normal">
                        {service.kind}
                      </Badge>
                      {service.stale && (
                        <Badge variant="outline" className="border-amber-300 font-normal text-amber-800 dark:border-amber-800 dark:text-amber-300" title={(service.stale_reasons ?? []).map(r => r.explanation).join(' ')}>
                          {(service.stale_reasons ?? []).some(r => r.code === 'VARIABLES_CHANGED') ? 'variables changed' : 'stale'}
                        </Badge>
                      )}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <ServiceStatus status={service.status} reason={service.status_reason} />
                  </TableCell>
                  <TableCell>
                    {current ? (
                      <span className="flex items-center gap-2">
                        <span className="text-muted-foreground tabular-nums">#{current.number}</span>
                        <DeploymentStatusBadge status={current.status} />
                        <span className="hidden text-xs text-muted-foreground sm:inline">{ago(current.finished_at ?? current.started_at)}</span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">never deployed</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden max-w-64 truncate lg:table-cell">
                    <Mono className="text-muted-foreground">{sourceText(service)}</Mono>
                    {current?.trigger.source_sha && <Mono className="ml-2">{shortSha(current.trigger.source_sha)}</Mono>}
                  </TableCell>
                  <TableCell className="hidden max-w-56 truncate md:table-cell">
                    {service.domains?.[0] ? <Mono>{service.domains[0].hostname}</Mono> : <span className="text-muted-foreground">—</span>}
                    {(service.domains?.length ?? 0) > 1 && <span className="ml-1 text-xs text-muted-foreground">+{service.domains!.length - 1}</span>}
                  </TableCell>
                </TableRow>
              )
            })}
        </TableBody>
      </Table>
    </div>
  )
}

function StagedList({ environment }: { environment: Environment }) {
  const staged = useQuery(environmentStagedQuery(environment.id))
  if (staged.isPending) return <Rows />
  if (staged.isError) return <ErrorState error={staged.error} />
  if (staged.data.items.length === 0) return <Empty title="Nothing is waiting for review">{environment.protected ? 'Changes to this protected environment appear here until a human accepts them.' : 'This environment applies changes directly.'}</Empty>
  return (
    <ul className="divide-y overflow-hidden rounded-lg border">
      {staged.data.items.map(change => (
        <li key={change.id} className="relative flex flex-wrap items-center gap-x-4 gap-y-1 bg-card px-4 py-3 hover:bg-muted/40">
          <Link to="/staged/$change" params={{ change: change.id }} className="font-mono text-sm font-medium after:absolute after:inset-0">
            {change.id}
          </Link>
          <StagedStatusBadge status={change.status} />
          <span className="text-sm text-muted-foreground">
            +{change.summary.add} ~{change.summary.update} −{change.summary.remove} · {change.summary.deployments} deployments
          </span>
          <span className="ml-auto text-xs text-muted-foreground">
            {change.actor.type}
            {change.actor.client ? ` (${change.actor.client})` : ''} · {ago(change.created_at)}
          </span>
        </li>
      ))}
    </ul>
  )
}

function Settings({ environment }: { environment: Environment }) {
  const client = useQueryClient()
  const mutation = useMutation({
    mutationFn: (value: boolean) => unwrap(api.v1.environments({ environment: environment.id }).patch({ protected: value }, idempotency())),
    onSuccess: env => {
      void client.invalidateQueries({ queryKey: ['environments'] })
      toast.success(env.protected ? `${env.name} is protected` : `${env.name} is no longer protected`)
    },
    onError: failure => toast.error('Protection was not changed', { description: failure instanceof ApiFailure ? `${failure.code}: ${failure.message}` : String(failure) })
  })
  return (
    <div className="max-w-2xl rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-6">
        <div className="space-y-1">
          <Label htmlFor="protected" className="text-sm font-medium">
            Protected environment
          </Label>
          <p className="text-sm text-muted-foreground">Every change from a token, an agent or an OAuth client is staged, and a human accepts or rejects it. Only a human can change this switch.</p>
        </div>
        <Switch id="protected" checked={environment.protected} disabled={mutation.isPending} onCheckedChange={value => mutation.mutate(value)} />
      </div>
    </div>
  )
}

function EnvironmentPage() {
  const { project, environment: name } = Route.useParams()
  const { tab = 'services' } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const environments = useQuery(environmentsQuery(project))
  const environment = environments.data?.items.find(e => e.name === name)

  if (environments.isPending) return <Rows count={5} />
  if (environments.isError) return <ErrorState error={environments.error} title="The project could not be loaded" />
  if (!environment) return <ErrorState error={new Error(`There is no environment ${name} in ${project}.`)} title="Not found" />

  return (
    <div className="space-y-6">
      <div>
        <Crumbs items={[{ label: 'Projects', to: '/' }, { label: project }]} />
        <PageHeader
          title={
            <span className="flex items-center gap-3">
              {project}
              <span className="text-muted-foreground">/</span>
              <Select value={environment.name} onValueChange={value => void navigate({ to: '/projects/$project/$environment', params: { project, environment: value }, search: { tab } })}>
                <SelectTrigger className="h-8 w-auto gap-2 text-base font-semibold" aria-label="Environment">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {environments.data.items.map(e => (
                    <SelectItem key={e.id} value={e.name}>
                      {e.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </span>
          }
          meta={
            <>
              <span>{environment.service_count} services</span>
              {environment.protected && (
                <span className="inline-flex items-center gap-1 text-foreground">
                  <ShieldCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden /> protected
                </span>
              )}
              {environment.ephemeral && (
                <span className="inline-flex items-center gap-1">
                  <Clock className="size-3.5" aria-hidden /> ephemeral
                </span>
              )}
              {environment.pending_staged_changes > 0 && (
                <Link to="." search={{ tab: 'staged' }} className="text-amber-700 underline-offset-4 hover:underline dark:text-amber-400">
                  {environment.pending_staged_changes} staged {environment.pending_staged_changes === 1 ? 'change' : 'changes'} waiting
                </Link>
              )}
            </>
          }
          actions={<NewEnvironment project={project} environments={environments.data.items} current={environment} />}
        />
      </div>
      <Tabs value={tab} onValueChange={value => void navigate({ search: { tab: value as Tab }, replace: true })}>
        <TabsList className="max-w-full justify-start overflow-x-auto">
          <TabsTrigger value="services">Services</TabsTrigger>
          <TabsTrigger value="sandboxes">Sandboxes</TabsTrigger>
          <TabsTrigger value="network">Network</TabsTrigger>
          <TabsTrigger value="variables">
            <span className="hidden sm:inline">Project variables</span>
            <span className="sm:hidden">Variables</span>
          </TabsTrigger>
          <TabsTrigger value="staged">
            Staged
            {environment.pending_staged_changes > 0 && <span className="ml-1 rounded-full bg-amber-500 px-1.5 text-[0.6875rem] font-semibold text-amber-950">{environment.pending_staged_changes}</span>}
          </TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="services" className="mt-4">
          <Services environment={environment} />
        </TabsContent>
        <TabsContent value="sandboxes" className="mt-4">
          <SandboxesPanel environment={environment} project={project} />
        </TabsContent>
        <TabsContent value="network" className="mt-4">
          <Suspense fallback={<Rows count={4} />}>
            <NetworkPanel environment={environment} />
          </Suspense>
        </TabsContent>
        <TabsContent value="variables" className="mt-4">
          <VariablesPanel target={{ kind: 'project', project: environment.project_id, environment: environment.name }} />
        </TabsContent>
        <TabsContent value="staged" className="mt-4">
          <StagedList environment={environment} />
        </TabsContent>
        <TabsContent value="settings" className="mt-4">
          <Settings environment={environment} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
