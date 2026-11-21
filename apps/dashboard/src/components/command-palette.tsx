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
import { newTaskTo, taskTo } from '@/lib/links'
import {
  destinations,
  pageProject,
  pageText,
  rank,
  spaceName,
  type Destination,
  type Page,
  type Ranked,
  type Ranking,
} from '@/lib/palette'
import { scopeOf, type PlaceView } from '@/lib/place'
import {
  appQuery,
  appsQuery,
  deploymentQuery,
  meQuery,
  placeDeploymentsQuery,
  previewsQuery,
  projectsQuery,
  tasksQuery,
} from '@/lib/queries'
import type { ShortcutId } from '@/lib/shortcuts'
import { pages } from '@/workbench/outside'
import { inProject, useProject, viewTo } from '@/workbench/where'

type Here = { page: Page | null; place: PlaceView | null }

type Creating = { kind: 'project' } | { kind: 'app'; place: PlaceView }

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
  project?: string
  preview?: string
}

const locate = (client: QueryClient, params: Params): Here => {
  const { app, deployment, project } = params

  if (app) {
    return appHere(client, app)
  }

  if (deployment) {
    const found = client.getQueryData(deploymentQuery(deployment).queryKey)

    return found ? appHere(client, found.app_id) : nowhere
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
  const deployments = useQueries({
    queries: each(placeDeploymentsQuery),
  })
  const pending = [projects, tasks, ...previews, ...apps, ...deployments].some(
    (query) => query.isPending && query.fetchStatus === 'fetching',
  )

  return {
    pending,
    tasks: (tasks.data?.items ?? []).map((task): Destination => ({
      value: task.id,
      label: task.title,
      hint: task.project.name,
      to: taskTo(task.project.name, task.id),
    })),
    found: destinations(
      projectItems,
      spaces.map((space, index) => ({
        project: space.project,
        preview: space.preview,
        apps: apps[index]?.data?.items ?? [],
        deployments: deployments[index]?.data?.items ?? [],
      })),
    ),
  }
}

type Entry = Ranked & {
  icon: LucideIcon
  shortcut?: ShortcutId
  checked?: boolean
  onSelect: () => void
}

function Item({ entry }: { entry: Entry }) {
  const Icon = entry.icon

  return (
    <CommandItem value={entry.value} data-checked={entry.checked} onSelect={entry.onSelect}>
      <Icon aria-hidden />
      <span className="truncate">{entry.label}</span>
      {entry.hint && <span className="truncate text-muted-foreground">{entry.hint}</span>}
      {entry.shortcut && (
        <CommandShortcut>
          <ShortcutKeys id={entry.shortcut} />
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
    to: inProject((project) => viewTo('build', project)),
    shortcut: 'build',
  },
  {
    label: 'Ship',
    icon: Rocket,
    to: inProject((project) => viewTo('ship', project)),
    shortcut: 'ship',
  },
  {
    label: 'Observe',
    icon: Eye,
    to: inProject((project) => viewTo('observe', project)),
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
  const [moved, setMoved] = useState<{ search: string; top: string; value: string } | null>(null)
  const client = useQueryClient()
  const me = useQuery(meQuery)
  const admin = isInstanceAdmin(me.data?.scopes ?? [])
  const { theme, setTheme } = useTheme()
  const navigate = useNavigate()
  const current = useProject()
  const here = locate(
    client,
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
  const destination =
    (icon: LucideIcon) =>
    (entry: Destination): Entry => ({
      value: entry.value,
      label: entry.label,
      hint: entry.hint,
      icon,
      onSelect: goto(entry.to),
    })
  const sections: Ranking<Entry>[] = [
    {
      heading: 'Go to',
      items: goTo
        .filter((entry) => admin || !entry.admin)
        .map((entry) => ({
          value: `go ${entry.label}`,
          label: entry.label,
          terms: 'go',
          icon: entry.icon,
          shortcut: entry.shortcut,
          onSelect: goto(entry.to(current)),
        })),
    },
    ...(searching
      ? [
          {
            heading: 'Tasks',
            items: tasks.map(destination(ListTodo)),
          },
          ...groups.map((group) => ({
            heading: group.heading,
            items: found[group.key].map(destination(group.icon)),
          })),
        ]
      : []),
    {
      heading: 'Create',
      items: [
        {
          value: 'create task',
          label: 'New task',
          terms: 'create task',
          icon: Plus,
          shortcut: 'newTask',
          onSelect: goto(inProject(newTaskTo)(current)),
        },
        {
          value: 'create project',
          label: 'New project',
          terms: 'create project',
          icon: Plus,
          onSelect: run(() =>
            onCreate({
              kind: 'project',
            }),
          ),
        },
        ...(place && placeHint
          ? [
              {
                value: 'create app',
                label: 'New app',
                hint: placeHint,
                terms: 'create app',
                icon: Plus,
                onSelect: run(() =>
                  onCreate({
                    kind: 'app',
                    place,
                  }),
                ),
              },
            ]
          : []),
      ],
    },
    ...(text
      ? [
          {
            heading: 'Copy for your agent',
            items: [
              {
                value: 'copy command',
                label: 'Copy the sly command for this page',
                terms: 'copy command',
                icon: Copy,
                onSelect: copy(text.command, 'Command'),
              },
              ...(text.prompt
                ? [
                    {
                      value: 'copy prompt',
                      label: 'Copy a prompt for this page',
                      terms: 'copy prompt',
                      icon: Copy,
                      onSelect: copy(text.prompt, 'Prompt'),
                    },
                  ]
                : []),
              ...(project
                ? [
                    {
                      value: 'copy mcp install',
                      label: 'Copy the command that connects Claude Code',
                      hint: project,
                      terms: 'copy mcp install',
                      icon: Copy,
                      onSelect: copy(
                        commands.mcpInstall({
                          client: 'claude-code',
                          project,
                          target: '*',
                          level: 'deploy',
                          ttl: '30d',
                        }),
                        'Command',
                      ),
                    },
                  ]
                : []),
            ],
          },
        ]
      : []),
    {
      heading: 'Preferences',
      items: [
        ...themes.map((entry) => ({
          value: `theme ${entry.value}`,
          label: entry.label,
          terms: `theme ${entry.value}`,
          icon: entry.icon,
          checked: (theme ?? 'system') === entry.value,
          onSelect: run(() => setTheme(entry.value)),
        })),
        {
          value: 'keyboard shortcuts',
          label: 'Keyboard shortcuts',
          terms: 'help',
          icon: Keyboard,
          shortcut: 'help',
          onSelect: run(onHelp),
        },
        {
          value: 'sign out',
          label: 'Sign out',
          icon: LogOut,
          onSelect: run(() => void signOut(client)),
        },
      ],
    },
  ]
  const shown = rank(sections, search)
  const top = shown[0]?.items[0]?.value ?? ''
  const selected = moved && moved.search === search && moved.top === top ? moved.value : top

  return (
    <Command
      loop
      shouldFilter={false}
      value={selected}
      onValueChange={(value) =>
        setMoved({
          search,
          top,
          value,
        })
      }
    >
      <CommandInput
        value={search}
        onValueChange={setSearch}
        placeholder="Search or run a command"
        aria-label="Search or run a command"
      />
      <CommandList className="max-h-[min(26rem,60dvh)]">
        <CommandEmpty>{pending ? 'Loading' : 'Nothing matches that search.'}</CommandEmpty>
        {shown.map((section) => (
          <CommandGroup key={section.heading} heading={section.heading}>
            {section.items.map((entry) => (
              <Item key={entry.value} entry={entry} />
            ))}
          </CommandGroup>
        ))}
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
    </>
  )
}
