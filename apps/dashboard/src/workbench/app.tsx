import { Bell, Blocks, Folder, LayoutGrid, Plus, Search } from 'lucide-react'
import { useEffect, useState } from 'react'

import { CommandPalette } from '@/components/command-palette'
import { PlaceLink } from '@/components/place-link'
import { AccountMenu, LiveIndicator } from '@/components/shell-menus'
import { ShortcutKeys, spoken } from '@/components/shortcut-keys'
import { ShortcutsHelp } from '@/components/shortcuts-help'
import { StateIcon, type State } from '@/components/state-icon'
import { Button } from '@/components/ui/button'
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
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useLiveEvents } from '@/lib/live'
import { go, placeHref, places, usePlace, type Go, type Mode, type Place } from '@/lib/nav'
import { useShortcut, type ShortcutId } from '@/lib/shortcuts'
import { toneText } from '@/lib/tone'
import { cn } from '@/lib/utils'

import { LiveBuild } from './build-live'
import { taskTone, useProjectList, useTaskRows, type TaskState } from './data'
import { useInboxCount } from './inbox'
import { LiveObserve } from './observe-live'
import { failingApps, useLiveApps } from './ops-live'
import { OutsideNav, OutsideScreen } from './outside'
import { usePlaceTitle } from './place-title'
import { LiveShip } from './ship-live'

function useShellShortcuts(
  setPalette: (toggle: (open: boolean) => boolean) => void,
  onHelp: () => void,
) {
  useShortcut('palette', () => setPalette((open) => !open))
  useShortcut('help', onHelp)
  useShortcut('newTask', () =>
    go({
      mode: 'build',
      view: 'new',
    }),
  )
  useShortcut('build', () =>
    go({
      mode: 'build',
    }),
  )
  useShortcut('ship', () =>
    go({
      mode: 'ship',
    }),
  )
  useShortcut('observe', () =>
    go({
      mode: 'observe',
    }),
  )
  useShortcut('inbox', () => go(places.page('inbox')))
  useShortcut('connect', () => go(places.page('connect')))
  useShortcut('account', () => go(places.page('account')))
  useShortcut('team', () => go(places.page('team')))
}

function CloseOnNavigate({ place }: { place: Place }) {
  const { setOpenMobile } = useSidebar()
  const href = placeHref(place)

  useEffect(() => {
    setOpenMobile(false)
  }, [href, setOpenMobile])

  return null
}

export function App() {
  const place = usePlace()
  const projectList = useProjectList()
  const live = useLiveEvents()
  const [palette, setPalette] = useState(false)
  const [help, setHelp] = useState(false)
  const openHelp = () => setHelp(true)

  useShellShortcuts(setPalette, openHelp)
  usePlaceTitle(place)

  return (
    <SidebarProvider>
      <a
        href="#main"
        onClick={(event) => {
          event.preventDefault()
          document.getElementById('main')?.focus()
        }}
        className="sr-only z-50 bg-background px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Skip to content
      </a>
      <CloseOnNavigate place={place} />
      <Sidebar>
        <SidebarHeader>
          <div className="flex items-center gap-2 px-2 py-1">
            <span className="flex size-6 items-center justify-center bg-primary text-primary-foreground">
              <Blocks className="size-3.5" />
            </span>
            <span className="flex-1 font-display text-base">Stationly</span>
          </div>
          {place.mode === 'build' && (
            <Button asChild variant="outline" className="justify-start">
              <PlaceLink
                to={{
                  mode: 'build',
                  view: 'new',
                }}
              >
                <Plus /> New task <ShortcutKeys id="newTask" className="ml-auto" />
              </PlaceLink>
            </Button>
          )}
          <Button
            variant="ghost"
            className="justify-start text-muted-foreground"
            aria-haspopup="dialog"
            onClick={() => setPalette(true)}
          >
            <Search /> Search <ShortcutKeys id="palette" className="ml-auto" />
          </Button>
        </SidebarHeader>
        <SidebarContent>
          {place.mode === 'build' && <TaskList place={place} go={go} />}
          {(place.mode === 'ship' || place.mode === 'observe') && (
            <ProjectList place={place} go={go} />
          )}
          {place.mode === 'outside' && <OutsideNav place={place} go={go} />}
        </SidebarContent>
        <SidebarFooter>
          <AccountMenu onHelp={openHelp} />
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="min-w-0">
        <header className="grid h-14 shrink-0 grid-cols-3 items-center gap-4 border-b px-4">
          <div className="flex min-w-0 items-center gap-2">
            <SidebarTrigger className="md:hidden" aria-label="Open the menu" />
            <Select
              value={place.project ?? 'all'}
              onValueChange={(v) =>
                go({
                  project: v === 'all' ? null : v,
                })
              }
            >
              <SelectTrigger className="w-48 max-w-full" aria-label="Project">
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
          </div>
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
            {modeItems.map((m) => (
              <ToggleGroupItem
                key={m.mode}
                value={m.mode}
                className="min-w-24 font-display"
                aria-label={`${m.label}, ${spoken(m.shortcut)}`}
              >
                {m.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <div className="flex items-center justify-end gap-2">
            <LiveIndicator state={live} />
            <InboxButton />
          </div>
        </header>
        <main id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-auto outline-none">
          {place.mode === 'build' && <LiveBuild place={place} go={go} />}
          {place.mode === 'ship' && <LiveShip place={place} go={go} />}
          {place.mode === 'observe' && <LiveObserve place={place} go={go} />}
          {place.mode === 'outside' && <OutsideScreen place={place} go={go} />}
        </main>
      </SidebarInset>
      <CommandPalette open={palette} onOpenChange={setPalette} onHelp={openHelp} />
      <ShortcutsHelp open={help} onOpenChange={setHelp} />
    </SidebarProvider>
  )
}

const modeItems: { mode: Exclude<Mode, 'outside'>; label: string; shortcut: ShortcutId }[] = [
  {
    mode: 'build',
    label: 'Build',
    shortcut: 'build',
  },
  {
    mode: 'ship',
    label: 'Ship',
    shortcut: 'ship',
  },
  {
    mode: 'observe',
    label: 'Observe',
    shortcut: 'observe',
  },
]

type Nav = { place: Place; go: Go }

const taskStateIcon: Record<TaskState, State> = {
  working: 'working',
  setup: 'pending',
  waiting: 'waiting',
  finished: 'done',
  queued: 'queued',
  failed: 'failed',
}

function TaskList({ place }: Nav) {
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
                  asChild
                  className="h-auto items-start py-2"
                  isActive={place.view === t.id}
                >
                  <PlaceLink to={places.task(t.id)}>
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
                  </PlaceLink>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      )
    )
  })
}

function ProjectList({ place }: Nav) {
  const listed = useProjectList()
  const liveApps = useLiveApps(null)
  const toneOf = (id: string) => {
    const own = liveApps.filter((app) => app.place.project.name === id)

    return failingApps(own).length ? 'danger' : 'success'
  }

  return (
    <SidebarGroup>
      <SidebarGroupLabel>Projects</SidebarGroupLabel>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton asChild isActive={!place.project}>
            <PlaceLink
              to={{
                project: null,
              }}
            >
              <LayoutGrid /> All projects
            </PlaceLink>
          </SidebarMenuButton>
        </SidebarMenuItem>
        {listed.map((p) => {
          const tone = toneOf(p.id)

          return (
            <SidebarMenuItem key={p.id}>
              <SidebarMenuButton asChild isActive={place.project === p.id}>
                <PlaceLink
                  to={{
                    project: p.id,
                  }}
                >
                  <span className={cn('size-2 bg-current', toneText[tone])} aria-hidden />
                  {p.name}
                </PlaceLink>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )
        })}
      </SidebarMenu>
    </SidebarGroup>
  )
}

function InboxButton() {
  const count = useInboxCount()

  return (
    <Button asChild variant="ghost" size="sm">
      <PlaceLink to={places.page('inbox')} aria-label={`Inbox, ${count} waiting`}>
        <Bell /> Inbox{' '}
        {count > 0 && <span className={cn('tabular-nums', toneText.warning)}>{count}</span>}
      </PlaceLink>
    </Button>
  )
}
