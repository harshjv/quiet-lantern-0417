import { useQuery } from '@tanstack/react-query'
import { Box, ChevronRight, Folder, GitBranch, Plus } from 'lucide-react'
import { useState } from 'react'

import { AlsoWith } from '@/components/code'
import { GetStarted, useGetStarted } from '@/components/get-started'
import { NewProject } from '@/components/new-project'
import { EmptyState, ErrorState, Rows } from '@/components/page'
import { PlaceLink } from '@/components/place-link'
import { AppStatusDot } from '@/components/status'
import { Button } from '@/components/ui/button'
import type { AppStatus, Project } from '@/lib/api'
import { commands } from '@/lib/commands'
import { byName, plural } from '@/lib/format'
import { appStatus } from '@/lib/labels'
import { places, viewId, type Go, type Place } from '@/lib/nav'
import { projectsQuery } from '@/lib/queries'
import { useShortcut } from '@/lib/shortcuts'

import { MachinePage } from './machine-page'
import {
  appLink,
  failedApps,
  useLiveApps,
  useLivePreviews,
  useLiveProjects,
  type LiveApp,
} from './ops-live'
import { ItemList, ItemRow, Notice, Page, Section, StatusPill } from './parts'
import { AppPage } from './ship-app'
import { DeploymentPage } from './ship-deployment'
import { ProjectShip } from './ship-project'

const appPlace = (live: LiveApp) => ({
  ...places.app(live.app.id),
  project: live.place.project.name,
})

const statusOrder: AppStatus[] = [
  'failing',
  'deploying',
  'healthy',
  'asleep',
  'not_deployed',
  'stopped',
]

const fixOf = (live: LiveApp) =>
  live.newest?.status === 'failed' ? `deployment:${live.newest.id}` : `app:${live.app.id}`

export function LiveShip({ place, go }: { place: Place; go: Go }) {
  const app = viewId(place.view, 'app')
  const deployment = viewId(place.view, 'deployment')
  const machine = viewId(place.view, 'machine')

  if (app) {
    return <AppPage appId={app} />
  }

  if (deployment) {
    return <DeploymentPage deploymentId={deployment} />
  }

  if (machine) {
    return <MachinePage machineId={machine} />
  }

  if (place.project) {
    const [first, tab] = (place.view ?? '').split('/')
    const preview = viewId(first ?? null, 'preview')

    return (
      <ProjectShip
        project={place.project}
        preview={preview}
        tab={(preview ? tab : first) || null}
      />
    )
  }

  return <AllProjects go={go} />
}

function AllProjects({ go }: { go: Go }) {
  const projects = useQuery(projectsQuery)
  const [creating, setCreating] = useState(false)

  useShortcut('create', () => setCreating(true))

  return (
    <Page
      title="Ship"
      actions={
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus /> New project
        </Button>
      }
    >
      {projects.isError ? (
        <ErrorState
          error={projects.error}
          title="Couldn’t load your projects"
          onRetry={() => void projects.refetch()}
        />
      ) : !projects.data ? (
        <Rows count={3} />
      ) : (
        <Overview projects={projects.data.items} onCreate={() => setCreating(true)} go={go} />
      )}
      {creating && <NewProject open={creating} onOpenChange={setCreating} />}
    </Page>
  )
}

function Overview({
  projects,
  onCreate,
  go,
}: {
  projects: Project[]
  onCreate: () => void
  go: Go
}) {
  const guide = useGetStarted(projects)

  return (
    <>
      {guide.visible && <GetStarted guide={guide} />}
      {projects.length === 0 ? (
        !guide.visible && (
          <EmptyState
            icon={Folder}
            title="Create your first project"
            description="A project is one product: its apps, their production and previews, its keys and its tasks. Create one, then add its first app."
            action={
              <Button size="sm" onClick={onCreate}>
                <Plus /> New project
              </Button>
            }
            also={<AlsoWith cli={commands.createProject()} tool="create_project" />}
          />
        )
      ) : (
        <>
          <FailedDeploys go={go} />
          <Section icon={Folder} title="Projects" count={projects.length}>
            <ProjectCards projects={projects} />
          </Section>
          <Production />
          <Previews />
        </>
      )}
    </>
  )
}

function ProjectCards({ projects }: { projects: Project[] }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {[...projects].sort(byName).map((project) => (
        <li key={project.id}>
          <PlaceLink
            to={places.project(project.name)}
            className="group flex h-full flex-col gap-4 border bg-card p-4 transition-colors hover:border-foreground/25 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <span className="flex items-start justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2">
                <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="truncate font-medium">{project.name}</span>
              </span>
              <ChevronRight
                className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                aria-hidden
              />
            </span>
            <span className="mt-auto flex items-center justify-between gap-2 text-sm text-muted-foreground">
              <span className="flex flex-wrap gap-x-3">
                <span>{plural(project.app_count, 'app')}</span>
                <span>{plural(project.preview_count, 'preview')}</span>
                {project.waiting_approvals > 0 && (
                  <span>{plural(project.waiting_approvals, 'approval')} waiting</span>
                )}
              </span>
              <span className="flex items-center gap-2" aria-label="App status counts">
                {statusOrder
                  .filter((status) => project.status_counts[status] > 0)
                  .map((status) => (
                    <span
                      key={status}
                      className="inline-flex items-center gap-1 tabular-nums"
                      title={`${project.status_counts[status]} ${appStatus[status].label.toLowerCase()}`}
                    >
                      <AppStatusDot status={status} />
                      <span className="sr-only">{appStatus[status].label}</span>
                      {project.status_counts[status]}
                    </span>
                  ))}
              </span>
            </span>
          </PlaceLink>
        </li>
      ))}
    </ul>
  )
}

function FailedDeploys({ go }: { go: Go }) {
  const failed = failedApps(useLiveApps(null))

  return failed.map((live) => (
    <Notice
      key={live.app.id}
      tone="danger"
      title={`${live.app.name}: the last deploy failed`}
      action={
        <>
          <Button asChild size="sm" variant="outline">
            <PlaceLink to={appPlace(live)}>Open</PlaceLink>
          </Button>
          <Button
            size="sm"
            onClick={() =>
              go({
                mode: 'build',
                view: 'fix',
                fix: fixOf(live),
              })
            }
          >
            Fix with an agent
          </Button>
        </>
      }
    >
      {live.newest?.failure?.summary ?? 'The deployment did not become healthy.'}
    </Notice>
  ))
}

function Production() {
  const apps = useLiveApps(null).filter((live) => !live.place.preview)

  return (
    <Section icon={Box} title="Production" count={apps.length}>
      {apps.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No apps in production yet. Open a project to add one.
        </p>
      ) : (
        <ItemList>
          {apps.map((live) => {
            const status = appStatus[live.app.status]
            const link = appLink(live.app)

            return (
              <ItemRow
                key={live.app.id}
                icon={Box}
                tone={status.tone}
                title={
                  <>
                    <PlaceLink
                      to={appPlace(live)}
                      className="truncate underline-offset-4 hover:underline"
                    >
                      {live.app.name}
                    </PlaceLink>
                    <StatusPill tone={status.tone}>{status.label}</StatusPill>
                  </>
                }
                meta={[
                  {
                    kind: 'project',
                    text: live.place.project.name,
                  },
                  ...(live.newest
                    ? [
                        {
                          kind: 'version' as const,
                          text: `#${live.newest.number} ${live.newest.status}`,
                        },
                      ]
                    : []),
                  ...(link
                    ? [
                        {
                          kind: 'link' as const,
                          text: link,
                        },
                      ]
                    : []),
                ]}
                action={
                  <Button asChild size="sm" variant="outline">
                    <PlaceLink to={appPlace(live)}>Open</PlaceLink>
                  </Button>
                }
              />
            )
          })}
        </ItemList>
      )}
    </Section>
  )
}

function Previews() {
  const previews = useLivePreviews(useLiveProjects(null))

  return (
    <Section icon={GitBranch} title="Previews" count={previews.length}>
      {previews.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No previews. Make a preview from a task or a project, or open a pull request on a
          connected repository.
        </p>
      ) : (
        <ItemList>
          {previews.map((place) => {
            const origin = place.preview?.origin

            return (
              <ItemRow
                key={place.key}
                icon={GitBranch}
                title={
                  <PlaceLink
                    to={places.preview(place.project.name, place.name)}
                    className="truncate underline-offset-4 hover:underline"
                  >
                    {place.name}
                  </PlaceLink>
                }
                meta={[
                  {
                    kind: 'project',
                    text: place.project.name,
                  },
                  ...(origin?.type === 'pull_request'
                    ? [
                        {
                          kind: 'branch' as const,
                          text: `${origin.repo}#${origin.number}`,
                        },
                      ]
                    : []),
                ]}
                action={
                  <Button asChild size="sm" variant="outline">
                    <PlaceLink to={places.preview(place.project.name, place.name)}>Open</PlaceLink>
                  </Button>
                }
              />
            )
          })}
        </ItemList>
      )}
    </Section>
  )
}
