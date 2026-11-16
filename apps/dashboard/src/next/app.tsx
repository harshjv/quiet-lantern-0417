import { useQuery } from '@tanstack/react-query'
import { Bell, Blocks, Folder, LayoutGrid, LogOut, Plus, Search } from 'lucide-react'
import { useEffect, useState } from 'react'

import { StateIcon, type State } from '@/components/state-icon'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Kbd } from '@/components/ui/kbd'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '@/components/ui/sidebar'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { isInstanceAdmin } from '@/lib/agent-session'
import { authClient, sessionQuery } from '@/lib/auth'
import { inventoryQuery, meQuery } from '@/lib/queries'
import { toneText } from '@/lib/tone'
import { cn } from '@/lib/utils'

import { LiveBuild } from './build-live'
import { taskTone, useProjectList, useTaskRows, type TaskState } from './data'
import { useInboxCount } from './inbox'
import { LiveObserve } from './observe-live'
import { failedApps, troubledApps, useLiveApps } from './ops-live'
import { OutsideNav, OutsideScreen, pages } from './outside'
import { LiveShip } from './ship-live'

export type Mode = 'build' | 'ship' | 'observe' | 'outside'
export type Place = { mode: Mode; project: string | null; view: string | null; fix?: string | null }

const read = (): Place => {
  const [path, query] = location.hash.replace(/^#/, '').split('?')
  const [mode, view] = (path ?? '').split('/')
  const project = new URLSearchParams(query).get('p')

  return {
    mode: (['build', 'ship', 'observe', 'outside'] as const).find((m) => m === mode) ?? 'build',
    project: project || null,
    view: view || null,
  }
}

export function App() {
  const [place, setPlace] = useState(read)
  const projectList = useProjectList()

  useEffect(() => {
    document.documentElement.classList.add('workbench')
  }, [])

  const go = (next: Partial<Place>) => {
    setPlace((current) => ({
      ...current,
      view: null,
      fix: null,
      ...next,
    }))
  }

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <div className="flex items-center gap-2 px-2 py-1">
            <span className="flex size-6 items-center justify-center bg-primary text-primary-foreground">
              <Blocks className="size-3.5" />
            </span>
            <span className="flex-1 font-display text-base">Stationly</span>
          </div>
          {place.mode === 'build' && (
            <>
              <Button
                variant="outline"
                className="justify-start"
                onClick={() =>
                  go({
                    view: 'new',
                  })
                }
              >
                <Plus /> New task
              </Button>
              <Button variant="ghost" className="justify-start text-muted-foreground">
                <Search /> Search tasks <Kbd className="ml-auto">/</Kbd>
              </Button>
            </>
          )}
        </SidebarHeader>
        <SidebarContent>
          {place.mode === 'build' && <TaskList place={place} go={go} />}
          {(place.mode === 'ship' || place.mode === 'observe') && (
            <ProjectList place={place} go={go} />
          )}
          {place.mode === 'outside' && <OutsideNav place={place} go={go} />}
        </SidebarContent>
        <SidebarFooter>
          <AccountMenu go={go} />
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="min-w-0">
        <header className="grid h-14 shrink-0 grid-cols-3 items-center gap-4 border-b px-4">
          <Select
            value={place.project ?? 'all'}
            onValueChange={(v) =>
              go({
                project: v === 'all' ? null : v,
              })
            }
          >
            <SelectTrigger className="w-48" aria-label="Project">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All projects</SelectItem>
              {projectList.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ToggleGroup
            type="single"
            variant="outline"
            spacing={0}
            className="justify-self-center"
            value={place.mode === 'outside' ? '' : place.mode}
            onValueChange={(v) =>
              v &&
              go({
                mode: v as Mode,
              })
            }
            aria-label="Mode"
          >
            <ToggleGroupItem value="build" className="min-w-24 font-display">
              Build
            </ToggleGroupItem>
            <ToggleGroupItem value="ship" className="min-w-24 font-display">
              Ship
            </ToggleGroupItem>
            <ToggleGroupItem value="observe" className="min-w-24 font-display">
              Observe
            </ToggleGroupItem>
          </ToggleGroup>
          <div className="flex items-center justify-end gap-2">
            <InboxButton go={go} />
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">
          {place.mode === 'build' && <LiveBuild place={place} go={go} />}
          {place.mode === 'ship' && <LiveShip place={place} go={go} />}
          {place.mode === 'observe' && <LiveObserve place={place} go={go} />}
          {place.mode === 'outside' && <OutsideScreen place={place} go={go} />}
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}

type Nav = { place: Place; go: (next: Partial<Place>) => void }

const taskStateIcon: Record<TaskState, State> = {
  working: 'working',
  setup: 'pending',
  waiting: 'waiting',
  finished: 'done',
  queued: 'queued',
  failed: 'failed',
}

function TaskList({ place, go }: Nav) {
  const tasks = useTaskRows()
  const shown = tasks.filter((t) => !place.project || t.project === place.project)
  const groups: [string, TaskState[]][] = [
    ['Waiting on you', ['waiting']],
    ['Running', ['working', 'setup']],
    ['Queued', ['queued']],
    ['Done', ['finished', 'failed']],
  ]

  return groups.map(([label, states]) => {
    const rows = shown.filter((t) => states.includes(t.state))

    return (
      rows.length > 0 && (
        <SidebarGroup key={label}>
          <SidebarGroupLabel>{label}</SidebarGroupLabel>
          <SidebarMenu>
            {rows.map((t) => (
              <SidebarMenuItem key={t.id}>
                <SidebarMenuButton
                  className="h-auto items-start py-2"
                  isActive={place.view === t.id}
                  onClick={() =>
                    go({
                      view: t.id,
                    })
                  }
                >
                  <StateIcon state={taskStateIcon[t.state]} className="mt-0.5" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex gap-2">
                      <span className="min-w-0 flex-1 truncate">{t.title}</span>
                      <span className="text-xs text-muted-foreground tabular-nums">{t.age}</span>
                    </span>
                    <span className="flex min-w-0 items-center gap-3 font-mono text-xs">
                      <span
                        className={cn(
                          'truncate',
                          t.state === 'waiting'
                            ? toneText[taskTone[t.state]]
                            : 'text-muted-foreground',
                        )}
                      >
                        {t.reason}
                      </span>
                      {!place.project && (
                        <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground">
                          <Folder className="size-3" aria-label="Project" />
                          {t.project}
                        </span>
                      )}
                    </span>
                  </span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      )
    )
  })
}

function ProjectList({ place, go }: Nav) {
  const listed = useProjectList()
  const liveApps = useLiveApps(null)
  const toneOf = (id: string) => {
    const own = liveApps.filter((app) => app.environment.project.name === id)

    return failedApps(own).length ? 'danger' : troubledApps(own).length ? 'warning' : 'success'
  }

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Projects</SidebarGroupLabel>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            isActive={!place.project}
            onClick={() =>
              go({
                project: null,
              })
            }
          >
            <LayoutGrid /> All projects
          </SidebarMenuButton>
        </SidebarMenuItem>
        {listed.map((p) => {
          const tone = toneOf(p.id)

          return (
            <SidebarMenuItem key={p.id}>
              <SidebarMenuButton
                isActive={place.project === p.id}
                onClick={() =>
                  go({
                    project: p.id,
                  })
                }
              >
                <span className={cn('size-2 bg-current', toneText[tone])} aria-hidden />
                {p.name}
              </SidebarMenuButton>
            </SidebarMenuItem>
          )
        })}
      </SidebarMenu>
    </SidebarGroup>
  )
}

const initialsOf = (name: string) =>
  name
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('') || '?'

function useAccount() {
  const session = useQuery(sessionQuery)
  const inventory = useQuery(inventoryQuery)
  const me = useQuery(meQuery)
  const admin = isInstanceAdmin(me.data?.scopes ?? [])
  const user = session.data?.user

  return {
    name: user?.name || user?.email || 'Signed in',
    detail: user?.email ?? '',
    role: admin ? 'Admin' : 'Member',
    version: inventory.data?.release?.version ?? null,
  }
}

function AccountMenu({ go }: { go: (next: Partial<Place>) => void }) {
  const account = useAccount()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton size="lg">
          <Avatar className="size-7">
            <AvatarFallback>{initialsOf(account.name)}</AvatarFallback>
          </Avatar>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-sm">{account.name}</span>
            <span className="text-xs text-muted-foreground">{account.role}</span>
          </span>
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        <DropdownMenuLabel className="flex flex-col">
          <span className="truncate">{account.name}</span>
          <span className="truncate font-mono text-xs font-normal text-muted-foreground">
            {account.detail}
          </span>
        </DropdownMenuLabel>
        {pages
          .filter((p) => p.id !== 'inbox')
          .map((p) => (
            <DropdownMenuItem
              key={p.id}
              onClick={() =>
                go({
                  mode: 'outside',
                  view: p.id,
                })
              }
            >
              <p.icon /> {p.title}
            </DropdownMenuItem>
          ))}
        <DropdownMenuSeparator />
        {account.version && (
          <DropdownMenuItem className="text-muted-foreground">
            Stationly {account.version}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          onClick={() => void authClient.signOut().then(() => window.location.assign('/login'))}
        >
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function InboxButton({ go }: { go: (next: Partial<Place>) => void }) {
  const count = useInboxCount()

  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={`Inbox, ${count} waiting`}
      onClick={() =>
        go({
          mode: 'outside',
          view: 'inbox',
        })
      }
    >
      <Bell /> Inbox{' '}
      {count > 0 && <span className={cn('tabular-nums', toneText.warning)}>{count}</span>}
    </Button>
  )
}
