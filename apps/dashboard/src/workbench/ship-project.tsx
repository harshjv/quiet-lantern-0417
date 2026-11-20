import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Clock, GitBranch, GitPullRequest, Inbox, Layers, Plus } from 'lucide-react'
import { lazy, useState } from 'react'

import { Actor } from '@/components/actor'
import { AgentSheet } from '@/components/agent-sheet'
import { AlsoWith, Code } from '@/components/code'
import { NewPreview } from '@/components/new-preview'
import { NewApp } from '@/components/new-service'
import { EmptyState } from '@/components/page'
import { Panel } from '@/components/panel'
import { MachinesPanel } from '@/components/sandboxes-panel'
import { ApprovalStatusBadge, AppStatus, DeploymentStatusBadge } from '@/components/status'
import { TableFrame } from '@/components/table-frame'
import { Term } from '@/components/term'
import { Time } from '@/components/time'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { VariablesPanel } from '@/components/variables-panel'
import { agentHints } from '@/lib/agent-hints'
import type { Approval, Preview } from '@/lib/api'
import { approvalHeadline, type Names, type Places } from '@/lib/changes'
import { commands } from '@/lib/commands'
import { byName, changeSummary, plural, shortSha, sourceText } from '@/lib/format'
import { entityIcon } from '@/lib/icons'
import { appKind } from '@/lib/labels'
import { appTo, placeTo } from '@/lib/links'
import { isProduction, scopeOf, type PlaceView } from '@/lib/place'
import { appsQuery, previewsQuery, projectApprovalsQuery, projectQuery } from '@/lib/queries'
import { useShortcut } from '@/lib/shortcuts'
import { countPill, toneOutline, toneText } from '@/lib/tone'
import { cn } from '@/lib/utils'

import { useNames, usePlaces } from './names'
import {
  ItemList,
  ItemRow,
  Notice,
  Page,
  PageBoundary,
  PageTabPanel,
  PageTabs,
  Section,
} from './parts'
import { PreviewSettings, ProjectSettings } from './ship-settings'

const NetworkPanel = lazy(() =>
  import('@/components/network-panel').then((m) => ({
    default: m.NetworkPanel,
  })),
)

const tabs = [
  'apps',
  'previews',
  'machines',
  'network',
  'environment-variables',
  'approvals',
  'settings',
] as const

type Tab = (typeof tabs)[number]

const tabLabel: Record<Tab, string> = {
  apps: 'Apps',
  previews: 'Previews',
  machines: 'Machines',
  network: 'Network',
  'environment-variables': 'Environment variables',
  approvals: 'Approvals',
  settings: 'Settings',
}

const productionValue = ':production'

const lasting = (preview: Preview) => preview.origin.type === 'named'

const originText = (preview: Preview) =>
  preview.origin.type === 'pull_request'
    ? `${preview.origin.repo}#${preview.origin.number}`
    : preview.origin.type === 'task'
      ? 'From a task'
      : 'Named'

const placeOfTab = (place: PlaceView, tab: Tab | null) =>
  placeTo(place.projectName, place.previewName, tab === 'apps' ? undefined : (tab ?? undefined))

export function ProjectShip({
  project,
  preview,
  tab,
}: {
  project: string
  preview: string | null
  tab: string | null
}) {
  return (
    <PageBoundary title="Couldn’t load this project" resetKey={`${project}/${preview}`}>
      <ProjectView project={project} preview={preview} tab={tab} />
    </PageBoundary>
  )
}

function ProjectView({
  project: projectRef,
  preview: previewName,
  tab,
}: {
  project: string
  preview: string | null
  tab: string | null
}) {
  const { data: project } = useSuspenseQuery(projectQuery(projectRef))
  const {
    data: { items: previews },
  } = useSuspenseQuery(previewsQuery(project.id))
  const preview = previewName === null ? null : previews.find((p) => p.name === previewName)

  if (previewName !== null && !preview) {
    return <Missing projectName={project.name} name={previewName} previews={previews} />
  }

  return (
    <PlaceScreen
      place={{
        project: project.id,
        preview: preview?.id ?? null,
        projectName: project.name,
        previewName: preview?.name ?? null,
      }}
      preview={preview ?? null}
      previews={previews}
      waiting={project.waiting_approvals}
      tab={tab}
    />
  )
}

function PlaceScreen({
  place,
  preview,
  previews,
  waiting,
  tab,
}: {
  place: PlaceView
  preview: Preview | null
  previews: Preview[]
  waiting: number
  tab: string | null
}) {
  const production = isProduction(place)
  const visible = tabs.filter((t) => production || (t !== 'previews' && t !== 'approvals'))
  const current = visible.find((t) => t === tab) ?? 'apps'
  const navigate = useNavigate()
  const select = (next: string) => {
    const found = visible.find((t) => t === next)

    if (found) {
      void navigate(placeOfTab(place, found))
    }
  }

  useShortcut('tab', (index) => {
    const next = visible[index]

    if (next) {
      select(next)
    }
  })

  return (
    <Page
      title={place.projectName}
      actions={
        <span className="flex flex-wrap items-center gap-2">
          <PlaceSwitcher place={place} previews={previews} tab={current} />
          <AgentSheet
            hint={production ? agentHints.production : agentHints.preview}
            scope={scopeOf(place)}
          />
          <NewPreview project={place.project} projectName={place.projectName} />
        </span>
      }
    >
      <PlaceFacts place={place} preview={preview} waiting={waiting} />
      <PageTabs value={current} onValueChange={select}>
        <TabsList className="max-w-full justify-start overflow-x-auto">
          {visible.map((t) => (
            <TabsTrigger key={t} value={t}>
              {tabLabel[t]}
              {t === 'approvals' && waiting > 0 && (
                <span className={cn('ml-1', countPill)}>{waiting}</span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
        <PageTabPanel value={current}>
          <TabBody tab={current} place={place} preview={preview} waiting={waiting} />
        </PageTabPanel>
      </PageTabs>
    </Page>
  )
}

function TabBody({
  tab,
  place,
  preview,
  waiting,
}: {
  tab: Tab
  place: PlaceView
  preview: Preview | null
  waiting: number
}) {
  if (tab === 'previews') {
    return <PreviewsTab place={place} />
  }

  if (tab === 'machines') {
    return <MachinesPanel place={place} />
  }

  if (tab === 'network') {
    return (
      <Panel rows={4} title="Couldn’t load the network map">
        <NetworkPanel place={place} />
      </Panel>
    )
  }

  if (tab === 'environment-variables') {
    return (
      <VariablesPanel
        target={{
          kind: 'project',
          project: place.project,
          target: isProduction(place) ? 'production' : 'preview',
        }}
        also={
          <AlsoWith
            cli={commands.setProjectVariable(scopeOf(place))}
            tool="set_project_environment_variables"
          />
        }
      />
    )
  }

  if (tab === 'approvals') {
    return (
      <Panel title="Couldn’t load approvals">
        <ApprovalsTab project={place.project} />
      </Panel>
    )
  }

  if (tab === 'settings') {
    return preview ? (
      <PreviewSettings place={place} preview={preview} />
    ) : (
      <ProjectSettings project={place.project} />
    )
  }

  return <AppsTab place={place} waiting={waiting} />
}

function PlaceSwitcher({
  place,
  previews,
  tab,
}: {
  place: PlaceView
  previews: Preview[]
  tab: Tab
}) {
  const named = previews.filter(lasting).sort(byName)
  const temporary = previews.filter((p) => !lasting(p)).sort(byName)
  const navigate = useNavigate()
  const switchTo = (value: string) => {
    const keep = tab === 'previews' || tab === 'approvals' ? null : tab

    void navigate(
      placeOfTab(
        {
          ...place,
          previewName: value === productionValue ? null : value,
        },
        keep,
      ),
    )
  }

  return (
    <Select value={place.previewName ?? productionValue} onValueChange={switchTo}>
      <SelectTrigger className="h-8 w-auto min-w-40 gap-2" aria-label="Production or preview">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={productionValue}>production</SelectItem>
        {named.length > 0 && (
          <SelectGroup>
            <SelectLabel>Previews</SelectLabel>
            {named.map((p) => (
              <SelectItem key={p.id} value={p.name}>
                {p.name}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
        {temporary.length > 0 && (
          <SelectGroup>
            <SelectLabel>Task and pull request previews</SelectLabel>
            {temporary.map((p) => (
              <SelectItem key={p.id} value={p.name}>
                {p.name}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
      </SelectContent>
    </Select>
  )
}

function PlaceFacts({
  place,
  preview,
  waiting,
}: {
  place: PlaceView
  preview: Preview | null
  waiting: number
}) {
  return (
    <p className="-mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
      {preview ? (
        <>
          <span className="inline-flex items-center gap-1.5">
            <Layers className="size-3.5" aria-hidden /> Preview {preview.name}
          </span>
          <span>{plural(preview.app_count, 'app')}</span>
          <span>{originText(preview)}</span>
          {preview.expires_at && <Expiry at={preview.expires_at} />}
        </>
      ) : (
        <span className="text-foreground">
          <Term name="production">Production</Term>. Every change waits for an approval.
        </span>
      )}
      {isProduction(place) && waiting > 0 && (
        <Link
          {...placeTo(place.projectName, null, 'approvals')}
          className={cn('underline-offset-4 hover:underline', toneText.warning)}
        >
          {plural(waiting, 'approval')} waiting
        </Link>
      )}
    </p>
  )
}

function Expiry({ at }: { at: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex items-center gap-1" tabIndex={0}>
          <Clock className="size-3.5" aria-hidden /> Temporary
        </span>
      </TooltipTrigger>
      <TooltipContent>
        Stationly deletes it at <Time value={at} />.
      </TooltipContent>
    </Tooltip>
  )
}

function WaitingNotice({ place, waiting }: { place: PlaceView; waiting: number }) {
  if (!isProduction(place) || waiting === 0) {
    return null
  }

  return (
    <Notice
      tone="warning"
      title={`${plural(waiting, 'change')} to production ${waiting === 1 ? 'waits' : 'wait'} for an approval`}
      action={
        <Button asChild size="sm" variant="outline">
          <Link {...placeTo(place.projectName, null, 'approvals')}>Review</Link>
        </Button>
      }
    >
      Nothing changes in production until an admin approves it. A new app appears here once its
      approval goes through.
    </Notice>
  )
}

function AppsTab({ place, waiting }: { place: PlaceView; waiting: number }) {
  const [creating, setCreating] = useState(false)

  useShortcut('create', () => setCreating(true))

  return (
    <Section
      icon={entityIcon.app}
      title="Apps"
      note={
        isProduction(place)
          ? 'New apps in production wait for an approval before Stationly creates them.'
          : 'Apps of this preview and their current deployments.'
      }
      action={
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus /> New app
        </Button>
      }
    >
      <WaitingNotice place={place} waiting={waiting} />
      <Panel rows={4} title="Couldn’t load apps">
        <AppsTable place={place} onCreate={() => setCreating(true)} />
      </Panel>
      {creating && <NewApp place={place} open={creating} onOpenChange={setCreating} />}
    </Section>
  )
}

function AppsTable({ place, onCreate }: { place: PlaceView; onCreate: () => void }) {
  const { data } = useSuspenseQuery(appsQuery(place))

  if (data.items.length === 0) {
    return (
      <EmptyState
        icon={entityIcon.app}
        title="No apps yet"
        description={
          <>
            An app runs an image or a repository and gets an{' '}
            <Term name="internalName">internal name</Term> like web.internal.
          </>
        }
        action={
          <Button size="sm" onClick={onCreate}>
            <Plus /> New app
          </Button>
        }
        also={<AlsoWith cli={commands.createApp(scopeOf(place))} tool="create_app" />}
      />
    )
  }

  return (
    <TableFrame>
      <TableHeader>
        <TableRow>
          <TableHead>App</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Deployment</TableHead>
          <TableHead className="hidden lg:table-cell">Source</TableHead>
          <TableHead className="hidden md:table-cell">Domain</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {[...data.items].sort(byName).map((app) => {
          const current = app.current_deployment
          const domains = app.domains ?? []

          return (
            <TableRow key={app.id} className="relative">
              <TableCell>
                <Link
                  {...appTo(app.id)}
                  className="flex items-center gap-2 font-medium after:absolute after:inset-0 focus-visible:outline-none"
                  data-testid="app-link"
                >
                  <entityIcon.app className="size-4 text-muted-foreground" aria-hidden />
                  {app.name}
                  <Badge variant="outline" className="font-normal">
                    {appKind[app.kind]}
                  </Badge>
                  {app.stale && (
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
                        {(app.stale_reasons ?? []).map((r) => (
                          <p key={r.code}>{r.explanation}</p>
                        ))}
                      </TooltipContent>
                    </Tooltip>
                  )}
                </Link>
              </TableCell>
              <TableCell>
                <AppStatus status={app.status} reason={app.status_reason} />
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
                  <span className="text-muted-foreground">none</span>
                )}
              </TableCell>
              <TableCell className="hidden max-w-64 truncate lg:table-cell">
                <span className="font-mono text-xs text-muted-foreground">{sourceText(app)}</span>
                {current?.trigger.source_sha && (
                  <Code className="ml-2">{shortSha(current.trigger.source_sha)}</Code>
                )}
              </TableCell>
              <TableCell className="hidden max-w-56 truncate md:table-cell">
                {domains[0] ? (
                  <span className="font-mono text-xs">{domains[0].hostname}</span>
                ) : (
                  <span className="text-muted-foreground">none</span>
                )}
                {domains.length > 1 && (
                  <span className="ml-1 text-xs text-muted-foreground">+{domains.length - 1}</span>
                )}
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </TableFrame>
  )
}

function PreviewsTab({ place }: { place: PlaceView }) {
  const {
    data: { items },
  } = useSuspenseQuery(previewsQuery(place.project))
  const previews = [...items].sort(byName)

  return (
    <Section
      icon={entityIcon.preview}
      title="Previews"
      count={previews.length}
      note="Copies of production’s apps on their own network, with preview values of project environment variables. A task’s preview gets generated domains; add a domain to an app here to reach it from outside. Named previews stay; task and pull request previews go when their work is done or they expire."
    >
      {previews.length === 0 ? (
        <EmptyState
          icon={entityIcon.preview}
          title="No previews yet"
          description="Create a named preview such as staging, start a task that asks for one, or open a pull request on a connected repository."
          also={<AlsoWith cli={commands.createPreview(place.projectName)} tool="create_preview" />}
        />
      ) : (
        <ItemList>
          {previews.map((preview) => (
            <ItemRow
              key={preview.id}
              icon={preview.origin.type === 'pull_request' ? GitPullRequest : GitBranch}
              title={
                <>
                  <Link
                    {...placeTo(place.projectName, preview.name)}
                    className="truncate underline-offset-4 hover:underline"
                  >
                    {preview.name}
                  </Link>
                  {preview.expires_at && <Expiry at={preview.expires_at} />}
                </>
              }
              meta={[
                {
                  kind: 'app',
                  text: plural(preview.app_count, 'app'),
                },
                {
                  kind: preview.origin.type === 'pull_request' ? 'branch' : 'status',
                  text: originText(preview),
                },
              ]}
              action={
                <Button asChild size="sm" variant="outline">
                  <Link {...placeTo(place.projectName, preview.name)}>Open</Link>
                </Button>
              }
            />
          ))}
        </ItemList>
      )}
    </Section>
  )
}

function ApprovalsTab({ project }: { project: string }) {
  const { data } = useSuspenseQuery(projectApprovalsQuery(project))
  const waiting = data.items.filter((a) => a.status === 'waiting')
  const decided = data.items.filter((a) => a.status !== 'waiting').slice(0, 10)
  const names = useNames([project])
  const places = usePlaces([project])

  return (
    <div className="flex flex-col gap-8">
      <Section
        icon={Inbox}
        title="Waiting"
        count={waiting.length}
        note="Every change to production waits here for an admin. Another admin approves it; the admin who asked approves their own only when no other admin can."
      >
        {waiting.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing waits for an approval.</p>
        ) : (
          <ApprovalRows items={waiting} names={names} places={places} />
        )}
      </Section>
      {decided.length > 0 && (
        <Section title="Recently decided" count={decided.length}>
          <ApprovalRows items={decided} names={names} places={places} />
        </Section>
      )}
    </div>
  )
}

function ApprovalRows({
  items,
  names,
  places,
}: {
  items: Approval[]
  names: Names
  places: Places
}) {
  return (
    <ul className="divide-y border">
      {items.map((approval) => (
        <li
          key={approval.id}
          className="relative flex flex-wrap items-center gap-x-4 gap-y-1 bg-card px-4 py-3 focus-within:bg-muted/40 hover:bg-muted/40"
        >
          <Link
            to="/approvals/$approval"
            params={{
              approval: approval.id,
            }}
            className="text-sm font-medium after:absolute after:inset-0 focus-visible:outline-none"
          >
            {approvalHeadline(approval, names, places)}
          </Link>
          <ApprovalStatusBadge status={approval.status} />
          <span className="text-sm text-muted-foreground">{changeSummary(approval.summary)}</span>
          <span className="ml-auto flex gap-3 text-xs text-muted-foreground">
            <Actor actor={approval.requested_by} />
            <Time value={approval.created_at} />
          </span>
        </li>
      ))}
    </ul>
  )
}

function Missing({
  projectName,
  name,
  previews,
}: {
  projectName: string
  name: string
  previews: Preview[]
}) {
  return (
    <Page title={projectName}>
      <EmptyState
        icon={entityIcon.preview}
        title={`Preview “${name}” isn’t in ${projectName}`}
        description="It may have expired or been deleted. Open production or one of its previews."
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button asChild size="sm" variant="outline">
              <Link {...placeTo(projectName, null)}>production</Link>
            </Button>
            {previews.map((p) => (
              <Button key={p.id} asChild size="sm" variant="outline">
                <Link {...placeTo(projectName, p.name)}>{p.name}</Link>
              </Button>
            ))}
          </div>
        }
      />
    </Page>
  )
}
