import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { ChevronRight, FolderGit2 } from 'lucide-react'
import { NewProject } from '@/components/new-project'
import { Empty, PageHeader } from '@/components/page'
import { noItems, QueryState } from '@/components/query-state'
import { ServiceStatusDot } from '@/components/status'
import { byName, plural } from '@/lib/format'
import { projectsQuery } from '@/lib/queries'
import type { ServiceStatus } from '@/lib/api'

export const Route = createFileRoute('/_app/')({
  component: Projects
})

const order: ServiceStatus[] = ['red', 'amber', 'green', 'asleep', 'stopped']

function Projects() {
  const projects = useQuery(projectsQuery)
  return (
    <div className="space-y-6">
      <PageHeader title="Projects" meta={projects.data && <span>{projects.data.items.length} projects</span>} actions={<NewProject />} />
      <QueryState
        query={projects}
        rows={4}
        isEmpty={noItems}
        empty={
          <Empty title="No projects yet">
            Create one with New project, <code className="font-mono">sly projects create &lt;name&gt;</code> or the <code className="font-mono">create_project</code> MCP tool.
          </Empty>
        }
      >
        {data => (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {[...data.items].sort(byName).map(project => (
              <li key={project.id}>
                <Link
                  to="/projects/$project"
                  params={{ project: project.name }}
                  className="group flex h-full flex-col gap-4 rounded-lg border bg-card p-4 transition-colors hover:border-foreground/25 hover:bg-muted/40"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <FolderGit2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="truncate font-medium">{project.name}</span>
                    </div>
                    <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
                  </div>
                  <div className="mt-auto flex items-center justify-between text-sm text-muted-foreground">
                    <span>
                      {plural(project.environment_count, 'environment')} · {plural(project.service_count, 'service')}
                    </span>
                    <span className="flex items-center gap-2" aria-label="Service status counts">
                      {order
                        .filter(status => project.status_counts[status] > 0)
                        .map(status => (
                          <span key={status} className="inline-flex items-center gap-1 tabular-nums" title={`${project.status_counts[status]} ${status}`}>
                            <ServiceStatusDot status={status} />
                            <span className="sr-only">{status}</span>
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
      </QueryState>
    </div>
  )
}
