import { useQuery } from '@tanstack/react-query'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { Server, Settings2 } from 'lucide-react'

import { Code } from '@/components/code'
import { Name } from '@/components/name'
import { Rows } from '@/components/page'
import { Failure } from '@/components/panel'
import { ReleaseSection } from '@/components/release-section'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { isInstanceAdmin } from '@/lib/agent-session'
import { byName, bytes, shortAgo, usedOf } from '@/lib/format'
import { meQuery } from '@/lib/queries'

import { ItemList, ItemRow, Notice, Page, Section, StatusPill, type Fact } from './parts'
import { serversQuery, serverStatus, type ServerView } from './server-data'
import { AddServer } from './server-enroll'
import { ServerSheet } from './server-settings'

const share = (used: number, total: number) =>
  total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0

function Meter({
  label,
  value,
  used,
  total,
}: {
  label: string
  value: string
  used?: number
  total?: number
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs tracking-wider text-muted-foreground uppercase">{label}</span>
      <span className="text-sm tabular-nums">{value}</span>
      {used !== undefined && total !== undefined && (
        <Progress value={share(used, total)} aria-label={`${label} ${value}`} className="h-1" />
      )}
    </div>
  )
}

function Usage({ server }: { server: ServerView }) {
  const resources = server.resources
  const memory = server.machine_memory
  const limits = server.machine_limits

  if (!resources) {
    return null
  }

  const diskUsed = resources.disk_bytes - resources.disk_free_bytes

  return (
    <div className="grid gap-4 px-4 pb-4 sm:grid-cols-3 lg:grid-cols-5">
      <Meter label="CPU" value={`${Number((resources.cpu_millis / 1000).toFixed(2))} vCPU`} />
      <Meter label="Memory" value={bytes(resources.memory_bytes)} />
      <Meter
        label="Task memory"
        value={
          memory.limit === null ? `${bytes(memory.used)} used` : usedOf(memory.used, memory.limit)
        }
        used={memory.used}
        total={memory.limit ?? resources.memory_bytes}
      />
      <Meter
        label="Disk"
        value={usedOf(diskUsed, resources.disk_bytes)}
        used={diskUsed}
        total={resources.disk_bytes}
      />
      <Meter
        label="Task slots"
        value={`${limits.max_running} running, ${limits.max_machines} in all`}
      />
    </div>
  )
}

const factsOf = (server: ServerView): Fact[] => [
  ...(server.capabilities?.stationd_version
    ? [
        {
          kind: 'version' as const,
          text: `stationd ${server.capabilities.stationd_version}`,
        },
      ]
    : []),
  ...(server.last_seen_at
    ? [
        {
          kind: 'time' as const,
          text: `seen ${shortAgo(server.last_seen_at)}`,
        },
      ]
    : []),
]

function ServerRow({ server, onOpen }: { server: ServerView; onOpen: () => void }) {
  const status = serverStatus[server.status]
  const trouble = server.version_skew === 'unsupported' || server.generation_failure !== null

  return (
    <div>
      <ItemRow
        icon={Server}
        tone={trouble ? 'danger' : status.tone}
        title={
          <>
            <Name kind="server" chip={false}>
              {server.name}
            </Name>
            <StatusPill tone={status.tone}>{status.label}</StatusPill>
            {server.draining && <StatusPill tone="warning">Draining</StatusPill>}
            {trouble && <StatusPill tone="danger">Needs a look</StatusPill>}
            {server.hosts_dispatch && (
              <span className="text-xs font-normal text-muted-foreground">Runs Dispatch</span>
            )}
          </>
        }
        meta={factsOf(server)}
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={onOpen}
            aria-label={`Settings for ${server.name}`}
          >
            <Settings2 /> Settings
          </Button>
        }
      />
      <Usage server={server} />
    </div>
  )
}

function ServerList() {
  const { data, error, refetch } = useQuery(serversQuery)
  const openId = useSearch({
    from: '/_app/_outside/servers',
    select: (search) => search.server,
  })
  const navigate = useNavigate()
  const show = (server: string | undefined) =>
    void navigate({
      to: '/servers',
      search: (prev) => ({
        ...prev,
        server,
      }),
      replace: server === undefined,
    })
  const servers = [...(data?.items ?? [])].sort(byName)
  const open = servers.find((server) => server.id === openId)

  return (
    <>
      <ReleaseSection stations={servers} />
      <Section icon={Server} title="Servers" count={data ? servers.length : undefined}>
        {error ? (
          <Failure
            error={error}
            title="Couldn’t load your servers"
            onRetry={() => void refetch()}
          />
        ) : !data ? (
          <Rows count={2} />
        ) : openId && !open ? (
          <Notice
            tone="warning"
            title="That server isn’t here"
            action={
              <Button size="sm" variant="outline" onClick={() => show(undefined)}>
                Show all servers
              </Button>
            }
          >
            No server has the id <Code>{openId}</Code>.
          </Notice>
        ) : servers.length === 0 ? (
          <Notice tone="info" title="No servers yet" action={<AddServer />}>
            Add a server to run apps and tasks on it.
          </Notice>
        ) : (
          <ItemList>
            {servers.map((server) => (
              <ServerRow key={server.id} server={server} onOpen={() => show(server.id)} />
            ))}
          </ItemList>
        )}
      </Section>
      {open && <ServerSheet server={open} onOpenChange={(next) => !next && show(undefined)} />}
    </>
  )
}

export function LiveServers() {
  const { data: me } = useQuery(meQuery)

  if (!me) {
    return (
      <Page title="Servers">
        <Rows count={3} />
      </Page>
    )
  }

  if (!isInstanceAdmin(me.scopes)) {
    return (
      <Page title="Servers">
        <Notice tone="info" title="Only admins manage servers">
          Ask an admin to add or change a server.
        </Notice>
      </Page>
    )
  }

  return (
    <Page title="Servers" actions={<AddServer />}>
      <ServerList />
    </Page>
  )
}
