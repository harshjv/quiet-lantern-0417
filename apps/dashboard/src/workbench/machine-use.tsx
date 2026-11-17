import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'

import { agentLabel } from '@stationly/protocol'

import type { Machine, Task } from '@/lib/api'
import { plural } from '@/lib/format'
import { tasksQuery } from '@/lib/queries'

export type MachineUse = 'task' | 'project' | 'hand'

export const machineUse = (machine: Pick<Machine, 'workspace'>): MachineUse => {
  if (!machine.workspace) {
    return 'hand'
  }

  return machine.workspace.kind === 'project' ? 'project' : 'task'
}

export const machineUseText: Record<MachineUse, string> = {
  task: 'Task machine',
  project: 'Project machine',
  hand: 'Used by hand',
}

export const useMachineTasks = (machine: Pick<Machine, 'id' | 'workspace'>): Task[] => {
  const { data } = useQuery({
    ...tasksQuery,
    enabled: machine.workspace !== null,
  })

  return (data?.items ?? []).filter((task) => task.machine.id === machine.id && !task.archived_at)
}

export function TaskLink({ task, className }: { task: Task; className?: string }) {
  return (
    <Link
      to="/build/$task"
      params={{
        task: task.id,
      }}
      className={className ?? 'underline-offset-4 hover:underline'}
    >
      {task.title}
    </Link>
  )
}

export function MachineUseLine({ machine }: { machine: Pick<Machine, 'id' | 'workspace'> }) {
  const use = machineUse(machine)
  const tasks = useMachineTasks(machine)
  const [task] = tasks

  if (use === 'hand') {
    return <span className="text-muted-foreground">{machineUseText.hand}</span>
  }

  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="flex flex-wrap items-center gap-x-2">
        {machineUseText[use]}
        {machine.workspace && (
          <span className="text-muted-foreground">{agentLabel(machine.workspace.agent)}</span>
        )}
      </span>
      <span className="truncate text-xs text-muted-foreground">
        {use === 'project'
          ? plural(tasks.length, 'task')
          : task && (
              <TaskLink task={task} className="relative z-10 underline-offset-4 hover:underline" />
            )}
      </span>
    </span>
  )
}
