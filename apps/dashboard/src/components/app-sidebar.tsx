import { useQuery } from '@tanstack/react-query'
import { Link, useParams } from '@tanstack/react-router'
import {
  Bell,
  ChevronsLeft,
  FolderKanban,
  GitPullRequestArrow,
  Plug,
  Plus,
  Radio,
  Search,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { Logo } from '@/components/logo'
import { useNow } from '@/components/sandbox-clock'
import { SessionsList } from '@/components/sessions-list'
import { LiveIndicator, ThemeMenu, UserMenu } from '@/components/shell-menus'
import { Button } from '@/components/ui/button'
import { isInstanceAdmin } from '@/lib/agent-session'
import { groupSessions } from '@/lib/agent-sessions'
import type { StreamState } from '@/lib/event-stream'
import {
  agentSessionsQuery,
  meQuery,
  releasesQuery,
  stagedQuery,
  stationsQuery,
} from '@/lib/queries'
import { setSidebarCollapsed } from '@/lib/sidebar'
import { countPill, toneDot } from '@/lib/tone'
import { cn } from '@/lib/utils'

const rowClass =
  'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[status=active]:bg-muted data-[status=active]:font-medium data-[status=active]:text-foreground'

function NavRow({
  to,
  icon,
  children,
  onOpen,
}: {
  to: '/projects' | '/staged' | '/stations' | '/connect'
  icon: ReactNode
  children: ReactNode
  onOpen?: () => void
}) {
  return (
    <Link to={to} className={rowClass} onClick={onOpen}>
      {icon}
      {children}
    </Link>
  )
}

function StationsRow({ onOpen }: { onOpen?: () => void }) {
  const stations = useQuery(stationsQuery)
  const releases = useQuery(releasesQuery)
  const items = stations.data?.items ?? []
  const online = items.filter((station) => station.status === 'online').length
  const newer = releases.data?.available.length ?? 0

  return (
    <NavRow to="/stations" icon={<Radio className="size-4" aria-hidden />} onOpen={onOpen}>
      Stations
      <span className="ml-auto flex items-center gap-1.5 text-xs tabular-nums">
        {newer > 0 && (
          <span className={countPill} aria-label="An upgrade is available">
            Update
          </span>
        )}
        {items.length > 0 && (
          <>
            <span
              className={cn(
                'size-1.5 rounded-full',
                toneDot[online === items.length ? 'success' : 'warning'],
              )}
              aria-hidden
            />
            <span aria-label={`${online} of ${items.length} stations online`}>
              {online}/{items.length}
            </span>
          </>
        )}
      </span>
    </NavRow>
  )
}

function StagedRow({ onOpen }: { onOpen?: () => void }) {
  const staged = useQuery(stagedQuery('staged'))
  const pending = staged.data?.items.length ?? 0

  return (
    <NavRow
      to="/staged"
      icon={<GitPullRequestArrow className="size-4" aria-hidden />}
      onOpen={onOpen}
    >
      Staged changes
      {pending > 0 && (
        <span className={cn('ml-auto', countPill)} aria-label={`${pending} waiting`}>
          {pending}
        </span>
      )}
    </NavRow>
  )
}

function Sessions({ onOpen, onlyWaiting }: { onOpen?: () => void; onlyWaiting: boolean }) {
  const { data } = useQuery(agentSessionsQuery())
  const open = useParams({
    strict: false,
    select: (params) =>
      'sandbox' in params && 'session' in params
        ? {
            sandbox: params.sandbox as string,
            session: params.session as string,
          }
        : null,
  })

  return (
    <SessionsList
      sessions={data?.items ?? []}
      selected={open}
      onlyWaiting={onlyWaiting}
      onOpen={onOpen}
    />
  )
}

export function AppSidebar({
  live,
  onPalette,
  onHelp,
  onOpen,
  collapsible,
}: {
  live: StreamState
  onPalette: () => void
  onHelp: () => void
  onOpen?: () => void
  collapsible: boolean
}) {
  const { data: me } = useQuery(meQuery)
  const admin = isInstanceAdmin(me?.scopes ?? [])
  const { data: sessions } = useQuery({
    ...agentSessionsQuery(),
    enabled: admin,
  })
  const [onlyWaiting, setOnlyWaiting] = useState(false)
  const now = useNow(60_000)
  const waiting =
    groupSessions(sessions?.items ?? [], new Date(now)).find((entry) => entry.group === 'waiting')
      ?.items.length ?? 0

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/30">
      <div className="flex h-12 shrink-0 items-center gap-1 px-3">
        <Link
          to="/"
          onClick={onOpen}
          className="mr-auto flex items-center gap-2 rounded-md text-sm font-semibold tracking-tight"
          aria-label="Stationly home"
        >
          <Logo className="size-5" />
          Stationly
        </Link>
        {admin && (
          <Button
            variant="ghost"
            size="icon-sm"
            className="relative"
            aria-label={waiting > 0 ? `${waiting} waiting on you` : 'Nothing waiting on you'}
            aria-pressed={onlyWaiting}
            onClick={() => setOnlyWaiting((value) => !value)}
          >
            <Bell />
            {waiting > 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full bg-amber-500 text-[10px] font-medium text-white">
                {waiting}
              </span>
            )}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Search or run a command"
          aria-haspopup="dialog"
          onClick={onPalette}
        >
          <Search />
        </Button>
        {collapsible && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Hide the sidebar"
            onClick={() => setSidebarCollapsed(true)}
          >
            <ChevronsLeft />
          </Button>
        )}
      </div>
      {admin && (
        <div className="shrink-0 px-2 pb-2">
          <Button asChild variant="outline" className="w-full justify-start" onClick={onOpen}>
            <Link to="/">
              <Plus /> New task
            </Link>
          </Button>
        </div>
      )}
      {admin ? <Sessions onOpen={onOpen} onlyWaiting={onlyWaiting} /> : <div className="flex-1" />}
      <nav aria-label="Main" className="shrink-0 space-y-0.5 border-t p-2">
        <NavRow
          to="/projects"
          icon={<FolderKanban className="size-4" aria-hidden />}
          onOpen={onOpen}
        >
          Projects
        </NavRow>
        <StagedRow onOpen={onOpen} />
        <StationsRow onOpen={onOpen} />
        <NavRow to="/connect" icon={<Plug className="size-4" aria-hidden />} onOpen={onOpen}>
          Connect
        </NavRow>
      </nav>
      <div className="flex shrink-0 items-center gap-1 border-t p-2">
        <UserMenu onHelp={onHelp} />
        <ThemeMenu />
        <LiveIndicator state={live} />
      </div>
    </div>
  )
}
