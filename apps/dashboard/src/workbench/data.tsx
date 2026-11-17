import { useQuery } from '@tanstack/react-query'

import { agentLabel } from '@stationly/protocol'

import { attentionText } from '@/lib/agent-session'
import type { Task as LiveTask } from '@/lib/api'
import { shortAgo } from '@/lib/format'
import { projectsQuery, tasksQuery } from '@/lib/queries'
import type { Tone } from '@/lib/tone'

export type Project = { id: string; name: string }

export type TaskState = 'working' | 'waiting' | 'finished' | 'queued' | 'failed' | 'setup'

export type Task = {
  id: string
  title: string
  project: string
  state: TaskState
  reason: string
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

const reasonOf = (task: LiveTask) => {
  switch (task.status) {
    case 'queued':
      return task.queued_ahead ? `Queued, ${task.queued_ahead} ahead` : 'Queued, next to start'
    case 'setting_up':
      return 'Setting up'
    case 'working':
      return `Working with ${agentLabel(task.agent)}`
    case 'waiting':
      return task.attention ? attentionText[task.attention.kind] : 'Waiting on you'
    case 'finished':
      return 'Finished, waiting for your reply'
    case 'failed':
      return task.failure ? 'Setup failed' : 'Turn failed'
    case 'stopped':
      return 'Stopped'
  }
}

export const asRow = (task: LiveTask): Task => ({
  id: task.id,
  title: task.title,
  project: task.project.name,
  state: liveState[task.status],
  reason: reasonOf(task),
  age: shortAgo(task.last_event_at ?? task.created_at),
})

export function useTaskRows(): Task[] {
  const { data } = useQuery(tasksQuery)

  return (data?.items ?? []).map(asRow)
}

export function useProjectList(): Project[] {
  const { data } = useQuery(projectsQuery)

  return (data?.items ?? []).map((p) => ({
    id: p.name,
    name: p.name,
  }))
}
