import {
  ArrowLeft,
  ExternalLink,
  Logs,
  MoreHorizontal,
  Rocket,
  Square,
  Tag,
  type LucideIcon,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

import type { Place } from './app'
import { deploysOf, type App } from './fixtures'
import {
  Facts,
  IconTile,
  ItemList,
  ItemRow,
  Meta,
  Notice,
  PixelBars,
  SettingRow as Row,
  Section,
  SettingsCard,
  Stats,
  StatusPill,
} from './parts'

type Go = (next: Partial<Place>) => void

const health = (a: App) =>
  a.state === 'failed'
    ? {
        tone: 'danger' as const,
        text: 'Failing',
      }
    : a.state === 'deploying'
      ? {
          tone: 'info' as const,
          text: 'Deploying',
        }
      : a.state === 'stopped'
        ? {
            tone: 'neutral' as const,
            text: 'Stopped',
          }
        : {
            tone: 'success' as const,
            text: 'Healthy',
          }

export function AppPage({
  app,
  icon,
  settings,
  go,
}: {
  app: App
  icon: LucideIcon
  settings: boolean
  go: Go
}) {
  const h = health(app)
  const deploys = deploysOf[app.name] ?? []

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <Button
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={() =>
          go({
            view: null,
            project: app.project,
          })
        }
      >
        <ArrowLeft /> {app.project}
      </Button>
      <div className="flex items-start gap-3">
        <IconTile icon={icon} tone={app.state === 'failed' ? 'danger' : 'neutral'} />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <h1 className="font-display text-xl">{app.name}</h1>
          <div className="flex flex-wrap items-center gap-4 text-muted-foreground">
            <StatusPill tone={h.tone}>{h.text}</StatusPill>
            <Facts
              facts={[
                {
                  kind: 'project',
                  text: app.project,
                },
                ...(app.link
                  ? [
                      {
                        kind: 'link' as const,
                        text: app.link,
                      },
                    ]
                  : []),
              ]}
            />
            <span className="font-mono text-xs uppercase">{app.kind}</span>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            go({
              mode: 'observe',
              project: app.project,
              view: `app:${app.name}`,
            })
          }
        >
          <Logs /> Logs and metrics
        </Button>
        <Button variant="outline" size="sm">
          <Rocket /> Redeploy
        </Button>
        <Button variant="ghost" size="icon" aria-label="App actions">
          <MoreHorizontal />
        </Button>
      </div>

      {app.state === 'stopped' && (
        <Notice
          tone="neutral"
          title="Stopped by the task Clean up old cron jobs, started by Harsh"
          action={
            <Button size="sm">
              <Square /> Start
            </Button>
          }
        >
          Its link answers with an error until it starts again.
        </Notice>
      )}

      <Tabs
        value={settings ? 'settings' : 'deploys'}
        onValueChange={(v) =>
          go({
            view: v === 'settings' ? `app:${app.name}:settings` : `app:${app.name}`,
            project: app.project,
          })
        }
      >
        <TabsList>
          <TabsTrigger value="deploys">Deploys</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
      </Tabs>

      {settings ? (
        <AppSettings app={app} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="flex flex-col gap-6 lg:col-span-2">
            <Section title="Deploys" count={deploys.length}>
              {deploys.length ? (
                <ItemList>
                  {deploys.map((d) => (
                    <ItemRow
                      key={d.version}
                      icon={Tag}
                      tone={d.state === 'failed' ? 'danger' : 'neutral'}
                      title={
                        <>
                          {d.version}
                          <StatusPill
                            tone={
                              d.state === 'live'
                                ? 'success'
                                : d.state === 'failed'
                                  ? 'danger'
                                  : 'neutral'
                            }
                          >
                            {d.state === 'live'
                              ? 'Serving'
                              : d.state === 'failed'
                                ? 'Failed'
                                : 'Replaced'}
                          </StatusPill>
                        </>
                      }
                      meta={[
                        {
                          kind: 'branch',
                          text: d.branch,
                        },
                        {
                          kind: 'user',
                          text: d.by,
                        },
                        ...(d.approvedBy
                          ? [
                              {
                                kind: 'tests' as const,
                                text: `approved by ${d.approvedBy}`,
                              },
                            ]
                          : []),
                        {
                          kind: 'time',
                          text: d.age,
                        },
                      ]}
                      action={
                        d.state === 'replaced' ? (
                          <Button size="sm" variant="outline">
                            Roll back
                          </Button>
                        ) : undefined
                      }
                    />
                  ))}
                </ItemList>
              ) : (
                <p className="text-sm text-muted-foreground">No deploys yet.</p>
              )}
            </Section>
          </div>
          <div className="flex flex-col gap-4">
            <Section title="Last 24 hours">
              <Card className="gap-3 px-4 py-4">
                <PixelBars
                  values={app.trend}
                  tone={app.state === 'failed' ? 'danger' : undefined}
                />
                <Stats items={app.stats} />
              </Card>
            </Section>
          </div>
        </div>
      )}
    </div>
  )
}

function AppSettings({ app }: { app: App }) {
  return (
    <SettingsCard>
      <Row label="Source" why="Where the app is built from.">
        <span className="font-mono text-xs">harshjv/etherbit-next-api</span>
      </Row>
      <Row label="Start command">
        <Input defaultValue="node dist/server.js" className="font-mono text-xs" />
      </Row>
      <Row label="Health check" why="How Stationly knows a new version is ready.">
        <div className="flex flex-col gap-2">
          <Input defaultValue="GET /health on port 3000" className="font-mono text-xs" />
          <span className="text-xs text-muted-foreground">
            Port 3000 is the app&apos;s only HTTP port, so it was picked for you.
          </span>
        </div>
      </Row>
      <Row label="Links">
        <div className="flex flex-col items-start gap-2">
          {app.link && (
            <Meta icon={ExternalLink} label="Link">
              {app.link}
            </Meta>
          )}
          <Button size="sm" variant="outline">
            Add a domain
          </Button>
        </div>
      </Row>
      <Row label="Storage" why="Files that survive a deploy, backed up nightly.">
        <div className="flex flex-col items-start gap-2">
          <Facts
            facts={[
              {
                kind: 'files',
                text: '/app/uploads',
              },
              {
                kind: 'health',
                text: '3.4 of 10 GB',
              },
              {
                kind: 'time',
                text: 'backed up 03:00',
              },
            ]}
          />
          <div className="flex gap-2">
            <Button size="sm" variant="outline">
              Back up now
            </Button>
            <Button size="sm" variant="outline">
              Restore a backup
            </Button>
          </div>
        </div>
      </Row>
      <Row
        label="Sleep when idle"
        why="Stops after 30 minutes with no traffic; the next request wakes it."
      >
        <Switch />
      </Row>
      <Row label="Delete app">
        <Button size="sm" variant="destructive">
          Delete {app.name}
        </Button>
      </Row>
    </SettingsCard>
  )
}
