import { Link, Outlet, useLocation, useNavigate, useParams } from '@tanstack/react-router'
import { Bell, Blocks, Folder, LayoutGrid, Plus, Search } from 'lucide-react'
import { useEffect, useState } from 'react'

import { CommandPalette } from '@/components/command-palette'
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
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from '@/components/ui/sidebar'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useLiveEvents } from '@/lib/live'
import { useShortcut, type ShortcutId } from '@/lib/shortcuts'
import { toneText } from '@/lib/tone'
import { cn } from '@/lib/utils'

import { taskTone, useProjectList, useTaskRows, type TaskState } from './data'
import { useInboxCount } from './inbox'
import { failingApps, useLiveApps } from './ops-live'
import { OutsideNav } from './outside'
import { modeHome, useMode, useProject, type Mode } from './where'

function useShellShortcuts(
  setPalette: (toggle: (open: boolean) => boolean) => void,
  onHelp: () => void,
) {
  const navigate = useNavigate()
  const project = useProject()
  const home = (mode: Mode) => () => void navigate(modeHome(mode, project))

  useShortcut('palette', () => setPalette((open) => !open))
  useShortcut('help', onHelp)
  useShortcut(
    'newTask',
    () =>
      void navigate({
        to: '/build/new',
        search: {
          project: project ?? undefined,
        },
      }),
  )
  useShortcut('build', home('build'))
  useShortcut('ship', home('ship'))
  useShortcut('observe', home('observe'))
  useShortcut('inbox', home('outside'))
  useShortcut(
    'connect',
    () =>
      void navigate({
        to: '/connect',
      }),
  )
  useShortcut(
    'account',
    () =>
      void navigate({
        to: '/account',
      }),
  )
  useShortcut(
    'team',
    () =>
      void navigate({
        to: '/team',
      }),
  )
  useShortcut(
    'servers',
    () =>
      void navigate({
        to: '/servers',
      }),
  )
}

function CloseOnNavigate() {
  const { setOpenMobile } = useSidebar()
  const href = useLocation({
    select: (location) => location.href,
  })

  useEffect(() => {
    setOpenMobile(false)
  }, [href, setOpenMobile])

  return null
}

export function App() {
  const mode = useMode()
  const project = useProject()
  const navigate = useNavigate()
  const projectList = useProjectList()
  const live = useLiveEvents()
  const [palette, setPalette] = useState(false)
  const [help, setHelp] = useState(false)
  const openHelp = () => setHelp(true)

  useShellShortcuts(setPalette, openHelp)

  return (
    <SidebarProvider className="h-svh overflow-clip">
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
      <CloseOnNavigate />
      <Sidebar>
        <SidebarHeader>
          <div className="flex items-center gap-2 px-2 py-1">
            <span className="flex size-6 items-center justify-center bg-primary text-primary-foreground">
              <Blocks className="size-3.5" />
            </span>
            <span className="flex-1 font-display text-base">Stationly</span>
          </div>
          {mode === 'build' && (
            <Button asChild variant="outline" className="justify-start">
              <Link
                to="/build/new"
                search={{
                  project: project ?? undefined,
                }}
              >
                <Plus /> New task <ShortcutKeys id="newTask" className="ml-auto" />
              </Link>
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
          {mode === 'build' && <TaskList project={project} />}
          {(mode === 'ship' || mode === 'observe') && <ProjectList mode={mode} project={project} />}
          {mode === 'outside' && <OutsideNav />}
        </SidebarContent>
        <SidebarFooter>
          <AccountMenu onHelp={openHelp} />
        </SidebarFooter>
      </Sidebar>
      <div className="relative flex min-w-0 flex-1 flex-col overflow-clip bg-background">
        <header className="grid h-14 shrink-0 grid-cols-3 items-center gap-4 border-b px-4">
          <div className="flex min-w-0 items-center gap-2">
            <SidebarTrigger className="md:hidden" aria-label="Open the menu" />
            <Select
              value={project ?? 'all'}
              onValueChange={(v) => void navigate(modeHome(mode, v === 'all' ? null : v))}
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
            value={mode === 'outside' ? '' : mode}
            onValueChange={(v) => v && void navigate(modeHome(v as Mode, project))}
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
        <main
          id="main"
          tabIndex={-1}
          data-scroll-restoration-id="main"
          className="min-h-0 flex-1 overflow-auto outline-none"
        >
          <Outlet />
        </main>
      </div>
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

const taskStateIcon: Record<TaskState, State> = {
  working: 'working',
  setup: 'pending',
  waiting: 'waiting',
  finished: 'done',
  queued: 'queued',
  failed: 'failed',
}

function TaskList({ project }: { project: string | null }) {
  const tasks = useTaskRows()
  const current = useParams({
    strict: false,
    select: (params) => params.task,
  })
  const shown = tasks.filter((t) => !project || t.project === project)
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
                  isActive={current === t.id}
                >
                  <Link
                    to="/build/$task"
                    params={{
                      task: t.id,
                    }}
                    search={{
                      project: project ?? undefined,
                    }}
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
                        {!project && (
                          <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground">
                            <Folder className="size-3" aria-label="Project" />
                            {t.project}
                          </span>
                        )}
                      </span>
                    </span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroup>
      )
    )
  })
}

function ProjectList({ mode, project }: { mode: 'ship' | 'observe'; project: string | null }) {
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
          <SidebarMenuButton asChild isActive={!project}>
            <Link {...modeHome(mode, null)}>
              <LayoutGrid /> All projects
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
        {listed.map((p) => {
          const tone = toneOf(p.id)

          return (
            <SidebarMenuItem key={p.id}>
              <SidebarMenuButton asChild isActive={project === p.id}>
                <Link {...modeHome(mode, p.id)}>
                  <span className={cn('size-2 bg-current', toneText[tone])} aria-hidden />
                  {p.name}
                </Link>
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
  const project = useProject()

  return (
    <Button asChild variant="ghost" size="sm">
      <Link {...modeHome('outside', project)} aria-label={`Inbox, ${count} waiting`}>
        <Bell /> Inbox{' '}
        {count > 0 && <span className={cn('tabular-nums', toneText.warning)}>{count}</span>}
      </Link>
    </Button>
  )
}
