import { useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useNavigate, useParams, type LinkOptions } from '@tanstack/react-router'
import {
  Blocks,
  Copy,
  Eye,
  Keyboard,
  ListTodo,
  LogOut,
  Monitor,
  Moon,
  Plus,
  Rocket,
  Sun,
  type LucideIcon,
} from 'lucide-react'
import { useTheme } from 'next-themes'
import { useState } from 'react'
import { toast } from 'sonner'

import { NewProject } from '@/components/new-project'
import { NewApp } from '@/components/new-service'
import { NewMachine } from '@/components/sandboxes-panel'
import { ShortcutKeys } from '@/components/shortcut-keys'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command'
import { isInstanceAdmin } from '@/lib/agent-session'
import { signOut } from '@/lib/auth'
import { commands } from '@/lib/commands'
import { entityIcon } from '@/lib/icons'
import {
  destinations,
  pageProject,
  pageText,
  spaceName,
  type Destination,
  type Page,
} from '@/lib/palette'
import { scopeOf, type PlaceView } from '@/lib/place'
import {
  appQuery,
  appsQuery,
  deploymentQuery,
  machineQuery,
  machinesQuery,
  meQuery,
  placeDeploymentsQuery,
  previewsQuery,
  projectsQuery,
  tasksQuery,
} from '@/lib/queries'
import type { ShortcutId } from '@/lib/shortcuts'
import { pages } from '@/workbench/outside'
import { modeHome, useMode, useProject, type Mode } from '@/workbench/where'

type Here = { page: Page | null; place: PlaceView | null }

type Creating =
  { kind: 'project' } | { kind: 'app'; place: PlaceView } | { kind: 'machine'; place: PlaceView }

const nowhere: Here = {
  page: null,
  place: null,
}

const projectWhere = (client: QueryClient, match: (p: { id: string; name: string }) => boolean) =>
  client.getQueryData(projectsQuery.queryKey)?.items.find(match)

const placeView = (
  client: QueryClient,
  project: { id: string; name: string },
  match: ((p: { id: string; name: string }) => boolean) | null,
): PlaceView | null => {
  const preview = match
    ? client.getQueryData(previewsQuery(project.id).queryKey)?.items.find(match)
    : null

  if (match && !preview) {
    return null
  }

  return {
    project: project.id,
    preview: preview?.id ?? null,
    projectName: project.name,
    previewName: preview?.name ?? null,
  }
}

const trail = (client: QueryClient, row: { project_id: string; preview_id: string | null }) => {
  const project = projectWhere(client, (p) => p.id === row.project_id)
  const place =
    project && placeView(client, project, row.preview_id ? (p) => p.id === row.preview_id : null)

  return place
    ? {
        place,
        scope: scopeOf(place),
      }
    : null
}

const appHere = (client: QueryClient, appId: string): Here => {
  const app = client.getQueryData(appQuery(appId).queryKey)
  const found = app && trail(client, app)

  return found
    ? {
        place: found.place,
        page: {
          kind: 'app',
          scope: {
            ...found.scope,
            app: app.name,
          },
        },
      }
    : nowhere
}

const machineHere = (client: QueryClient, machineId: string): Here => {
  const machine = client.getQueryData(machineQuery(machineId).queryKey)
  const found = machine && trail(client, machine)

  return found
    ? {
        place: found.place,
        page: {
          kind: 'machine',
          scope: found.scope,
          machine: machine.name,
        },
      }
    : nowhere
}

const projectHere = (client: QueryClient, name: string, previewName: string | null): Here => {
  const project = projectWhere(client, (p) => p.name === name)
  const place =
    project && placeView(client, project, previewName ? (p) => p.name === previewName : null)

  return place
    ? {
        place,
        page: {
          kind: 'place',
          scope: scopeOf(place),
        },
      }
    : nowhere
}

type Params = {
  app?: string
  deployment?: string
  machine?: string
  project?: string
  preview?: string
}

const locate = (client: QueryClient, mode: Mode, params: Params): Here => {
  if (mode !== 'ship') {
    return nowhere
  }

  const { app, deployment, machine, project } = params

  if (app) {
    return appHere(client, app)
  }

  if (deployment) {
    const found = client.getQueryData(deploymentQuery(deployment).queryKey)

    return found ? appHere(client, found.app_id) : nowhere
  }

  if (machine) {
    return machineHere(client, machine)
  }

  if (project) {
    return projectHere(client, project, params.preview ?? null)
  }

  return {
    place: null,
    page: {
      kind: 'projects',
    },
  }
}

function useDestinations(searching: boolean) {
  const projects = useQuery(projectsQuery)
  const tasks = useQuery({
    ...tasksQuery,
    enabled: searching,
  })
  const projectItems = projects.data?.items ?? []
  const previews = useQueries({
    queries: projectItems.map((project) => previewsQuery(project.id)),
  })
  const spaces = projectItems.flatMap((project, index) => [
    {
      project: project.name,
      place: {
        project: project.id,
        preview: null,
      },
      preview: null,
    },
    ...(previews[index]?.data?.items ?? []).map((preview) => ({
      project: project.name,
      place: {
        project: project.id,
        preview: preview.id,
      },
      preview,
    })),
  ])
  const each = <T,>(query: (place: (typeof spaces)[number]['place']) => T) =>
    spaces.map((space) => ({
      ...query(space.place),
      enabled: searching,
    }))
  const apps = useQueries({
    queries: each(appsQuery),
  })
  const machines = useQueries({
    queries: each(machinesQuery),
  })
  const deployments = useQueries({
    queries: each(placeDeploymentsQuery),
  })
  const pending = [projects, tasks, ...previews, ...apps, ...machines, ...deployments].some(
    (query) => query.isPending && query.fetchStatus === 'fetching',
  )

  return {
    pending,
    tasks: (tasks.data?.items ?? []).map((task): Destination => ({
      value: task.id,
      label: task.title,
      hint: task.project.name,
      to: {
        to: '/build/$task',
        params: {
          task: task.id,
        },
      },
    })),
    found: destinations(
      projectItems,
      spaces.map((space, index) => ({
        project: space.project,
        preview: space.preview,
        apps: apps[index]?.data?.items ?? [],
        machines: machines[index]?.data?.items ?? [],
        deployments: deployments[index]?.data?.items ?? [],
      })),
    ),
  }
}

function Item({
  value,
  icon: Icon,
  label,
  hint,
  shortcut,
  checked,
  onSelect,
}: {
  value: string
  icon: LucideIcon
  label: string
  hint?: string
  shortcut?: ShortcutId
  checked?: boolean
  onSelect: () => void
}) {
  return (
    <CommandItem
      value={value}
      keywords={hint ? [label, hint] : [label]}
      data-checked={checked}
      onSelect={onSelect}
    >
      <Icon aria-hidden />
      <span className="truncate">{label}</span>
      {hint && <span className="truncate text-muted-foreground">{hint}</span>}
      {shortcut && (
        <CommandShortcut>
          <ShortcutKeys id={shortcut} />
        </CommandShortcut>
      )}
    </CommandItem>
  )
}

type GoTo = {
  label: string
  icon: LucideIcon
  to: (project: string | null) => LinkOptions
  shortcut?: ShortcutId
  admin?: boolean
}

const modeGoTo: GoTo[] = [
  {
    label: 'Build',
    icon: Blocks,
    to: (project) => modeHome('build', project),
    shortcut: 'build',
  },
  {
    label: 'Ship',
    icon: Rocket,
    to: (project) => modeHome('ship', project),
    shortcut: 'ship',
  },
  {
    label: 'Observe',
    icon: Eye,
    to: (project) => modeHome('observe', project),
    shortcut: 'observe',
  },
]

const pageShortcut: Partial<Record<(typeof pages)[number]['id'], ShortcutId>> = {
  inbox: 'inbox',
  account: 'account',
  team: 'team',
  servers: 'servers',
  connect: 'connect',
}

const goTo: GoTo[] = [
  ...modeGoTo,
  ...pages.map((p): GoTo => ({
    label: p.title,
    icon: p.icon,
    to: () => ({
      to: p.to,
    }),
    shortcut: pageShortcut[p.id],
    admin: p.admin,
  })),
]

const groups: { heading: string; icon: LucideIcon; key: keyof ReturnType<typeof destinations> }[] =
  [
    {
      heading: 'Projects',
      icon: entityIcon.project,
      key: 'projects',
    },
    {
      heading: 'Production and previews',
      icon: entityIcon.preview,
      key: 'places',
    },
    {
      heading: 'Apps',
      icon: entityIcon.app,
      key: 'apps',
    },
    {
      heading: 'Machines',
      icon: entityIcon.machine,
      key: 'machines',
    },
    {
      heading: 'Recent deployments',
      icon: entityIcon.deployment,
      key: 'deployments',
    },
  ]

const themes = [
  {
    value: 'light',
    label: 'Light theme',
    icon: Sun,
  },
  {
    value: 'dark',
    label: 'Dark theme',
    icon: Moon,
  },
  {
    value: 'system',
    label: 'Match the system theme',
    icon: Monitor,
  },
]

function PaletteContent({
  close,
  onCreate,
  onHelp,
}: {
  close: () => void
  onCreate: (creating: Creating) => void
  onHelp: () => void
}) {
  const [search, setSearch] = useState('')
  const client = useQueryClient()
  const me = useQuery(meQuery)
  const admin = isInstanceAdmin(me.data?.scopes ?? [])
  const { theme, setTheme } = useTheme()
  const navigate = useNavigate()
  const current = useProject()
  const here = locate(
    client,
    useMode(),
    useParams({
      strict: false,
    }),
  )
  const searching = search.trim().length > 0
  const { found, tasks, pending } = useDestinations(searching)
  const text = here.page && pageText(here.page)
  const project = here.page && pageProject(here.page)
  const run = (action: () => void) => () => {
    close()
    action()
  }
  const goto = (to: LinkOptions) => run(() => void navigate(to))
  const copy = (value: string, what: string) =>
    run(() => void navigator.clipboard.writeText(value).then(() => toast.success(`${what} copied`)))
  const place = here.place
  const placeHint =
    place &&
    project &&
    spaceName({
      project,
      preview: place.previewName
        ? {
            id: place.preview!,
            name: place.previewName,
          }
        : null,
    })

  return (
    <Command loop>
      <CommandInput
        value={search}
        onValueChange={setSearch}
        placeholder="Search or run a command"
        aria-label="Search or run a command"
      />
      <CommandList className="max-h-[min(26rem,60dvh)]">
        <CommandEmpty>{pending ? 'Loading' : 'Nothing matches that search.'}</CommandEmpty>
        <CommandGroup heading="Go to">
          {goTo
            .filter((entry) => admin || !entry.admin)
            .map((entry) => (
              <Item
                key={entry.label}
                value={`go ${entry.label}`}
                icon={entry.icon}
                label={entry.label}
                shortcut={entry.shortcut}
                onSelect={goto(entry.to(current))}
              />
            ))}
        </CommandGroup>
        {searching && tasks.length > 0 && (
          <CommandGroup heading="Tasks">
            {tasks.map((entry) => (
              <Item
                key={entry.value}
                value={entry.value}
                icon={ListTodo}
                label={entry.label}
                hint={entry.hint}
                onSelect={goto(entry.to)}
              />
            ))}
          </CommandGroup>
        )}
        {searching &&
          groups.map(
            (group) =>
              found[group.key].length > 0 && (
                <CommandGroup key={group.key} heading={group.heading}>
                  {found[group.key].map((entry: Destination) => (
                    <Item
                      key={entry.value}
                      value={entry.value}
                      icon={group.icon}
                      label={entry.label}
                      hint={entry.hint}
                      onSelect={goto(entry.to)}
                    />
                  ))}
                </CommandGroup>
              ),
          )}
        <CommandGroup heading="Create">
          <Item
            value="create task"
            icon={Plus}
            label="New task"
            shortcut="newTask"
            onSelect={goto({
              to: '/build/new',
              search: {
                project: current ?? undefined,
              },
            })}
          />
          <Item
            value="create project"
            icon={Plus}
            label="New project"
            onSelect={run(() =>
              onCreate({
                kind: 'project',
              }),
            )}
          />
          {place && placeHint && (
            <>
              <Item
                value="create app"
                icon={Plus}
                label="New app"
                hint={placeHint}
                onSelect={run(() =>
                  onCreate({
                    kind: 'app',
                    place,
                  }),
                )}
              />
              <Item
                value="create machine"
                icon={Plus}
                label="New machine"
                hint={placeHint}
                onSelect={run(() =>
                  onCreate({
                    kind: 'machine',
                    place,
                  }),
                )}
              />
            </>
          )}
        </CommandGroup>
        {text && (
          <CommandGroup heading="Copy for your agent">
            <Item
              value="copy command"
              icon={Copy}
              label="Copy the sly command for this page"
              onSelect={copy(text.command, 'Command')}
            />
            {text.prompt && (
              <Item
                value="copy prompt"
                icon={Copy}
                label="Copy a prompt for this page"
                onSelect={copy(text.prompt, 'Prompt')}
              />
            )}
            {project && (
              <Item
                value="copy mcp install"
                icon={Copy}
                label="Copy the command that connects Claude Code"
                hint={project}
                onSelect={copy(
                  commands.mcpInstall({
                    client: 'claude-code',
                    project,
                    target: '*',
                    level: 'deploy',
                    ttl: '30d',
                  }),
                  'Command',
                )}
              />
            )}
          </CommandGroup>
        )}
        <CommandGroup heading="Preferences">
          {themes.map((entry) => (
            <Item
              key={entry.value}
              value={`theme ${entry.value}`}
              icon={entry.icon}
              label={entry.label}
              checked={(theme ?? 'system') === entry.value}
              onSelect={run(() => setTheme(entry.value))}
            />
          ))}
          <Item
            value="keyboard shortcuts"
            icon={Keyboard}
            label="Keyboard shortcuts"
            shortcut="help"
            onSelect={run(onHelp)}
          />
          <Item
            value="sign out"
            icon={LogOut}
            label="Sign out"
            onSelect={run(() => void signOut(client))}
          />
        </CommandGroup>
      </CommandList>
    </Command>
  )
}

export function CommandPalette({
  open,
  onOpenChange,
  onHelp,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onHelp: () => void
}) {
  const [creating, setCreating] = useState<Creating | null>(null)
  const done = (next: boolean) => {
    if (!next) {
      setCreating(null)
    }
  }

  return (
    <>
      <CommandDialog
        open={open}
        onOpenChange={onOpenChange}
        title="Command palette"
        className="sm:max-w-xl"
        description="Search for a page, or run a command."
      >
        <PaletteContent close={() => onOpenChange(false)} onCreate={setCreating} onHelp={onHelp} />
      </CommandDialog>
      {creating?.kind === 'project' && <NewProject open onOpenChange={done} />}
      {creating?.kind === 'app' && <NewApp place={creating.place} open onOpenChange={done} />}
      {creating?.kind === 'machine' && (
        <NewMachine place={creating.place} open onOpenChange={done} />
      )}
    </>
  )
}
