import { useQuery } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Box, Clock, Plus, ShieldCheck } from 'lucide-react'
import { lazy, Suspense, useState } from 'react'

import { Crumbs } from '@/components/crumbs'
import { NewEnvironment } from '@/components/new-environment'
import { NewService } from '@/components/new-service'
import { Empty, ErrorState, Mono, PageHeader, Rows } from '@/components/page'
import { noItems, QueryState } from '@/components/query-state'
import { SandboxesPanel } from '@/components/sandboxes-panel'
import { DeploymentStatusBadge, ServiceStatus, StagedStatusBadge } from '@/components/status'
import { TableFrame } from '@/components/table-frame'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { VariablesPanel } from '@/components/variables-panel'
import { api, idempotency, send, type Environment } from '@/lib/api'
import { actorText, ago, byName, plural, shortSha, sourceText } from '@/lib/format'
import { useApiMutation } from '@/lib/mutation'
import { environmentsQuery, environmentStagedQuery, servicesQuery } from '@/lib/queries'
import { countPill, toneOutline, toneText } from '@/lib/tone'
import { cn } from '@/lib/utils'

const NetworkPanel = lazy(() =>
  import('@/components/network-panel').then((m) => ({
    default: m.NetworkPanel,
  })),
)

const tabs = ['services', 'sandboxes', 'network', 'variables', 'staged', 'settings'] as const
type Tab = (typeof tabs)[number]

export const Route = createFileRoute('/_app/projects/$project/$environment')({
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } =>
    tabs.includes(search.tab as Tab)
      ? {
          tab: search.tab as Tab,
        }
      : {},
  component: EnvironmentPage,
})

function Services({ environment }: { environment: Environment }) {
  const [creating, setCreating] = useState(false)
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {environment.protected
            ? 'A new service in this protected environment is staged until a human accepts it.'
            : 'Services and their current deployments.'}
        </p>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus /> New service
        </Button>
      </div>
      <ServicesTable environment={environment} />
      {creating && (
        <NewService environment={environment} open={creating} onOpenChange={setCreating} />
      )}
    </div>
  )
}

function ServicesTable({ environment }: { environment: Environment }) {
  const services = useQuery(servicesQuery(environment.id))
  return (
    <QueryState
      query={services}
      rows={4}
      isEmpty={noItems}
      empty={
        <Empty title="No services in this environment">
          Create one with New service, <Mono>sly services create</Mono> or <Mono>sly apply</Mono>{' '}
          from a Manifest.
        </Empty>
      }
    >
      {(data) => (
        <TableFrame>
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
            {[...data.items].sort(byName).map((service) => {
              const current = service.current_deployment
              return (
                <TableRow key={service.id} className="relative">
                  <TableCell>
                    <Link
                      to="/services/$service"
                      params={{
                        service: service.id,
                      }}
                      className="flex items-center gap-2 font-medium after:absolute after:inset-0 focus-visible:outline-none"
                      data-testid="service-link"
                    >
                      <Box className="size-4 text-muted-foreground" aria-hidden />
                      {service.name}
                      <Badge variant="outline" className="font-normal">
                        {service.kind}
                      </Badge>
                      {service.stale && (
                        <Badge
                          variant="outline"
                          className={cn('font-normal', toneOutline.warning)}
                          title={(service.stale_reasons ?? []).map((r) => r.explanation).join(' ')}
                        >
                          {(service.stale_reasons ?? []).some((r) => r.code === 'VARIABLES_CHANGED')
                            ? 'variables changed'
                            : 'stale'}
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
                        <span className="text-muted-foreground tabular-nums">
                          #{current.number}
                        </span>
                        <DeploymentStatusBadge status={current.status} />
                        <span className="hidden text-xs text-muted-foreground sm:inline">
                          {ago(current.finished_at ?? current.started_at)}
                        </span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">never deployed</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden max-w-64 truncate lg:table-cell">
                    <Mono className="text-muted-foreground">{sourceText(service)}</Mono>
                    {current?.trigger.source_sha && (
                      <Mono className="ml-2">{shortSha(current.trigger.source_sha)}</Mono>
                    )}
                  </TableCell>
                  <TableCell className="hidden max-w-56 truncate md:table-cell">
                    {service.domains?.[0] ? (
                      <Mono>{service.domains[0].hostname}</Mono>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                    {(service.domains?.length ?? 0) > 1 && (
                      <span className="ml-1 text-xs text-muted-foreground">
                        +{service.domains!.length - 1}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </TableFrame>
      )}
    </QueryState>
  )
}

function StagedList({ environment }: { environment: Environment }) {
  const staged = useQuery(environmentStagedQuery(environment.id))
  return (
    <QueryState
      query={staged}
      isEmpty={noItems}
      empty={
        <Empty title="Nothing is waiting for review">
          {environment.protected
            ? 'Changes to this protected environment appear here until a human accepts them.'
            : 'This environment applies changes directly.'}
        </Empty>
      }
    >
      {(data) => (
        <ul className="divide-y overflow-hidden rounded-lg border">
          {data.items.map((change) => (
            <li
              key={change.id}
              className="relative flex flex-wrap items-center gap-x-4 gap-y-1 bg-card px-4 py-3 hover:bg-muted/40"
            >
              <Link
                to="/staged/$change"
                params={{
                  change: change.id,
                }}
                className="font-mono text-sm font-medium after:absolute after:inset-0"
              >
                {change.id}
              </Link>
              <StagedStatusBadge status={change.status} />
              <span className="text-sm text-muted-foreground">
                +{change.summary.add} ~{change.summary.update} −{change.summary.remove} ·{' '}
                {plural(change.summary.deployments, 'deployment')}
              </span>
              <span className="ml-auto text-xs text-muted-foreground">
                {actorText(change.actor)} · {ago(change.created_at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </QueryState>
  )
}

function Settings({ environment }: { environment: Environment }) {
  const mutation = useApiMutation({
    mutationFn: (value: boolean) =>
      send(
        api.v1
          .environments({
            environment: environment.id,
          })
          .patch(
            {
              protected: value,
            },
            idempotency(),
          ),
      ),
    invalidate: ['environments'],
    success: (env) =>
      env.protected ? `${env.name} is protected` : `${env.name} is no longer protected`,
    failure: () => 'Protection was not changed',
  })
  return (
    <div className="max-w-2xl rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-6">
        <div className="space-y-1">
          <Label htmlFor="protected" className="text-sm font-medium">
            Protected environment
          </Label>
          <p className="text-sm text-muted-foreground">
            Every change from a token, an agent or an OAuth client is staged, and a human accepts or
            rejects it. Only a human can change this switch.
          </p>
        </div>
        <Switch
          id="protected"
          checked={environment.protected}
          disabled={mutation.isPending}
          onCheckedChange={(value) => mutation.mutate(value)}
        />
      </div>
    </div>
  )
}

function EnvironmentPage() {
  const { project, environment: name } = Route.useParams()
  const environments = useQuery(environmentsQuery(project))
  return (
    <QueryState query={environments} rows={5} errorTitle="The project could not be loaded">
      {(data) => {
        const environment = data.items.find((e) => e.name === name)
        if (!environment)
          return (
            <ErrorState
              error={new Error(`There is no environment ${name} in ${project}.`)}
              title="Not found"
            />
          )
        return (
          <EnvironmentView project={project} environments={data.items} environment={environment} />
        )
      }}
    </QueryState>
  )
}

function EnvironmentView({
  project,
  environments,
  environment,
}: {
  project: string
  environments: Environment[]
  environment: Environment
}) {
  const { tab = 'services' } = Route.useSearch()
  const navigate = useNavigate({
    from: Route.fullPath,
  })

  return (
    <div className="space-y-6">
      <div>
        <Crumbs
          items={[
            {
              label: 'Projects',
              to: '/',
            },
            {
              label: project,
            },
          ]}
        />
        <PageHeader
          title={
            <span className="flex items-center gap-3">
              {project}
              <span className="text-muted-foreground">/</span>
              <Select
                value={environment.name}
                onValueChange={(value) =>
                  void navigate({
                    to: '/projects/$project/$environment',
                    params: {
                      project,
                      environment: value,
                    },
                    search: {
                      tab,
                    },
                  })
                }
              >
                <SelectTrigger
                  className="h-8 w-auto gap-2 text-base font-semibold"
                  aria-label="Environment"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {environments.map((e) => (
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
                  <ShieldCheck
                    className="size-3.5 text-emerald-600 dark:text-emerald-400"
                    aria-hidden
                  />{' '}
                  protected
                </span>
              )}
              {environment.ephemeral && (
                <span className="inline-flex items-center gap-1">
                  <Clock className="size-3.5" aria-hidden /> ephemeral
                </span>
              )}
              {environment.pending_staged_changes > 0 && (
                <Link
                  to="."
                  search={{
                    tab: 'staged',
                  }}
                  className={cn('underline-offset-4 hover:underline', toneText.warning)}
                >
                  {environment.pending_staged_changes} staged{' '}
                  {environment.pending_staged_changes === 1 ? 'change' : 'changes'} waiting
                </Link>
              )}
            </>
          }
          actions={
            <NewEnvironment project={project} environments={environments} current={environment} />
          }
        />
      </div>
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
            {environment.pending_staged_changes > 0 && (
              <span className={cn('ml-1', countPill)}>{environment.pending_staged_changes}</span>
            )}
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
          <VariablesPanel
            target={{
              kind: 'project',
              project: environment.project_id,
              environment: environment.name,
            }}
          />
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
