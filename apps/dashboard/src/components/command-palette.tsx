import { useQueries, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useNavigate, useRouterState, type LinkOptions } from '@tanstack/react-router'
import { Copy, Keyboard, Monitor, Moon, Plus, Sun, UserRound, type LucideIcon } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useState } from 'react'
import { toast } from 'sonner'

import { NewProject } from '@/components/new-project'
import { NewService } from '@/components/new-service'
import { NewSandbox } from '@/components/sandboxes-panel'
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
import type { Environment } from '@/lib/api'
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
import {
  deploymentQuery,
  environmentDeploymentsQuery,
  environmentQuery,
  environmentsQuery,
  projectQuery,
  projectsQuery,
  sandboxesQuery,
  sandboxQuery,
  serviceQuery,
  servicesQuery,
} from '@/lib/queries'
import type { ShortcutId } from '@/lib/shortcuts'

type Here = { page: Page | null; environment: Environment | null }

type Creating =
  | { kind: 'project' }
  | { kind: 'service'; environment: Environment }
  | { kind: 'sandbox'; environment: Environment; project: string }

const nowhere: Here = {
  page: null,
  environment: null,
}

const trail = (client: QueryClient, environmentId: string) => {
  const environment = client.getQueryData(environmentQuery(environmentId).queryKey)
  const project = environment && client.getQueryData(projectQuery(environment.project_id).queryKey)

  return environment && project
    ? {
        environment,
        scope: {
          project: project.name,
          environment: environment.name,
        },
      }
    : null
}

const serviceHere = (client: QueryClient, serviceId: string): Here => {
  const service = client.getQueryData(serviceQuery(serviceId).queryKey)
  const found = service && trail(client, service.environment_id)

  return found
    ? {
        environment: found.environment,
        page: {
          kind: 'service',
          scope: {
            ...found.scope,
            service: service.name,
          },
        },
      }
    : nowhere
}

const locate = (client: QueryClient, routeId: string, params: Record<string, string>): Here => {
  switch (routeId) {
    case '/_app/':
      return {
        environment: null,
        page: {
          kind: 'projects',
        },
      }
    case '/_app/projects/$project/':
      return {
        environment: null,
        page: {
          kind: 'project',
          project: params.project!,
        },
      }

    case '/_app/projects/$project/$environment': {
      const environment = client
        .getQueryData(environmentsQuery(params.project!).queryKey)
        ?.items.find((e) => e.name === params.environment)

      return environment
        ? {
            environment,
            page: {
              kind: 'environment',
              scope: {
                project: params.project!,
                environment: environment.name,
              },
            },
          }
        : nowhere
    }

    case '/_app/services/$service':
      return serviceHere(client, params.service!)

    case '/_app/deployments/$deployment': {
      const deployment = client.getQueryData(deploymentQuery(params.deployment!).queryKey)

      return deployment ? serviceHere(client, deployment.service_id) : nowhere
    }

    case '/_app/sandboxes/$sandbox': {
      const sandbox = client.getQueryData(sandboxQuery(params.sandbox!).queryKey)
      const found = sandbox && trail(client, sandbox.environment_id)

      return found
        ? {
            environment: found.environment,
            page: {
              kind: 'sandbox',
              scope: found.scope,
              sandbox: sandbox.name,
            },
          }
        : nowhere
    }

    default:
      return nowhere
  }
}

function useHere() {
  const client = useQueryClient()
  const match = useRouterState({
    select: (state) => state.matches.at(-1),
  })

  return match ? locate(client, match.routeId, match.params) : nowhere
}

function useDestinations(searching: boolean) {
  const projects = useQuery(projectsQuery)
  const projectItems = projects.data?.items ?? []
  const environments = useQueries({
    queries: projectItems.map((project) => environmentsQuery(project.name)),
  })
  const places = environments.flatMap((query, index) =>
    (query.data?.items ?? []).map((environment) => ({
      project: projectItems[index]!.name,
      environment,
    })),
  )
  const each = <T,>(query: (environment: string) => T) =>
    places.map((place) => ({
      ...query(place.environment.id),
      enabled: searching,
    }))
  const services = useQueries({
    queries: each(servicesQuery),
  })
  const sandboxes = useQueries({
    queries: each(sandboxesQuery),
  })
  const deployments = useQueries({
    queries: each(environmentDeploymentsQuery),
  })
  const pending = [projects, ...environments, ...services, ...sandboxes, ...deployments].some(
    (query) => query.isPending && query.fetchStatus === 'fetching',
  )

  return {
    pending,
    found: destinations(
      projectItems,
      places.map((place, index) => ({
        ...place,
        services: services[index]?.data?.items ?? [],
        sandboxes: sandboxes[index]?.data?.items ?? [],
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

const goTo: { label: string; icon: LucideIcon; link: LinkOptions; shortcut?: ShortcutId }[] = [
  {
    label: 'Sessions',
    icon: entityIcon.session,
    link: {
      to: '/sessions',
    },
    shortcut: 'sessions',
  },
  {
    label: 'Projects',
    icon: entityIcon.project,
    link: {
      to: '/',
    },
    shortcut: 'projects',
  },
  {
    label: 'Staged changes',
    icon: entityIcon.stagedChange,
    link: {
      to: '/staged',
    },
    shortcut: 'staged',
  },
  {
    label: 'Connect an agent',
    icon: entityIcon.agent,
    link: {
      to: '/connect',
    },
    shortcut: 'connect',
  },
  {
    label: 'Stations',
    icon: entityIcon.station,
    link: {
      to: '/stations',
    },
  },
  {
    label: 'Account and sign-in',
    icon: UserRound,
    link: {
      to: '/account',
    },
  },
]

const groups: { heading: string; icon: LucideIcon; key: keyof ReturnType<typeof destinations> }[] =
  [
    {
      heading: 'Projects',
      icon: entityIcon.project,
      key: 'projects',
    },
    {
      heading: 'Environments',
      icon: entityIcon.environment,
      key: 'environments',
    },
    {
      heading: 'Services',
      icon: entityIcon.service,
      key: 'services',
    },
    {
      heading: 'Sandboxes',
      icon: entityIcon.sandbox,
      key: 'sandboxes',
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
  const navigate = useNavigate()
  const { theme, setTheme } = useTheme()
  const here = useHere()
  const searching = search.trim().length > 0
  const { found, pending } = useDestinations(searching)
  const text = here.page && pageText(here.page)
  const project = here.page && pageProject(here.page)
  const run = (action: () => void) => () => {
    close()
    action()
  }
  const go = (link: LinkOptions) => run(() => void navigate(link))
  const copy = (value: string, what: string) =>
    run(() => void navigator.clipboard.writeText(value).then(() => toast.success(`${what} copied`)))
  const environment = here.environment

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
          {goTo.map((entry) => (
            <Item
              key={entry.label}
              value={`go ${entry.label}`}
              icon={entry.icon}
              label={entry.label}
              shortcut={entry.shortcut}
              onSelect={go(entry.link)}
            />
          ))}
        </CommandGroup>
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
                      onSelect={go(entry.link)}
                    />
                  ))}
                </CommandGroup>
              ),
          )}
        <CommandGroup heading="Create">
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
          {environment && project && (
            <>
              <Item
                value="create service"
                icon={Plus}
                label="New service"
                hint={spaceName({
                  project,
                  environment,
                })}
                onSelect={run(() =>
                  onCreate({
                    kind: 'service',
                    environment,
                  }),
                )}
              />
              <Item
                value="create sandbox"
                icon={Plus}
                label="New sandbox"
                hint={spaceName({
                  project,
                  environment,
                })}
                onSelect={run(() =>
                  onCreate({
                    kind: 'sandbox',
                    environment,
                    project,
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
                    environment: null,
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
      {creating?.kind === 'service' && (
        <NewService environment={creating.environment} open onOpenChange={done} />
      )}
      {creating?.kind === 'sandbox' && (
        <NewSandbox
          environment={creating.environment}
          scope={{
            project: creating.project,
            environment: creating.environment.name,
          }}
          open
          onOpenChange={done}
        />
      )}
    </>
  )
}
