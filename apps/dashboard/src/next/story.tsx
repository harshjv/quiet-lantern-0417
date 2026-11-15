import { createContext, useContext, useMemo, useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'

import type { Place } from './app'
import {
  approvals as baseApprovals,
  apps as baseApps,
  incidents as baseIncidents,
  tasks as baseTasks,
  type App,
  type Task,
} from './fixtures'
import { activeChange, after, changes, order, phaseOf, type Phase, type Stage } from './stages'

type Story = {
  stage: Stage
  to: (stage: Stage) => void
  gone: string[]
  drop: (id: string) => void
  forks: string[]
  fork: (id: string) => void
}

const StoryContext = createContext<Story | null>(null)

export function StoryProvider({ children }: { children: ReactNode }) {
  const [stage, to] = useState<Stage>('command')
  const [gone, setGone] = useState<string[]>([])
  const [forks, setForks] = useState<string[]>([])
  const value = useMemo(
    () => ({
      stage,
      to,
      gone,
      drop: (id: string) => setGone((g) => [...g, id]),
      forks,
      fork: (id: string) => setForks((f) => (f.includes(id) ? f : [...f, id])),
    }),
    [stage, gone, forks],
  )

  return <StoryContext.Provider value={value}>{children}</StoryContext.Provider>
}

export const useStory = () => useContext(StoryContext)!

const taskState: Record<Phase, Pick<Task, 'state' | 'reason'>> = {
  working: {
    state: 'working',
    reason: 'Sonnet 5.5',
  },
  ready: {
    state: 'finished',
    reason: 'Ready to ship',
  },
  review: {
    state: 'finished',
    reason: 'Waiting for approval',
  },
  deploying: {
    state: 'finished',
    reason: 'Deploying to production',
  },
  failed: {
    state: 'failed',
    reason: 'Deploy failed',
  },
  shipped: {
    state: 'finished',
    reason: 'In production',
  },
}

const paise = (stage: Stage): Pick<Task, 'state' | 'reason'> =>
  stage === 'command'
    ? {
        state: 'waiting',
        reason: 'Approve a command',
      }
    : taskState[phaseOf(changes.paise, stage)]

export const fixTask: Task = {
  id: 'fixv42',
  title: 'Fix the failed api v42 deploy',
  project: 'etherbit',
  state: 'working',
  reason: 'Sonnet 5.5',
  age: 'now',
  owner: 'you',
}

export const forkId = (id: string) => `${id}-fork`

export function useWorld() {
  const { stage, gone, forks } = useStory()
  const healthy = stage === 'healthy'
  const failed = after(stage, 'failed') && !healthy
  const change = activeChange(stage)
  const phase = phaseOf(change, stage)

  const tasks: Task[] = [
    ...(after(stage, 'fixing')
      ? [
          {
            ...fixTask,
            ...taskState[phaseOf(changes.fix, stage)],
          },
        ]
      : []),
    ...baseTasks
      .filter((t) => forks.includes(t.id))
      .map((t) => ({
        ...t,
        id: forkId(t.id),
        forkOf: t.id,
        state: 'working' as const,
        reason: `Forked from ${t.owner}`,
        age: 'now',
        owner: 'you',
      })),
    ...baseTasks.map((t) =>
      t.id === 'paise'
        ? {
            ...t,
            ...paise(stage),
          }
        : t,
    ),
  ].filter((t) => !gone.includes(t.id))

  const apps: App[] = baseApps.map((a) =>
    a.name !== 'api'
      ? a
      : phase === 'deploying'
        ? {
            ...a,
            state: 'deploying',
          }
        : failed
          ? a
          : {
              ...a,
              state: 'live',
              stats: [
                {
                  value: '840',
                  label: 'req/h',
                },
                {
                  value: healthy ? 'v43' : 'v41',
                  label: 'serving',
                },
                {
                  value: healthy ? 'now' : '1d',
                  label: 'deployed',
                },
              ],
              trend: [5, 4, 6, 5, 6, 5, 6, 7, 5, 6, 6, 6],
            },
  )

  const approvals = [
    ...(phase === 'review'
      ? [
          {
            kind: 'ship' as const,
            title: `Ship "${change.title}" to production`,
            project: 'etherbit',
            by: 'you',
            age: 'just now',
            facts: [
              {
                kind: 'files' as const,
                text: `${change.fileCount} files`,
              },
              {
                kind: 'tests' as const,
                text: 'passed',
              },
              {
                kind: 'preview' as const,
                text: 'healthy',
              },
            ],
            story: true,
          },
        ]
      : []),
    ...baseApprovals.map((a) => ({
      ...a,
      story: false,
    })),
  ]

  const incidents = baseIncidents.filter((i) => failed || !i.title.startsWith('api v42'))

  return {
    stage,
    tasks,
    apps,
    approvals,
    incidents,
  }
}

const steps: Record<Stage, { text: string; place: Partial<Place> }> = {
  command: {
    text: 'In Build, allow the agent’s command on “Move order totals to integer paise”.',
    place: {
      mode: 'build',
      project: null,
      view: 'paise',
    },
  },
  finished: {
    text: 'The task is done and its preview is up. Press Ship to production.',
    place: {
      mode: 'build',
      project: null,
      view: 'paise',
    },
  },
  review: {
    text: 'In Ship, review the change and approve it.',
    place: {
      mode: 'ship',
      project: 'etherbit',
      view: 'review',
    },
  },
  deploying: {
    text: 'api v42 is deploying.',
    place: {
      mode: 'ship',
      project: 'etherbit',
      view: 'deploy',
    },
  },
  failed: {
    text: 'The deploy failed. See why in Observe, then press Fix with an agent.',
    place: {
      mode: 'observe',
      project: 'etherbit',
      view: null,
    },
  },
  fixing: {
    text: 'An agent is fixing it from the failing branch. Its fix comes back as an approval.',
    place: {
      mode: 'build',
      project: 'etherbit',
      view: 'fixv42',
    },
  },
  fixed: {
    text: 'The fix is ready and its preview started from an empty database. Press Ship to production.',
    place: {
      mode: 'build',
      project: 'etherbit',
      view: 'fixv42',
    },
  },
  fixReview: {
    text: 'In Ship, review the fix and approve it.',
    place: {
      mode: 'ship',
      project: 'etherbit',
      view: 'review',
    },
  },
  fixDeploying: {
    text: 'api v43 is deploying, with the migration running first.',
    place: {
      mode: 'ship',
      project: 'etherbit',
      view: 'deploy',
    },
  },
  healthy: {
    text: 'api is healthy on v43. That is the whole loop: build, ship, observe, fix.',
    place: {
      mode: 'ship',
      project: 'etherbit',
      view: null,
    },
  },
}

export function StoryGuide({ go }: { go: (next: Partial<Place>) => void }) {
  const { stage, to } = useStory()
  const step = steps[stage]

  return (
    <div className="flex items-center gap-3 border-b bg-brand-1 px-4 py-2 text-sm">
      <span className="font-display text-primary">
        {order.indexOf(stage) + 1}/{order.length}
      </span>
      <span className="min-w-0 flex-1 truncate">{step.text}</span>
      <Button size="sm" variant="outline" onClick={() => go(step.place)}>
        Show me
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          to('command')
          go(steps.command.place)
        }}
      >
        Restart
      </Button>
    </div>
  )
}
