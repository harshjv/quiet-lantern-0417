import {
  CircleX,
  Gauge,
  KeyRound,
  Plug,
  Rocket,
  ShieldCheck,
  Square,
  UserPlus,
  type LucideIcon,
} from 'lucide-react'
import { useState } from 'react'

import { StateIcon } from '@/components/state-icon'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Toggle } from '@/components/ui/toggle'
import { toneText } from '@/lib/tone'
import { cn } from '@/lib/utils'

import type { Place } from './app'
import { useLive } from './data'
import { activity, logs, metricsOf, type ActivityRow } from './fixtures'
import { LiveObserve } from './observe-live'
import { Checklist, Facts, ItemList, ItemRow, Notice, PixelBars, Section } from './parts'
import { PixelScene } from './scene'
import { after, changes, phaseOf } from './stages'
import { useWorld } from './story'

type Props = { place: Place; go: (next: Partial<Place>) => void }

type Tab = 'attention' | 'logs' | 'metrics' | 'activity'

const levelTone = {
  info: '',
  warn: toneText.warning,
  error: toneText.danger,
} as const

const activityIcon: Record<ActivityRow['kind'], LucideIcon> = {
  deploy: Rocket,
  stop: Square,
  key: KeyRound,
  invite: UserPlus,
  assistant: Plug,
  approve: ShieldCheck,
}

const via: Record<ActivityRow['via'], string> = {
  dashboard: 'the dashboard',
  task: "a task's agent",
  assistant: 'an assistant',
}

export function ObserveScreen({ place, go }: Props) {
  return useLive() ? <LiveObserve place={place} go={go} /> : <MockObserve place={place} go={go} />
}

function MockObserve({ place, go }: Props) {
  const { apps } = useWorld()
  const scopedApp = place.view?.startsWith('app:') ? place.view.split(':')[1]! : null
  const tab: Tab = scopedApp
    ? 'logs'
    : place.view === 'logs' || place.view === 'metrics' || place.view === 'activity'
      ? place.view
      : 'attention'
  const [app, setApp] = useState<string>(scopedApp ?? 'all')
  const inProject = apps.filter((a) => !place.project || a.project === place.project)

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <h1 className="font-display text-xl">{place.project ?? 'All projects'}</h1>

      <Tabs
        value={tab}
        onValueChange={(v) =>
          go({
            view: v === 'attention' ? null : v,
          })
        }
      >
        <TabsList>
          <TabsTrigger value="attention">Attention</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="metrics">Metrics</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === 'attention' && <Attention place={place} go={go} />}

      {(tab === 'logs' || tab === 'metrics') && (
        <div className="flex items-center gap-3">
          <Select value={app} onValueChange={setApp}>
            <SelectTrigger className="w-48" aria-label="App">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All apps</SelectItem>
              {inProject.map((a) => (
                <SelectItem key={a.name} value={a.name}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {tab === 'logs' && <LogFilters />}
        </div>
      )}

      {tab === 'logs' && <LogView app={app} project={place.project} go={go} />}
      {tab === 'metrics' && <Metrics app={app} apps={inProject.map((a) => a.name)} />}
      {tab === 'activity' && <Activity project={place.project} />}
    </div>
  )
}

function Attention({ place, go }: Props) {
  const { incidents, stage } = useWorld()
  const shown = incidents.filter((i) => !place.project || i.project === place.project)
  const failed =
    (!place.project || place.project === 'etherbit') && phaseOf(changes.paise, stage) === 'failed'

  if (shown.length === 0) {
    return (
      <div className="flex flex-col gap-3">
        <PixelScene slots={1} running={0} queued={0} live className="h-40 border" />
        <p className="text-sm text-muted-foreground">
          Everything in {place.project ?? 'your projects'} is healthy. Failures, slow requests and
          errors show up here.
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <Section title="Needs attention" count={shown.length}>
        <ItemList>
          {shown.map((i) => (
            <ItemRow
              key={i.title}
              icon={i.tone === 'danger' ? CircleX : Gauge}
              tone={i.tone}
              title={i.title}
              meta={[
                {
                  kind: 'project',
                  text: i.project,
                },
                ...i.facts,
                {
                  kind: 'time',
                  text: `${i.age} ago`,
                },
              ]}
              action={
                <>
                  {i.tone === 'danger' && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        go({
                          mode: 'ship',
                          project: i.project,
                          view: 'deploy',
                        })
                      }
                    >
                      Open deploy
                    </Button>
                  )}
                  <Button
                    size="sm"
                    onClick={() =>
                      go({
                        mode: 'build',
                        project: i.project,
                        view: i.tone === 'danger' ? 'fix' : 'new',
                      })
                    }
                  >
                    Fix with an agent
                  </Button>
                </>
              }
            />
          ))}
        </ItemList>
      </Section>

      {failed && (
        <Section
          title="Failed deploy"
          facts={
            <Facts
              facts={[
                {
                  kind: 'app',
                  text: 'api',
                },
                {
                  kind: 'version',
                  text: 'v42',
                },
              ]}
            />
          }
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <Checklist
              steps={[
                {
                  label: 'Build',
                  state: 'done',
                  time: '48s',
                },
                {
                  label: 'Start new version beside the old',
                  state: 'done',
                  time: '3s',
                },
                {
                  label: 'Health check',
                  state: 'failed',
                  time: 'failed after 30s',
                },
                {
                  label: 'Switch traffic (skipped, v41 still serving)',
                  state: 'todo',
                },
              ]}
            />
            <Notice tone="danger" title="The new version never answered its health check">
              It logged{' '}
              <code className="font-mono text-xs">
                relation &quot;orders_paise&quot; does not exist
              </code>{' '}
              and exited: the migration didn&apos;t run before start.
            </Notice>
          </div>
        </Section>
      )}
    </div>
  )
}

function LogFilters() {
  return (
    <>
      <Input placeholder="Search logs" className="w-64" />
      <Toggle variant="outline" size="sm" aria-label="Errors only">
        Errors only
      </Toggle>
      <span className="ml-auto flex items-center gap-2 font-mono text-xs text-muted-foreground">
        <StateIcon state="working" /> Streaming
      </span>
    </>
  )
}

function LogView({ app, project, go }: { app: string; project: string | null; go: Props['go'] }) {
  const { apps } = useWorld()
  const names = new Set(apps.filter((a) => !project || a.project === project).map((a) => a.name))
  const lines = logs.filter((l) => names.has(l.app) && (app === 'all' || l.app === app))
  const error = lines.find((l) => l.level === 'error')

  return (
    <div className="flex flex-col gap-3">
      <Card className="gap-0 overflow-hidden py-3 font-mono text-xs leading-6">
        {lines.map((l) => (
          <div key={l.at + l.app + l.text} className={cn('flex gap-4 px-4', levelTone[l.level])}>
            <span className="text-muted-foreground tabular-nums">{l.at}</span>
            <span className="w-20 shrink-0 truncate text-muted-foreground">{l.app}</span>
            <span className="w-8 shrink-0 text-muted-foreground">{l.v}</span>
            <span className="min-w-0 flex-1 truncate">{l.text}</span>
          </div>
        ))}
        {lines.length === 0 && (
          <div className="px-4 text-muted-foreground">No lines from this app in the last hour.</div>
        )}
      </Card>
      {error && (
        <Notice
          tone="danger"
          title="1 error in the last hour"
          action={
            <Button
              size="sm"
              onClick={() =>
                go({
                  mode: 'build',
                  view: 'new',
                })
              }
            >
              Ask an agent about it
            </Button>
          }
        >
          <code className="font-mono text-xs">{error.text}</code>
        </Notice>
      )}
    </div>
  )
}

function Metrics({ app, apps }: { app: string; apps: string[] }) {
  const shown = (app === 'all' ? apps : [app]).filter((a) => metricsOf[a])

  if (shown.length === 0) {
    return <p className="text-sm text-muted-foreground">No metrics for this app yet.</p>
  }

  return (
    <div className="flex flex-col gap-6">
      {shown.map((a) => (
        <Section key={a} title={a} count={metricsOf[a]!.length}>
          <div className="grid gap-4 sm:grid-cols-2">
            {metricsOf[a]!.map((m) => (
              <Card key={m.label} className="gap-3 px-4 py-4">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-mono text-xs text-muted-foreground uppercase">
                    {m.label}
                  </span>
                  <span className="font-display text-lg tabular-nums">{m.value}</span>
                </div>
                <PixelBars values={m.trend} tone={m.tone} max={m.max} tall />
              </Card>
            ))}
          </div>
        </Section>
      ))}
    </div>
  )
}

const fixed: ActivityRow[] = [
  {
    kind: 'deploy',
    title: 'api v43 deployed to production',
    project: 'etherbit',
    who: 'Harsh',
    via: 'dashboard',
    age: 'just now',
  },
  {
    kind: 'approve',
    title: 'Approved "Fix the failed api v42 deploy"',
    project: 'etherbit',
    who: 'Harsh',
    via: 'dashboard',
    age: 'just now',
  },
]

function Activity({ project }: { project: string | null }) {
  const { stage } = useWorld()
  const shipped = after(stage, 'deploying')
  const rows = [...(stage === 'healthy' ? fixed : []), ...activity].filter(
    (r) =>
      (!project || r.project === project) &&
      (shipped || (r.kind !== 'deploy' && r.kind !== 'approve')),
  )

  return (
    <Section title="Activity" count={rows.length}>
      <ItemList>
        {rows.map((r) => (
          <ItemRow
            key={r.title}
            icon={activityIcon[r.kind]}
            tone={r.failed ? 'danger' : 'neutral'}
            title={r.title}
            meta={[
              {
                kind: 'user',
                text: r.who,
              },
              {
                kind: 'via',
                text: via[r.via],
              },
              ...(project
                ? []
                : [
                    {
                      kind: 'project' as const,
                      text: r.project,
                    },
                  ]),
              {
                kind: 'time',
                text: r.age,
              },
            ]}
          />
        ))}
      </ItemList>
    </Section>
  )
}
