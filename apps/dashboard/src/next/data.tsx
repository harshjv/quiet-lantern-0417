import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'

import { agentLabel } from '@stationly/protocol'

import { attentionText } from '@/lib/agent-session'
import { api, ApiFailure, unwrap, type Task as LiveTask } from '@/lib/api'
import { useEventStream } from '@/lib/event-stream'
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

type Source = 'probing' | 'ready' | 'unreachable'

const client = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: (count, error) => !(error instanceof ApiFailure && error.status < 500) && count < 2,
    },
  },
})

const probe = async (): Promise<Source> => {
  try {
    await unwrap(api.v1.me.get())

    return 'ready'
  } catch (error) {
    if (error instanceof ApiFailure && error.status === 401) {
      window.location.assign(`/login?next=${encodeURIComponent(location.pathname)}`)

      return 'probing'
    }

    return 'unreachable'
  }
}

function LiveEvents() {
  const queries = useQueryClient()
  const refresh = () => {
    void queries.invalidateQueries({
      queryKey: ['tasks'],
    })
    void queries.invalidateQueries({
      queryKey: ['ship-requests'],
    })
  }

  const refreshApps = () => {
    void queries.invalidateQueries({
      queryKey: ['services'],
    })
    void queries.invalidateQueries({
      queryKey: ['deployments'],
    })
  }

  useEventStream(`/v1/events?types=${encodeURIComponent('task.*,deployment.*,health.changed')}`, {
    'task.created': refresh,
    'task.changed': refresh,
    'task.deleted': refresh,
    'deployment.started': refreshApps,
    'deployment.active': refreshApps,
    'deployment.failed': refreshApps,
    'deployment.cancelled': refreshApps,
    'health.changed': refreshApps,
  })

  return null
}

export function DataProvider({ children }: { children: ReactNode }) {
  const [source, setSource] = useState<Source>('probing')

  useEffect(() => {
    void probe().then(setSource)
  }, [])

  if (source === 'probing') {
    return null
  }

  if (source === 'unreachable') {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        Stationly could not be reached. Reload the page to try again.
      </p>
    )
  }

  return (
    <QueryClientProvider client={client}>
      <LiveEvents />
      {children}
    </QueryClientProvider>
  )
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
