import { useQueries, useQuery } from '@tanstack/react-query'
import { Activity as ActivityIcon, Box, CircleAlert } from 'lucide-react'
import { useState } from 'react'

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
import { bytes, shortAgo } from '@/lib/format'
import { appStatus } from '@/lib/labels'
import type { Go, Place } from '@/lib/nav'
import { logsQuery } from '@/lib/queries'

import { failingApps, useLiveApps, type LiveApp } from './ops-live'
import { ItemList, ItemRow, Page, PageTabPanel, PageTabs, Section, StatusPill } from './parts'

type Tab = 'attention' | 'logs' | 'metrics' | 'activity'

const fixOf = (live: LiveApp) =>
  live.newest?.status === 'failed' ? `deployment:${live.newest.id}` : `app:${live.app.id}`

export function LiveObserve({ place, go }: { place: Place; go: Go }) {
  const [tab, setTab] = useState<Tab>('attention')
  const apps = useLiveApps(place.project)

  return (
    <Page title="Observe">
      <PageTabs value={tab} onValueChange={(next) => setTab(next as Tab)}>
        <TabsList>
          <TabsTrigger value="attention">Attention</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="metrics">Metrics</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>
        <PageTabPanel value="attention">
          <Attention apps={apps} go={go} />
        </PageTabPanel>
        <PageTabPanel value="logs">
          <Logs apps={apps} />
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

function Attention({ apps, go }: { apps: LiveApp[]; go: Go }) {
  const troubled = failingApps(apps)

  return (
    <Section title="Needs attention" count={troubled.length}>
      {troubled.length === 0 ? (
        <p className="text-sm text-muted-foreground">Every app is healthy.</p>
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
                  text: `${live.place.project.name} / ${live.place.name}`,
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
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      go({
                        mode: 'ship',
                        view: `app:${live.app.id}`,
                      })
                    }
                  >
                    Open
                  </Button>
                  <Button
                    size="sm"
                    onClick={() =>
                      go({
                        mode: 'build',
                        view: 'fix',
                        fix: fixOf(live),
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
      )}
    </Section>
  )
}

function Logs({ apps }: { apps: LiveApp[] }) {
  const [picked, setPicked] = useState<string | null>(null)
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
        <Select value={chosen ?? undefined} onValueChange={setPicked}>
          <SelectTrigger className="w-64" aria-label="App">
            <SelectValue placeholder="Pick an app" />
          </SelectTrigger>
          <SelectContent>
            {apps.map((live) => (
              <SelectItem key={live.app.id} value={live.app.id}>
                {live.place.project.name} / {live.app.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    >
      <pre className="max-h-96 overflow-auto bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
        {(logs.data ?? [])
          .slice(-300)
          .map((line) => `${line.at.slice(11, 19)}  ${line.text}`)
          .join('\n') || (chosen ? 'No log lines yet.' : 'No apps yet.')}
      </pre>
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
      queryKey: ['metrics', live.app.id],
      queryFn: () =>
        unwrap(
          api.v1
            .apps({
              app: live.app.id,
            })
            .metrics.get(),
        ),
      refetchInterval: 10_000,
    })),
  })

  return (
    <Section title="Now" note="Each app's current sample. History comes later.">
      <ItemList>
        {apps.map((live, index) => {
          const sample = (samples[index]?.data ?? {}) as Sample

          return (
            <ItemRow
              key={live.app.id}
              icon={Box}
              title={live.app.name}
              meta={[
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
                      : `Memory ${bytes(sample.memory_bytes)}${sample.memory_limit_bytes ? ` of ${bytes(sample.memory_limit_bytes)}` : ''}`,
                },
                {
                  kind: 'status',
                  text: `${sample.restarts ?? 0} restarts`,
                },
              ]}
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
            title={<span className="font-mono text-sm">{row.action}</span>}
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
