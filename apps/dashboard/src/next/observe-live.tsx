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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, unwrap } from '@/lib/api'
import { bytes, shortAgo } from '@/lib/format'
import { logsQuery } from '@/lib/queries'

import type { Place } from './app'
import { healthText, healthTone, troubledApps, useLiveApps, type LiveApp } from './ops-live'
import { ItemList, ItemRow, Page, Section, StatusPill } from './parts'

type Go = (next: Partial<Place>) => void

type Tab = 'attention' | 'logs' | 'metrics' | 'activity'

const fixOf = (app: LiveApp) =>
  app.newest?.status === 'failed' ? `deployment:${app.newest.id}` : `service:${app.service.id}`

export function LiveObserve({ place, go }: { place: Place; go: Go }) {
  const [tab, setTab] = useState<Tab>('attention')
  const apps = useLiveApps(place.project)

  return (
    <Page title="Observe">
      <Tabs value={tab} onValueChange={(next) => setTab(next as Tab)}>
        <TabsList>
          <TabsTrigger value="attention">Attention</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="metrics">Metrics</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>
      </Tabs>
      {tab === 'attention' && <Attention apps={apps} go={go} />}
      {tab === 'logs' && <Logs apps={apps} />}
      {tab === 'metrics' && <Metrics apps={apps} />}
      {tab === 'activity' && <Activity />}
    </Page>
  )
}

function Attention({ apps, go }: { apps: LiveApp[]; go: Go }) {
  const troubled = troubledApps(apps)

  return (
    <Section title="Needs attention" count={troubled.length}>
      {troubled.length === 0 ? (
        <p className="text-sm text-muted-foreground">Every app is healthy.</p>
      ) : (
        <ItemList>
          {troubled.map((app) => (
            <ItemRow
              key={app.service.id}
              icon={CircleAlert}
              tone={app.newest?.status === 'failed' ? 'danger' : healthTone[app.service.status]}
              title={
                <>
                  {app.service.name}
                  <StatusPill tone={healthTone[app.service.status]}>
                    {app.newest?.status === 'failed'
                      ? `Deploy #${app.newest.number} failed`
                      : healthText[app.service.status]}
                  </StatusPill>
                </>
              }
              meta={[
                {
                  kind: 'project',
                  text: `${app.environment.project.name} / ${app.environment.name}`,
                },
                ...(app.newest?.failure?.summary
                  ? [
                      {
                        kind: 'health' as const,
                        text: app.newest.failure.summary,
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
                        view: `app:${app.service.id}`,
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
                        fix: fixOf(app),
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
  const chosen = picked ?? apps[0]?.service.id ?? null
  const logs = useQuery({
    ...logsQuery({
      service: chosen ?? '',
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
            {apps.map((app) => (
              <SelectItem key={app.service.id} value={app.service.id}>
                {app.environment.project.name} / {app.service.name}
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
    queries: apps.map((app) => ({
      queryKey: ['metrics', app.service.id],
      queryFn: () =>
        unwrap(
          api.v1
            .services({
              service: app.service.id,
            })
            .metrics.get(),
        ),
      refetchInterval: 10_000,
    })),
  })

  return (
    <Section title="Now" note="Each app's current sample. History comes later.">
      <ItemList>
        {apps.map((app, index) => {
          const sample = (samples[index]?.data ?? {}) as Sample

          return (
            <ItemRow
              key={app.service.id}
              icon={Box}
              title={app.service.name}
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
