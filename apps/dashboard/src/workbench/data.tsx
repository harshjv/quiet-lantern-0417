import { useQuery } from '@tanstack/react-query'

import { agentLabel } from '@stationly/protocol'

import { attentionText } from '@/lib/agent-session'
import type { Task as LiveTask } from '@/lib/api'
import { shortAgo } from '@/lib/format'
import { projectsQuery, projectTasksQuery, tasksQuery } from '@/lib/queries'
import type { Tone } from '@/lib/tone'

export type Project = { id: string; name: string }

export type TaskState = 'working' | 'waiting' | 'finished' | 'queued' | 'failed' | 'setup'

export type Task = {
  id: string
  title: string
  project: string
  state: TaskState
  reason: string
  detail: string | null
  age: string
}

export const taskTone: Record<TaskState, Tone> = {
  working: 'info',
  setup: 'info',
  waiting: 'warning',
  finished: 'success',
  queued: 'neutral',
  failed: 'danger',
}

const liveState: Record<LiveTask['status'], TaskState> = {
  queued: 'queued',
  setting_up: 'setup',
  working: 'working',
  waiting: 'waiting',
  finished: 'finished',
  failed: 'failed',
  stopped: 'failed',
}

const reasonOf = (task: LiveTask): [string, string | null] => {
  switch (task.status) {
    case 'queued':
      return ['Queued', task.queued_ahead ? `${task.queued_ahead} ahead` : 'Next to start']
    case 'setting_up':
      return ['Setting up', null]
    case 'working':
      return ['Working', agentLabel(task.agent)]
    case 'waiting':
      return [task.attention ? attentionText[task.attention.kind] : 'Waiting on you', null]
    case 'finished':
      return task.ship?.status === 'approved'
        ? ['Shipped', null]
        : task.ship?.status === 'waiting'
          ? ['Shipping', 'Waiting for approval']
          : ['Finished', task.prompt === null ? null : 'Waiting for your reply']
    case 'failed':
      return [task.failure ? 'Setup failed' : 'Turn failed', null]
    case 'stopped':
      return ['Stopped', null]
  }
}

export const asRow = (task: LiveTask): Task => ({
  id: task.id,
  title: task.title,
  project: task.project.name,
  state: liveState[task.status],
  reason: reasonOf(task)[0],
  detail: reasonOf(task)[1],
  age: shortAgo(task.last_event_at ?? task.created_at),
})

export function useTaskRows(project?: string): Task[] {
  const { data } = useQuery(project ? projectTasksQuery(project) : tasksQuery)

  return (data?.items ?? []).map(asRow)
}

export function useProjectList(): Project[] {
  const { data } = useQuery(projectsQuery)

  return (data?.items ?? []).map((p) => ({
    id: p.name,
    name: p.name,
  }))
}
