import {
  Link,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
  type LinkOptions,
} from '@tanstack/react-router'
import { Bell, Blocks, LayoutGrid, Plus, Search } from 'lucide-react'
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
import { inboxTo, newTaskTo, taskTo } from '@/lib/links'
import { useLiveEvents } from '@/lib/live'
import { useShortcut, type ShortcutId } from '@/lib/shortcuts'
import { toneText } from '@/lib/tone'
import { cn } from '@/lib/utils'

import { taskTone, useProjectList, useTaskRows, type TaskState } from './data'
import { useInboxCount } from './inbox'
import { failingApps, useLiveApps } from './ops-live'
import { OutsideNav } from './outside'
import { inProject, isView, useMode, useProject, viewTo, type View } from './where'

function useShellShortcuts(
  setPalette: (toggle: (open: boolean) => boolean) => void,
  onHelp: () => void,
) {
  const navigate = useNavigate()
  const project = useProject()
  const go = (to: (project: string) => LinkOptions) => () => void navigate(inProject(to)(project))
  const view = (next: View) => go((p) => viewTo(next, p))

  useShortcut('palette', () => setPalette((open) => !open))
  useShortcut('help', onHelp)
  useShortcut('newTask', go(newTaskTo))
  useShortcut('build', view('build'))
  useShortcut('ship', view('ship'))
  useShortcut('observe', view('observe'))
  useShortcut('inbox', () => void navigate(inboxTo(project)))
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
          {mode === 'build' && project && (
            <Button asChild variant="outline" className="justify-start">
              <Link {...newTaskTo(project)}>
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
          {mode === 'build' && project ? (
            <TaskList project={project} />
          ) : mode === 'outside' ? (
            <OutsideNav />
          ) : (
            <ProjectList view={isView(mode) ? mode : 'overview'} project={project} />
          )}
        </SidebarContent>
        <SidebarFooter>
          <AccountMenu onHelp={openHelp} />
        </SidebarFooter>
      </Sidebar>
      <div className="relative flex min-w-0 flex-1 flex-col overflow-clip bg-background">
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-4 py-2 md:grid md:h-14 md:grid-cols-3 md:py-0">
          <div className="flex min-w-0 items-center gap-2">
            <SidebarTrigger className="md:hidden" aria-label="Open the menu" />
            {project && (
              <Select
                value={project}
                onValueChange={(v) => void navigate(viewTo(isView(mode) ? mode : 'overview', v))}
              >
                <SelectTrigger className="w-48 max-w-full" aria-label="Project">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {projectList.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          {project ? (
            <ToggleGroup
              type="single"
              variant="outline"
              spacing={0}
              className="order-last w-full md:order-none md:w-auto md:justify-self-center"
              value={isView(mode) ? mode : ''}
              onValueChange={(v) => {
                const next = viewItems.find((item) => item.view === v)

                if (next) {
                  void navigate(viewTo(next.view, project))
                }
              }}
              aria-label="View"
            >
              {viewItems.map((m) => (
                <ToggleGroupItem
                  key={m.view}
                  value={m.view}
                  className="flex-1 font-display md:min-w-24 md:flex-none"
                  aria-label={m.shortcut ? `${m.label}, ${spoken(m.shortcut)}` : m.label}
                >
                  {m.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          ) : (
            <span className="hidden md:block" />
          )}
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

const viewItems: { view: View; label: string; shortcut?: ShortcutId }[] = [
  {
    view: 'overview',
    label: 'Overview',
  },
  {
    view: 'build',
    label: 'Build',
    shortcut: 'build',
  },
  {
    view: 'ship',
    label: 'Ship',
    shortcut: 'ship',
  },
  {
    view: 'observe',
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

function TaskList({ project }: { project: string }) {
  const shown = useTaskRows(project)
  const current = useParams({
    strict: false,
    select: (params) => params.task,
  })
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
                  <Link {...taskTo(project, t.id)}>
                    <StateIcon state={taskStateIcon[t.state]} className="mt-0.5" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex gap-2">
                        <span className="min-w-0 flex-1 truncate">{t.title}</span>
                        <span className="text-xs text-muted-foreground tabular-nums">{t.age}</span>
                      </span>
                      <span className="flex min-w-0 items-center gap-3 text-xs">
                        <span
                          className={cn(
                            'shrink-0',
                            t.state === 'waiting'
                              ? toneText[taskTone[t.state]]
                              : 'text-muted-foreground',
                          )}
                        >
                          {t.reason}
                        </span>
                        {t.detail && (
                          <span className="min-w-0 truncate text-muted-foreground">{t.detail}</span>
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

function ProjectList({ view, project }: { view: View; project: string | null }) {
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
            <Link to="/">
              <LayoutGrid /> All projects
            </Link>
          </SidebarMenuButton>
        </SidebarMenuItem>
        {listed.map((p) => {
          const tone = toneOf(p.id)

          return (
            <SidebarMenuItem key={p.id}>
              <SidebarMenuButton asChild isActive={project === p.id}>
                <Link {...viewTo(view, p.id)}>
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
  const project = useProject()
  const count = useInboxCount(project)

  return (
    <Button asChild variant="ghost" size="sm">
      <Link {...inboxTo(project)} aria-label={`Inbox, ${count} waiting`}>
        <Bell /> <span className="hidden sm:inline">Inbox</span>{' '}
        {count > 0 && <span className={cn('tabular-nums', toneText.warning)}>{count}</span>}
      </Link>
    </Button>
  )
}
