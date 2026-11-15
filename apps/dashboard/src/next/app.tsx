import { Bell, Blocks, Folder, LayoutGrid, Plus, Search } from 'lucide-react'
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
import { toneText } from '@/lib/tone'
import { cn } from '@/lib/utils'

import { BuildScreen } from './build'
import { Catalogue } from './catalogue'
import { useLive, useProjectList, useTaskRows } from './data'
import { projects, taskTone, type TaskState } from './fixtures'
import { useInboxCount } from './inbox'
import { ObserveScreen } from './observe'
import { OutsideNav, OutsideScreen, pages } from './outside'
import { ShipScreen } from './ship'
import { StoryGuide, useWorld } from './story'

export type Mode = 'build' | 'ship' | 'observe' | 'outside' | 'catalogue'
export type Place = { mode: Mode; project: string | null; view: string | null }

const read = (): Place => {
  const [path, query] = location.hash.replace(/^#/, '').split('?')
  const [mode, view] = (path ?? '').split('/')
  const project = new URLSearchParams(query).get('p')

  return {
    mode:
      (['build', 'ship', 'observe', 'outside', 'catalogue'] as const).find((m) => m === mode) ??
      'build',
    project: projects.some((p) => p.id === project) ? project : null,
    view: view || (path ? null : 'paise'),
  }
}

export function App() {
  const [place, setPlace] = useState(read)
  const projectList = useProjectList()
  const live = useLive()

  useEffect(() => {
    document.documentElement.classList.add('workbench')
  }, [])

  const go = (next: Partial<Place>) => {
    setPlace((current) => ({
      ...current,
      view: null,
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
          {place.mode === 'ship' && <ProjectList place={place} go={go} kind="ship" />}
          {place.mode === 'observe' && <ProjectList place={place} go={go} kind="observe" />}
          {place.mode === 'outside' && <OutsideNav place={place} go={go} />}
          {place.mode === 'catalogue' && <ProjectList place={place} go={go} kind="ship" />}
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
            value={place.mode === 'catalogue' || place.mode === 'outside' ? '' : place.mode}
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
        {place.mode !== 'catalogue' && !live && <StoryGuide go={go} />}
        <div className="min-h-0 flex-1 overflow-auto">
          {place.mode === 'build' && <BuildScreen place={place} go={go} />}
          {place.mode === 'ship' && <ShipScreen place={place} go={go} />}
          {place.mode === 'observe' && <ObserveScreen place={place} go={go} />}
          {place.mode === 'outside' && <OutsideScreen place={place} go={go} />}
          {place.mode === 'catalogue' && <Catalogue />}
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

function ProjectList({ place, go, kind }: Nav & { kind: 'ship' | 'observe' }) {
  const { apps, incidents } = useWorld()

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
        {projects.map((p) => {
          const found = incidents.filter((i) => i.project === p.id)
          const tone =
            kind === 'ship'
              ? apps.some((a) => a.project === p.id && a.state === 'failed')
                ? 'danger'
                : 'success'
              : found.some((i) => i.tone === 'danger')
                ? 'danger'
                : found.length
                  ? 'warning'
                  : 'success'

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

function AccountMenu({ go }: { go: (next: Partial<Place>) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <SidebarMenuButton size="lg">
          <Avatar className="size-7">
            <AvatarFallback>HV</AvatarFallback>
          </Avatar>
          <span className="flex flex-col">
            <span className="text-sm">Harsh</span>
            <span className="text-xs text-muted-foreground">Admin</span>
          </span>
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        <DropdownMenuLabel className="flex flex-col">
          <span>Harsh</span>
          <span className="font-mono text-xs font-normal text-muted-foreground">@harshjv</span>
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
        <DropdownMenuItem
          onClick={() =>
            go({
              mode: 'catalogue',
            })
          }
        >
          <Blocks /> Design catalogue
        </DropdownMenuItem>
        <DropdownMenuItem className="text-muted-foreground">Stationly 0.1.3-rc.9</DropdownMenuItem>
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
