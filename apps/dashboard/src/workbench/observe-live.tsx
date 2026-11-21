import { useQueries, useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { Activity as ActivityIcon, Box, CircleAlert } from 'lucide-react'

import { Code, Output } from '@/components/code'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, unwrap } from '@/lib/api'
import { bytes, shortAgo, usedOf } from '@/lib/format'
import { appStatus } from '@/lib/labels'
import { appTo, newTaskTo, observeTo } from '@/lib/links'
import { appMetricsQuery, logsQuery } from '@/lib/queries'

import { fixOf } from './fix-live'
import { failingApps, placeName, reportsMetrics, useLiveApps, type LiveApp } from './ops-live'
import { ItemList, ItemRow, Page, PageTabPanel, PageTabs, Section, StatusPill } from './parts'

const tabs = ['attention', 'logs', 'metrics', 'activity'] as const

export function LiveObserve({
  project,
  tab: shown,
  app,
}: {
  project: string
  tab: string | null
  app: string | null
}) {
  const navigate = useNavigate()
  const tab = tabs.find((t) => t === shown) ?? 'attention'
  const apps = useLiveApps(project)
  const select = (next: string) =>
    void navigate({
      ...observeTo(project, next === 'attention' ? undefined : next),
      search: (prev) => prev,
    })
  const pick = (next: string) =>
    void navigate({
      ...observeTo(project, tab === 'attention' ? undefined : tab),
      search: {
        app: next,
      },
    })

  return (
    <Page title="Observe">
      <PageTabs value={tab} onValueChange={select}>
        <TabsList>
          <TabsTrigger value="attention">Attention</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="metrics">Metrics</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>
        <PageTabPanel value="attention">
          <Attention apps={apps} />
        </PageTabPanel>
        <PageTabPanel value="logs">
          <Logs apps={apps} picked={app} onPick={pick} />
        </PageTabPanel>
        <PageTabPanel value="metrics">
          <Metrics apps={apps} />
        </PageTabPanel>
        <PageTabPanel value="activity">
          <Activity />
        </PageTabPanel>
      </PageTabs>
    </Page>
  )
}

function Attention({ apps }: { apps: LiveApp[] }) {
  const troubled = failingApps(apps)

  return (
    <Section title="Needs attention" count={troubled.length}>
      {troubled.length === 0 ? (
        <p className="text-sm text-muted-foreground">All healthy</p>
      ) : (
        <ItemList>
          {troubled.map((live) => (
            <ItemRow
              key={live.app.id}
              icon={CircleAlert}
              tone={appStatus[live.app.status].tone}
              title={
                <>
                  {live.app.name}
                  <StatusPill tone={appStatus[live.app.status].tone}>
                    {live.newest?.status === 'failed'
                      ? `Deploy #${live.newest.number} failed`
                      : appStatus[live.app.status].label}
                  </StatusPill>
                </>
              }
              meta={[
                {
                  kind: 'project',
                  text: placeName(live.place),
                },
                ...(live.newest?.failure?.summary
                  ? [
                      {
                        kind: 'health' as const,
                        text: live.newest.failure.summary,
                      },
                    ]
                  : []),
              ]}
              action={
                <>
                  <Button asChild size="sm" variant="outline">
                    <Link {...appTo(live.place.project.name, live.app.id)}>Open</Link>
                  </Button>
                  <Button asChild size="sm">
                    <Link {...newTaskTo(live.place.project.name, fixOf(live))}>
                      Fix with an agent
                    </Link>
                  </Button>
                </>
              }
            />
          ))}
        </ItemList>
      )}
    </Section>
  )
}

function Logs({
  apps,
  picked,
  onPick,
}: {
  apps: LiveApp[]
  picked: string | null
  onPick: (app: string) => void
}) {
  const chosen = picked ?? apps[0]?.app.id ?? null
  const logs = useQuery({
    ...logsQuery({
      app: chosen ?? '',
    }),
    enabled: Boolean(chosen),
    refetchInterval: 5000,
  })

  return (
    <Section
      title="Logs"
      action={
        <Select value={chosen ?? undefined} onValueChange={onPick}>
          <SelectTrigger className="w-64" aria-label="App">
            <SelectValue placeholder="Pick an app" />
          </SelectTrigger>
          <SelectContent>
            {apps.map((live) => (
              <SelectItem key={live.app.id} value={live.app.id}>
                {placeName(live.place)} / {live.app.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    >
      <Output className="max-h-96">
        {(logs.data ?? [])
          .slice(-300)
          .map((line) => `${line.at.slice(11, 19)}  ${line.text}`)
          .join('\n') || (chosen ? 'No log lines yet.' : 'No apps yet.')}
      </Output>
    </Section>
  )
}

type Sample = {
  cpu_pct?: number | null
  memory_bytes?: number | null
  memory_limit_bytes?: number | null
  restarts?: number | null
}

function Metrics({ apps }: { apps: LiveApp[] }) {
  const samples = useQueries({
    queries: apps.map((live) => ({
      ...appMetricsQuery(live.app.id),
      enabled: reportsMetrics(live.app),
    })),
  })

  return (
    <Section title="Now">
      <ItemList>
        {apps.map((live, index) => {
          const sample = (samples[index]?.data ?? {}) as Sample
          const place = {
            kind: 'project' as const,
            text: placeName(live.place),
          }

          return (
            <ItemRow
              key={live.app.id}
              icon={Box}
              title={live.app.name}
              meta={
                reportsMetrics(live.app)
                  ? [
                      place,
                      {
                        kind: 'health',
                        text:
                          sample.cpu_pct == null
                            ? 'CPU not measured'
                            : `CPU ${Math.round(sample.cpu_pct)}%`,
                      },
                      {
                        kind: 'files',
                        text:
                          sample.memory_bytes == null
                            ? 'Memory not measured'
                            : `Memory ${sample.memory_limit_bytes ? usedOf(sample.memory_bytes, sample.memory_limit_bytes) : bytes(sample.memory_bytes)}`,
                      },
                      {
                        kind: 'status',
                        text: `${sample.restarts ?? 0} restarts`,
                      },
                    ]
                  : [
                      place,
                      {
                        kind: 'status',
                        text: `${appStatus[live.app.status].label}, nothing to measure`,
                      },
                    ]
              }
            />
          )
        })}
      </ItemList>
    </Section>
  )
}

type AuditRow = {
  id: string
  action: string
  created_at: string
  actor: { type: string; id: string | null }
}

function Activity() {
  const audit = useQuery({
    queryKey: ['audit', 'recent'],
    queryFn: () =>
      unwrap(
        api.v1.audit.get({
          query: {
            limit: 50,
          },
        }),
      ),
    refetchInterval: 15_000,
  })
  const rows = (audit.data?.items ?? []) as AuditRow[]

  return (
    <Section title="Activity" count={rows.length}>
      <ItemList>
        {rows.map((row) => (
          <ItemRow
            key={row.id}
            icon={ActivityIcon}
            title={<Code>{row.action}</Code>}
            meta={[
              {
                kind: 'user',
                text: row.actor.type,
              },
              {
                kind: 'time',
                text: shortAgo(row.created_at),
              },
            ]}
          />
        ))}
      </ItemList>
    </Section>
  )
}
