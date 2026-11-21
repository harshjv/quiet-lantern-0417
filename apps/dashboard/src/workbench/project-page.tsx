import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, type LinkOptions } from '@tanstack/react-router'
import { Plus, Settings } from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { AgentSheet } from '@/components/agent-sheet'
import { AlsoWith } from '@/components/code'
import { NewPreview } from '@/components/new-preview'
import { NewApp } from '@/components/new-service'
import { EmptyState } from '@/components/page'
import { Panel } from '@/components/panel'
import { Button } from '@/components/ui/button'
import { VariablesPanel } from '@/components/variables-panel'
import { agentHints } from '@/lib/agent-hints'
import type { App, Preview } from '@/lib/api'
import { commands } from '@/lib/commands'
import { byName } from '@/lib/format'
import { entityIcon } from '@/lib/icons'
import { inboxTo, placeTo } from '@/lib/links'
import { useLiveNetwork } from '@/lib/network-live'
import { scopeOf, type PlaceView } from '@/lib/place'
import { appQuery, canvasProjectQuery, previewsQuery } from '@/lib/queries'
import { useShortcut } from '@/lib/shortcuts'
import { countPill, toneDot } from '@/lib/tone'
import { cn } from '@/lib/utils'

import { AppPanel } from './app-panel'
import { PageBoundary } from './parts'
import { AppsLane, AppsLaneLoading, TasksLane, type CanvasProjectData } from './project-canvas'
import { PreviewSettings, ProjectSettings } from './ship-settings'
import { SidePanel } from './side-panel'

const projectTabs = ['environment-variables', 'settings'] as const

type ProjectTab = (typeof projectTabs)[number]

const frame = 'mx-auto flex w-full max-w-[96rem] flex-col gap-4 p-4 sm:p-6'

type Target = { app: string; tab: string | null } | null

export function ProjectPage({
  project,
  preview,
  app,
  tab,
}: {
  project: string
  preview: string | null
  app: Target
  tab: string | null
}) {
  return (
    <PageBoundary
      title="Couldn’t load this project"
      resetKey={`${project}/${preview}/${app?.app ?? ''}`}
    >
      <ProjectView project={project} preview={preview} app={app} tab={tab} />
    </PageBoundary>
  )
}

function ProjectView({
  project: projectRef,
  preview: previewName,
  app,
  tab,
}: {
  project: string
  preview: string | null
  app: Target
  tab: string | null
}) {
  const { data: project } = useSuspenseQuery(canvasProjectQuery(projectRef))
  const {
    data: { items: previews },
  } = useSuspenseQuery(previewsQuery(project.id))

  if (app) {
    return <AppView project={project} previews={previews} app={app.app} tab={app.tab} />
  }

  const preview = previewName === null ? null : previews.find((p) => p.name === previewName)

  if (previewName !== null && !preview) {
    return <Missing projectName={project.name} name={previewName} previews={previews} />
  }

  return (
    <Canvas
      project={project}
      previews={previews}
      preview={preview ?? null}
      app={null}
      tab={projectTabs.find((t) => t === tab) ?? null}
    />
  )
}

function AppView({
  project,
  previews,
  app: appId,
  tab,
}: {
  project: CanvasProjectData
  previews: Preview[]
  app: string
  tab: string | null
}) {
  const { data: app } = useSuspenseQuery(appQuery(appId))

  return (
    <Canvas
      project={project}
      previews={previews}
      preview={previews.find((p) => p.id === app.preview_id) ?? null}
      app={{
        row: app,
        tab,
      }}
      tab={null}
    />
  )
}

function Canvas({
  project,
  previews,
  preview,
  app,
  tab,
}: {
  project: CanvasProjectData
  previews: Preview[]
  preview: Preview | null
  app: { row: App; tab: string | null } | null
  tab: ProjectTab | null
}) {
  const place: PlaceView = {
    project: project.id,
    preview: preview?.id ?? null,
    projectName: project.name,
    previewName: preview?.name ?? null,
  }
  const live = useLiveNetwork(place, true)
  const [creating, setCreating] = useState(false)
  const here = placeTo(project.name, place.previewName)
  const side = app ? (
    <AppPanel app={app.row} place={place} live={live} tab={app.tab} closeTo={here} />
  ) : tab ? (
    <ProjectPanel place={place} preview={preview} tab={tab} closeTo={here} />
  ) : null

  useShortcut('create', () => setCreating(true))

  return (
    <div className={frame}>
      <h1 className="sr-only">{project.name}</h1>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PlaceSwitch project={project.name} previews={previews} current={place.previewName} />
        <div className="flex flex-wrap items-center gap-2">
          {place.preview === null && project.waiting_approvals > 0 && (
            <Button asChild size="sm" variant="outline">
              <Link {...inboxTo(project.name)}>
                Approvals <span className={countPill}>{project.waiting_approvals}</span>
              </Link>
            </Button>
          )}
          <Button asChild size="sm" variant="outline">
            <Link {...placeTo(project.name, place.previewName, 'environment-variables')}>
              <entityIcon.environment_variable /> Environment variables
            </Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link {...placeTo(project.name, place.previewName, 'settings')}>
              <Settings /> Settings
            </Link>
          </Button>
          <AgentSheet
            hint={place.preview === null ? agentHints.production : agentHints.preview}
            scope={scopeOf(place)}
          />
          <NewPreview project={project.id} projectName={project.name} />
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus /> New app
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
        <div className="min-w-0 flex-1 border bg-card/40">
          <Panel
            title="Couldn’t load the apps"
            resetKey={place.preview}
            fallback={<AppsLaneLoading />}
          >
            <AppsLane
              place={place}
              project={project}
              live={live}
              focus={app?.row.id ?? null}
              onAddApp={() => setCreating(true)}
            />
          </Panel>
          {!app && <TasksLane project={project} />}
        </div>
        {side}
      </div>
      {creating && <NewApp place={place} open={creating} onOpenChange={setCreating} />}
    </div>
  )
}

function SwitchLink({
  to,
  on,
  tone,
  children,
}: {
  to: LinkOptions
  on: boolean
  tone: 'success' | 'info'
  children: ReactNode
}) {
  return (
    <Link
      {...to}
      aria-current={on ? 'page' : undefined}
      className={cn(
        'inline-flex h-8 shrink-0 items-center gap-2 px-3 text-sm font-medium whitespace-nowrap text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        on && 'bg-background text-foreground shadow-xs',
      )}
    >
      <span className={cn('size-2', toneDot[tone])} aria-hidden />
      {children}
    </Link>
  )
}

function PlaceSwitch({
  project,
  previews,
  current,
}: {
  project: string
  previews: Preview[]
  current: string | null
}) {
  const named = previews.filter((p) => p.origin.type === 'named').sort(byName)
  const temporary = previews.filter((p) => p.origin.type !== 'named').sort(byName)

  return (
    <nav
      aria-label="Production or preview"
      className="inline-flex max-w-full gap-1 overflow-x-auto border bg-muted/40 p-1"
    >
      <SwitchLink to={placeTo(project, null)} on={current === null} tone="success">
        Production
      </SwitchLink>
      {[...named, ...temporary].map((p) => (
        <SwitchLink key={p.id} to={placeTo(project, p.name)} on={current === p.name} tone="info">
          Preview {p.name}
        </SwitchLink>
      ))}
    </nav>
  )
}

const projectTabLabel: Record<ProjectTab, string> = {
  'environment-variables': 'Environment variables',
  settings: 'Settings',
}

function ProjectPanel({
  place,
  preview,
  tab,
  closeTo,
}: {
  place: PlaceView
  preview: Preview | null
  tab: ProjectTab
  closeTo: LinkOptions
}) {
  return (
    <SidePanel
      title={projectTabLabel[tab]}
      icon={tab === 'settings' ? Settings : entityIcon.environment_variable}
      closeTo={closeTo}
    >
      {tab === 'environment-variables' ? (
        <VariablesPanel
          target={{
            kind: 'project',
            project: place.project,
            target: place.preview === null ? 'production' : 'preview',
          }}
          also={
            <AlsoWith
              cli={commands.setProjectVariable(scopeOf(place))}
              tool="set_project_environment_variables"
            />
          }
        />
      ) : preview ? (
        <PreviewSettings place={place} preview={preview} />
      ) : (
        <ProjectSettings project={place.project} />
      )}
    </SidePanel>
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
    <div className={frame}>
      <h1 className="sr-only">{projectName}</h1>
      <EmptyState
        icon={entityIcon.preview}
        title={`Preview “${name}” isn’t in ${projectName}`}
        action={
          <div className="flex flex-wrap justify-center gap-2">
            <Button asChild size="sm" variant="outline">
              <Link {...placeTo(projectName, null)}>Production</Link>
            </Button>
            {previews.map((p) => (
              <Button key={p.id} asChild size="sm" variant="outline">
                <Link {...placeTo(projectName, p.name)}>{p.name}</Link>
              </Button>
            ))}
          </div>
        }
      />
    </div>
  )
}
