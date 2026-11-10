import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { Box, Clock, Inbox, Layers, Plus, ShieldCheck } from 'lucide-react'
import { lazy, useState } from 'react'

import { Actor, AgentsLink } from '@/components/actor'
import { AgentSheet } from '@/components/agent-sheet'
import { AlsoWith, Code } from '@/components/code'
import { Crumbs } from '@/components/crumbs'
import { NewEnvironment } from '@/components/new-environment'
import { NewService } from '@/components/new-service'
import { EmptyState, PageHeader } from '@/components/page'
import { failurePage, Panel } from '@/components/panel'
import { SandboxesPanel } from '@/components/sandboxes-panel'
import { DeploymentStatusBadge, ServiceStatus, StagedStatusBadge } from '@/components/status'
import { TableFrame } from '@/components/table-frame'
import { Term } from '@/components/term'
import { Time } from '@/components/time'
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { VariablesPanel } from '@/components/variables-panel'
import { agentHints } from '@/lib/agent-hints'
import { api, idempotency, send, type Environment } from '@/lib/api'
import { commands } from '@/lib/commands'
import { byName, changeSummary, plural, shortSha, sourceText } from '@/lib/format'
import { serviceKind } from '@/lib/labels'
import { useApiMutation } from '@/lib/mutation'
import {
  environmentsQuery,
  environmentStagedQuery,
  load,
  seedEnvironment,
  servicesQuery,
  warm,
} from '@/lib/queries'
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
  loader: async ({ context, params }) => {
    const environments = await load(context.queryClient, environmentsQuery(params.project))
    const environment = environments.items.find((e) => e.name === params.environment)
    if (environment) await warm(context.queryClient, servicesQuery(environment.id))
  },
  errorComponent: failurePage('Couldn’t load this environment'),
  component: EnvironmentPage,
})

function Services({ project, environment }: { project: string; environment: Environment }) {
  const [creating, setCreating] = useState(false)
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {environment.protected
            ? 'New services wait for your review before Stationly creates them.'
            : 'Services and their current deployments.'}
        </p>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus /> New service
        </Button>
      </div>
      <Panel rows={4} title="Couldn’t load services">
        <ServicesTable
          project={project}
          environment={environment}
          onCreate={() => setCreating(true)}
        />
      </Panel>
      {creating && (
        <NewService environment={environment} open={creating} onOpenChange={setCreating} />
      )}
    </div>
  )
}

function ServicesTable({
  project,
  environment,
  onCreate,
}: {
  project: string
  environment: Environment
  onCreate: () => void
}) {
  const { data } = useSuspenseQuery(servicesQuery(environment.id))
  if (data.items.length === 0)
    return (
      <EmptyState
        icon={Box}
        title="No services yet"
        description={
          <>
            A service runs an image or a repository and gets an{' '}
            <Term name="internalName">internal name</Term> like web.internal.
          </>
        }
        action={
          <Button size="sm" onClick={onCreate}>
            <Plus /> New service
          </Button>
        }
        also={
          <AlsoWith
            cli={commands.createService({
              project,
              environment: environment.name,
            })}
            tool="create_service"
          />
        }
      />
    )
  return (
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
                    {serviceKind[service.kind]}
                  </Badge>
                  {service.stale && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge
                          variant="outline"
                          className={cn('relative z-10 font-normal', toneOutline.warning)}
                        >
                          Needs deploy
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent className="block space-y-1">
                        {(service.stale_reasons ?? []).map((r) => (
                          <p key={r.code}>{r.explanation}</p>
                        ))}
                      </TooltipContent>
                    </Tooltip>
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
                    <Time
                      value={current.finished_at ?? current.started_at}
                      className="hidden text-xs text-muted-foreground sm:inline"
                    />
                  </span>
                ) : (
                  <span className="text-muted-foreground">Not deployed</span>
                )}
              </TableCell>
              <TableCell className="hidden max-w-64 truncate lg:table-cell">
                <span className="font-mono text-[0.8125rem] text-muted-foreground">
                  {sourceText(service)}
                </span>
                {current?.trigger.source_sha && (
                  <Code className="ml-2">{shortSha(current.trigger.source_sha)}</Code>
                )}
              </TableCell>
              <TableCell className="hidden max-w-56 truncate md:table-cell">
                {service.domains?.[0] ? (
                  <span className="font-mono text-[0.8125rem]">{service.domains[0].hostname}</span>
                ) : (
                  <span className="text-muted-foreground">none</span>
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
  )
}

function StagedList({ environment }: { environment: Environment }) {
  const { data } = useSuspenseQuery(environmentStagedQuery(environment.id))
  if (data.items.length === 0)
    return environment.protected ? (
      <EmptyState
        icon={Inbox}
        title="No staged changes"
        description={
          <>
            Changes from <AgentsLink /> and tokens wait here until you accept or reject them.
          </>
        }
      />
    ) : (
      <EmptyState
        icon={Inbox}
        title="No staged changes"
        description="This environment applies changes at once. Protect it to review changes from agents and tokens first."
        action={
          <Button asChild size="sm" variant="outline">
            <Link
              to="."
              search={{
                tab: 'settings',
              }}
            >
              <ShieldCheck /> Protect environment
            </Link>
          </Button>
        }
      />
    )
  return (
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
          <span className="text-sm text-muted-foreground">{changeSummary(change.summary)}</span>
          <span className="ml-auto text-xs text-muted-foreground">
            <Actor actor={change.actor} /> · <Time value={change.created_at} />
          </span>
        </li>
      ))}
    </ul>
  )
}

function Settings({ project, environment }: { project: string; environment: Environment }) {
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
    seed: (env) => seedEnvironment(project, env),
    invalidate: ['environments'],
    success: (env) =>
      env.protected ? `${env.name} is protected` : `${env.name} is no longer protected`,
    failure: () => 'change protection',
  })
  return (
    <div className="max-w-2xl rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-6">
        <div className="space-y-1">
          <Label htmlFor="protected" className="text-sm font-medium">
            Protected environment
          </Label>
          <p className="text-sm text-muted-foreground">
            Changes from agents and tokens wait for you to accept or reject them. Agents and tokens
            can’t change this setting.
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
  const { tab = 'services' } = Route.useSearch()
  const navigate = useNavigate({
    from: Route.fullPath,
  })
  const {
    data: { items: environments },
  } = useSuspenseQuery(environmentsQuery(project))
  const environment = environments.find((e) => e.name === name)
  if (!environment)
    return (
      <EmptyState
        icon={Layers}
        title={`Environment “${name}” isn’t in ${project}`}
        description={
          environments.length
            ? 'Pick one of its environments.'
            : 'This project has no environments yet.'
        }
        action={
          <div className="flex flex-wrap justify-center gap-2">
            {environments.map((e) => (
              <Button key={e.id} asChild size="sm" variant="outline">
                <Link
                  to="/projects/$project/$environment"
                  params={{
                    project,
                    environment: e.name,
                  }}
                >
                  {e.name}
                </Link>
              </Button>
            ))}
          </div>
        }
      />
    )

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
              <span>{plural(environment.service_count, 'service')}</span>
              {environment.protected && (
                <span className="inline-flex items-center gap-1 text-foreground">
                  <ShieldCheck
                    className="size-3.5 text-emerald-600 dark:text-emerald-400"
                    aria-hidden
                  />
                  <Term name="protectedEnvironment">Protected</Term>
                </span>
              )}
              {environment.ephemeral && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center gap-1" tabIndex={0}>
                      <Clock className="size-3.5" aria-hidden /> Temporary
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>Stationly deletes it when its time to live ends.</TooltipContent>
                </Tooltip>
              )}
              {environment.pending_staged_changes > 0 && (
                <Link
                  to="."
                  search={{
                    tab: 'staged',
                  }}
                  className={cn('underline-offset-4 hover:underline', toneText.warning)}
                >
                  {plural(environment.pending_staged_changes, 'staged change')} waiting
                </Link>
              )}
            </>
          }
          actions={
            <>
              <AgentSheet
                hint={agentHints['/_app/projects/$project/$environment']}
                scope={{
                  project,
                  environment: environment.name,
                }}
              />
              <NewEnvironment project={project} environments={environments} current={environment} />
            </>
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
          <TabsTrigger value="variables">Project variables</TabsTrigger>
          <TabsTrigger value="staged">
            Staged changes
            {environment.pending_staged_changes > 0 && (
              <span className={cn('ml-1', countPill)}>{environment.pending_staged_changes}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="services" className="mt-4">
          <Services project={project} environment={environment} />
        </TabsContent>
        <TabsContent value="sandboxes" className="mt-4">
          <SandboxesPanel environment={environment} project={project} />
        </TabsContent>
        <TabsContent value="network" className="mt-4">
          <Panel rows={4} title="Couldn’t load the network map">
            <NetworkPanel project={project} environment={environment} />
          </Panel>
        </TabsContent>
        <TabsContent value="variables" className="mt-4">
          <VariablesPanel
            target={{
              kind: 'project',
              project: environment.project_id,
              environment: environment.name,
            }}
            also={
              <AlsoWith
                cli={commands.setProjectVariable({
                  project,
                  environment: environment.name,
                })}
                tool="set_project_variables"
              />
            }
          />
        </TabsContent>
        <TabsContent value="staged" className="mt-4">
          <Panel title="Couldn’t load staged changes">
            <StagedList environment={environment} />
          </Panel>
        </TabsContent>
        <TabsContent value="settings" className="mt-4">
          <Settings project={project} environment={environment} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
