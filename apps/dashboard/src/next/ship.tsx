import {
  Cog,
  Database,
  ExternalLink,
  FileCode,
  Folder,
  GitBranch,
  Globe,
  KeyRound,
  Rocket,
  Server,
  Tag,
  User,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

import type { Place } from './app'
import { useLive } from './data'
import { previews, projects } from './fixtures'
import {
  Checklist,
  Facts,
  IconTile,
  ItemList,
  ItemRow,
  Meta,
  Notice,
  PixelBars,
  Section,
  Stats,
  StatusPill,
  type Step,
} from './parts'
import { AppPage } from './ship-app'
import { Keys } from './ship-keys'
import { LiveShip } from './ship-live'
import { NewApp } from './ship-new'
import { activeChange, phaseOf } from './stages'
import { useStory, useWorld } from './story'

const appIcon: Record<string, LucideIcon> = {
  Website: Globe,
  API: Server,
  'Background jobs': Cog,
  Database,
}

type Props = { place: Place; go: (next: Partial<Place>) => void }

export function ShipScreen({ place, go }: Props) {
  return useLive() ? <LiveShip place={place} go={go} /> : <MockShip place={place} go={go} />
}

function MockShip({ place, go }: Props) {
  const { apps, approvals } = useWorld()
  const [adding, setAdding] = useState(false)

  if (place.view === 'review') {
    return <Review go={go} />
  }

  if (place.view === 'deploy') {
    return <Deploy go={go} />
  }

  if (place.view?.startsWith('app:')) {
    const [, name, sub] = place.view.split(':')
    const app = apps.find((a) => a.name === name)

    if (app) {
      return (
        <AppPage
          app={app}
          icon={appIcon[app.kind] ?? Server}
          settings={sub === 'settings'}
          go={go}
        />
      )
    }
  }

  const tab = place.view === 'previews' || place.view === 'keys' ? place.view : 'production'

  const inScope = <T extends { project: string }>(rows: T[]) =>
    rows.filter((r) => !place.project || r.project === place.project)
  const failing = inScope(apps).filter((a) => a.state === 'failed')
  const title = place.project ?? 'All projects'

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8 p-6">
      <div className="flex items-center gap-3">
        <h1 className="flex-1 font-display text-xl">{title}</h1>
        {place.project && (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            New app
          </Button>
        )}
      </div>

      {place.project && <NewApp project={place.project} open={adding} onOpenChange={setAdding} />}

      <Tabs
        value={tab}
        onValueChange={(v) =>
          go({
            view: v === 'production' ? null : v,
          })
        }
      >
        <TabsList>
          <TabsTrigger value="production">Production</TabsTrigger>
          <TabsTrigger value="previews">Previews</TabsTrigger>
          <TabsTrigger value="keys">Keys</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === 'keys' &&
        (place.project ? (
          <Keys project={place.project} />
        ) : (
          <p className="text-sm text-muted-foreground">Pick a project to see its keys.</p>
        ))}

      {tab === 'production' && (
        <>
          {failing.map((a) => (
            <Notice
              key={a.name}
              tone="danger"
              title={`${a.name}'s last deploy failed`}
              action={
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      go({
                        mode: 'observe',
                        project: a.project,
                      })
                    }
                  >
                    Open in Observe
                  </Button>
                  <Button
                    size="sm"
                    onClick={() =>
                      go({
                        mode: 'build',
                        project: a.project,
                        view: 'fix',
                      })
                    }
                  >
                    Fix with an agent
                  </Button>
                </>
              }
            >
              The previous version is still serving, so customers aren&apos;t affected.
            </Notice>
          ))}

          <Section title="Waiting for approval" count={inScope(approvals).length}>
            <ItemList>
              {inScope(approvals).map((a) => (
                <ItemRow
                  key={a.title}
                  icon={a.kind === 'key' ? KeyRound : Rocket}
                  tone="warning"
                  title={a.title}
                  meta={[
                    {
                      kind: 'project',
                      text: a.project,
                    },
                    {
                      kind: 'user',
                      text: a.by,
                    },
                    {
                      kind: 'time',
                      text: a.age,
                    },
                    ...a.facts,
                  ]}
                  action={
                    <Button
                      size="sm"
                      onClick={() =>
                        a.story &&
                        go({
                          view: 'review',
                          project: 'etherbit',
                        })
                      }
                    >
                      Review
                    </Button>
                  }
                />
              ))}
            </ItemList>
          </Section>

          {(place.project ? projects.filter((p) => p.id === place.project) : projects).map((p) => {
            const live = (
              <Section
                icon={place.project ? undefined : Folder}
                title={place.project ? 'Apps' : p.name}
                count={apps.filter((a) => a.project === p.id).length}
              >
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  {apps
                    .filter((a) => a.project === p.id)
                    .map((a) => (
                      <Card
                        key={a.name}
                        className="cursor-pointer gap-3 hover:border-primary"
                        role="link"
                        tabIndex={0}
                        onClick={() =>
                          go({
                            view: `app:${a.name}`,
                            project: a.project,
                          })
                        }
                        onKeyDown={(e) =>
                          e.key === 'Enter' &&
                          go({
                            view: `app:${a.name}`,
                            project: a.project,
                          })
                        }
                      >
                        <CardHeader className="flex flex-row items-center gap-3">
                          <IconTile
                            icon={appIcon[a.kind] ?? Server}
                            tone={
                              a.state === 'failed'
                                ? 'danger'
                                : a.state === 'deploying'
                                  ? 'info'
                                  : 'neutral'
                            }
                          />
                          <CardTitle className="flex-1">{a.name}</CardTitle>
                          <StatusPill
                            tone={
                              a.state === 'failed'
                                ? 'danger'
                                : a.state === 'deploying'
                                  ? 'info'
                                  : 'success'
                            }
                          >
                            {a.state === 'failed'
                              ? 'Failing'
                              : a.state === 'deploying'
                                ? 'Deploying'
                                : 'Healthy'}
                          </StatusPill>
                        </CardHeader>
                        <CardContent className="flex flex-col gap-3">
                          <div className="flex items-center justify-between gap-2 font-mono text-xs text-muted-foreground">
                            <span className="truncate">
                              {a.link ? (
                                <>
                                  {a.link} <ExternalLink className="inline size-3" />
                                </>
                              ) : (
                                'private'
                              )}
                            </span>
                            <span className="uppercase">{a.kind}</span>
                          </div>
                          <PixelBars
                            values={a.trend}
                            tone={a.state === 'failed' ? 'danger' : undefined}
                          />
                          <Stats items={a.stats} />
                        </CardContent>
                      </Card>
                    ))}
                </div>
              </Section>
            )

            return <div key={p.id}>{live}</div>
          })}
        </>
      )}

      {tab === 'previews' && (
        <Section title="Previews" count={inScope(previews).length}>
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Preview</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>Apps</TableHead>
                  <TableHead>Goes away</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {inScope(previews).map((p) => (
                  <TableRow key={p.name}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <IconTile icon={GitBranch} />
                        <div>
                          <div className="font-medium">{p.name}</div>
                          <div className="font-mono text-xs text-muted-foreground">{p.branch}</div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <div className="flex flex-col gap-1">
                        <span>{p.from}</span>
                        {!place.project && (
                          <Facts
                            facts={[
                              {
                                kind: 'project',
                                text: p.project,
                              },
                            ]}
                          />
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      {p.state === 'live' ? (
                        <StatusPill tone="success">Running</StatusPill>
                      ) : (
                        <StatusPill tone="warning">Missing a key</StatusPill>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{p.expires}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </Section>
      )}
    </div>
  )
}

function Review({ go }: { go: Props['go'] }) {
  const story = useStory()
  const change = activeChange(story.stage)
  const open = phaseOf(change, story.stage) === 'review'

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-2">
        <h1 className="font-display text-xl">Ship “{change.title}” to production</h1>
        <div className="flex flex-wrap items-center gap-4 text-muted-foreground">
          <StatusPill tone={open ? 'warning' : 'neutral'}>
            {open ? 'Waiting for approval' : 'Approved'}
          </StatusPill>
          <Meta icon={Folder} label="Project">
            etherbit
          </Meta>
          <Meta icon={GitBranch} label="Branch">
            {change.branch}
          </Meta>
          <Meta icon={User} label="Asked by">
            you, from the task
          </Meta>
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <Section title="What the agent says it did">
            <p className="text-sm">{change.summary}</p>
          </Section>
          <Section
            title="Changes"
            count={change.fileCount}
            facts={
              <Facts
                facts={[
                  {
                    kind: 'files',
                    text: `${change.fileCount} files`,
                  },
                  {
                    kind: 'branch',
                    text: change.delta,
                  },
                ]}
              />
            }
          >
            <ItemList>
              {change.files.map(([file, delta]) => (
                <ItemRow
                  key={file}
                  icon={FileCode}
                  title={<span className="font-mono text-xs">{file}</span>}
                  meta={[
                    {
                      kind: 'files',
                      text: delta,
                    },
                  ]}
                />
              ))}
            </ItemList>
          </Section>
        </div>
        <div className="flex flex-col gap-4">
          <Checklist
            steps={[
              ...change.checks.map((c) => ({
                ...c,
                state: 'done' as const,
              })),
              {
                label: change.firstStep,
                state: 'todo',
              },
            ]}
          />
          <Stats
            items={[
              {
                value: 'api',
                label: 'app',
              },
              {
                value: change.version,
                label: 'new',
              },
              {
                value: change.previous,
                label: 'if it fails',
              },
            ]}
          />
          {open ? (
            <>
              <Notice tone="neutral" title="You’re the only approver in etherbit">
                Approving your own change is allowed when nobody else can. It is recorded as such.
              </Notice>
              <Button
                onClick={() => {
                  story.to(change.stages.deploying)
                  go({
                    view: 'deploy',
                    project: 'etherbit',
                  })
                }}
              >
                <Rocket /> Approve and deploy
              </Button>
              <Button variant="outline">Ask for changes</Button>
            </>
          ) : (
            <Button
              variant="outline"
              onClick={() =>
                go({
                  view: 'deploy',
                  project: 'etherbit',
                })
              }
            >
              See the deploy
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function Deploy({ go }: { go: Props['go'] }) {
  const story = useStory()
  const change = activeChange(story.stage)
  const phase = phaseOf(change, story.stage)
  const failed = phase === 'failed'
  const shipped = phase === 'shipped'

  useEffect(() => {
    if (phase !== 'deploying') {
      return
    }

    const timer = setTimeout(() => story.to(change.stages.end), 3500)

    return () => clearTimeout(timer)
  }, [story, phase, change])

  const health: Step = failed
    ? {
        label: 'Health check',
        state: 'failed',
        time: 'failed after 30s',
      }
    : shipped
      ? {
          label: 'Health check',
          state: 'done',
          time: '40 ms',
        }
      : {
          label: 'Waiting for the health check',
          state: 'now',
        }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <div className="flex flex-col gap-2">
        <h1 className="font-display text-xl">api</h1>
        <div className="flex flex-wrap items-center gap-4 text-muted-foreground">
          <StatusPill tone={failed ? 'danger' : shipped ? 'success' : 'info'}>
            {failed ? 'Failed' : shipped ? 'Serving' : 'Deploying'}
          </StatusPill>
          <Meta icon={Tag} label="Version">
            {change.version}
          </Meta>
          <Meta icon={GitBranch} label="Branch">
            {change.branch}
          </Meta>
          <Meta icon={User} label="Approved by">
            you
          </Meta>
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Checklist
          steps={[
            {
              label: 'Build',
              state: 'done',
              time: '48s',
            },
            ...(change.fails
              ? []
              : [
                  {
                    label: 'Run migration 0042',
                    state: 'done' as const,
                    time: '2s',
                  },
                ]),
            {
              label: 'Start new version beside the old',
              state: 'done',
              time: '3s',
            },
            health,
            {
              label: failed
                ? `Switch traffic (skipped, ${change.previous} still serving)`
                : `Switch traffic to ${change.version}`,
              state: shipped ? 'done' : 'todo',
            },
          ]}
        />
        {failed && (
          <Notice
            tone="danger"
            title="The new version never answered its health check"
            action={
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    go({
                      mode: 'observe',
                      project: 'etherbit',
                      view: null,
                    })
                  }
                >
                  Open in Observe
                </Button>
                <Button
                  size="sm"
                  onClick={() =>
                    go({
                      mode: 'build',
                      project: 'etherbit',
                      view: 'fix',
                    })
                  }
                >
                  Fix with an agent
                </Button>
              </>
            }
          >
            It logged{' '}
            <code className="font-mono text-xs">
              relation &quot;orders_paise&quot; does not exist
            </code>{' '}
            and exited: migration 0042 didn&apos;t run before start. v41 is still serving.
          </Notice>
        )}
        {shipped && (
          <Notice
            tone="success"
            title={`${change.version} is serving`}
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  go({
                    mode: 'observe',
                    project: 'etherbit',
                    view: 'app:api',
                  })
                }
              >
                Watch it in Observe
              </Button>
            }
          >
            Migration 0042 ran first, then the health check answered. The integer paise change is in
            production with it.
          </Notice>
        )}
      </div>
    </div>
  )
}
