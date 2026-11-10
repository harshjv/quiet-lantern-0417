import { useSuspenseQuery } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import { ChevronRight, FolderGit2 } from 'lucide-react'

import { AlsoWith } from '@/components/code'
import { NewProject } from '@/components/new-project'
import { EmptyState, PageHeader } from '@/components/page'
import { failurePage } from '@/components/panel'
import { ServiceStatusDot } from '@/components/status'
import type { ServiceStatus } from '@/lib/api'
import { commands } from '@/lib/commands'
import { byName, plural } from '@/lib/format'
import { serviceStatus } from '@/lib/labels'
import { load, projectsQuery } from '@/lib/queries'

export const Route = createFileRoute('/_app/')({
  loader: ({ context }) => load(context.queryClient, projectsQuery),
  errorComponent: failurePage('Couldn’t load your projects'),
  component: Projects,
})

const order: ServiceStatus[] = ['red', 'amber', 'green', 'asleep', 'stopped']

function Projects() {
  const { data } = useSuspenseQuery(projectsQuery)
  return (
    <div className="space-y-6">
      <PageHeader
        title="Projects"
        meta={<span>{plural(data.items.length, 'project')}</span>}
        actions={<NewProject />}
      />
      {data.items.length === 0 ? (
        <EmptyState
          icon={FolderGit2}
          title="No projects yet"
          description="A project groups services that deploy together, with an environment for each stage."
          action={<NewProject />}
          also={<AlsoWith cli={commands.createProject()} tool="create_project" />}
        />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[...data.items].sort(byName).map((project) => (
            <li key={project.id}>
              <Link
                to="/projects/$project"
                params={{
                  project: project.name,
                }}
                className="group flex h-full flex-col gap-4 rounded-lg border bg-card p-4 transition-colors hover:border-foreground/25 hover:bg-muted/40"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <FolderGit2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="truncate font-medium">{project.name}</span>
                  </div>
                  <ChevronRight
                    className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                    aria-hidden
                  />
                </div>
                <div className="mt-auto flex items-center justify-between text-sm text-muted-foreground">
                  <span>
                    {plural(project.environment_count, 'environment')} ·{' '}
                    {plural(project.service_count, 'service')}
                  </span>
                  <span className="flex items-center gap-2" aria-label="Service status counts">
                    {order
                      .filter((status) => project.status_counts[status] > 0)
                      .map((status) => (
                        <span
                          key={status}
                          className="inline-flex items-center gap-1 tabular-nums"
                          title={`${project.status_counts[status]} ${serviceStatus[status].label.toLowerCase()}`}
                        >
                          <ServiceStatusDot status={status} />
                          <span className="sr-only">{serviceStatus[status].label}</span>
                          {project.status_counts[status]}
                        </span>
                      ))}
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
