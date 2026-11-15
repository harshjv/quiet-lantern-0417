import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

import { agentLabel } from '@stationly/protocol'

import { attentionText } from '@/lib/agent-session'
import { api, ApiFailure, unwrap, type Task as LiveTask } from '@/lib/api'
import { useEventStream } from '@/lib/event-stream'
import { shortAgo } from '@/lib/format'
import { projectsQuery, tasksQuery } from '@/lib/queries'

import { projects as mockProjects, type Project, type Task, type TaskState } from './fixtures'
import { useWorld } from './story'

type Source = 'probing' | 'live' | 'mock'

const SourceContext = createContext<Source>('probing')

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

    return 'live'
  } catch (error) {
    if (error instanceof ApiFailure && error.status === 401) {
      window.location.assign(`/login?next=${encodeURIComponent('/next.html')}`)

      return 'probing'
    }

    return 'mock'
  }
}

function LiveEvents() {
  const queries = useQueryClient()
  const refresh = () =>
    void queries.invalidateQueries({
      queryKey: ['tasks'],
    })

  useEventStream(`/v1/events?types=${encodeURIComponent('task.*')}`, {
    'task.created': refresh,
    'task.changed': refresh,
    'task.deleted': refresh,
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

  return (
    <QueryClientProvider client={client}>
      <SourceContext.Provider value={source}>
        {source === 'live' && <LiveEvents />}
        {children}
      </SourceContext.Provider>
    </QueryClientProvider>
  )
}

export const useLive = () => useContext(SourceContext) === 'live'

const liveState: Record<LiveTask['status'], TaskState> = {
  setting_up: 'setup',
  working: 'working',
  waiting: 'waiting',
  finished: 'finished',
  failed: 'failed',
  stopped: 'failed',
}

const reasonOf = (task: LiveTask) => {
  switch (task.status) {
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
  owner: 'you',
})

export function useTaskRows(): Task[] {
  const live = useLive()
  const world = useWorld()
  const { data } = useQuery({
    ...tasksQuery,
    enabled: live,
  })

  return live ? (data?.items ?? []).map(asRow) : world.tasks
}

export function useProjectList(): Project[] {
  const live = useLive()
  const { data } = useQuery({
    ...projectsQuery,
    enabled: live,
  })

  return live
    ? (data?.items ?? []).map((p) => ({
        id: p.name,
        name: p.name,
        repos: [],
      }))
    : mockProjects
}
