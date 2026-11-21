import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { MessageSquare, Plus } from 'lucide-react'

import { EmptyState, ErrorState, Rows } from '@/components/page'
import { TableFrame } from '@/components/table-frame'
import { Button } from '@/components/ui/button'
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { newTaskTo, taskTo } from '@/lib/links'
import { projectTasksQuery } from '@/lib/queries'

import { asRow, taskTone } from './data'
import { Page, StatusPill } from './parts'

export function ProjectTasks({ project }: { project: string }) {
  const tasks = useQuery(projectTasksQuery(project))
  const rows = (tasks.data?.items ?? []).map(asRow)

  return (
    <Page
      title="Tasks"
      actions={
        <Button asChild size="sm">
          <Link {...newTaskTo(project)}>
            <Plus /> New task
          </Link>
        </Button>
      }
    >
      {tasks.isError ? (
        <ErrorState
          error={tasks.error}
          title="Couldn’t load tasks"
          onRetry={() => void tasks.refetch()}
        />
      ) : tasks.isPending ? (
        <Rows count={3} />
      ) : rows.length === 0 ? (
        <EmptyState icon={MessageSquare} title="No tasks yet" />
      ) : (
        <TableFrame>
          <TableHeader>
            <TableRow>
              <TableHead>Task</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Last activity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((task) => (
              <TableRow key={task.id} className="relative">
                <TableCell className="max-w-96 truncate">
                  <Link
                    {...taskTo(project, task.id)}
                    className="font-medium after:absolute after:inset-0 focus-visible:outline-none"
                  >
                    {task.title}
                  </Link>
                </TableCell>
                <TableCell>
                  <span className="flex items-center gap-3">
                    <StatusPill tone={taskTone[task.state]}>{task.reason}</StatusPill>
                    {task.detail && (
                      <span className="text-sm text-muted-foreground">{task.detail}</span>
                    )}
                  </span>
                </TableCell>
                <TableCell className="text-right text-muted-foreground tabular-nums">
                  {task.age}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </TableFrame>
      )}
    </Page>
  )
}
