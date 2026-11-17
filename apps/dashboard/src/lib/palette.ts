import type { LinkOptions } from '@tanstack/react-router'

import { agentHints } from './agent-hints.ts'
import type { App, Deployment, Machine, Preview, Project } from './api.ts'
import { commands, type AppScope, type Scope } from './commands.ts'
import { byName } from './format.ts'
import { placeTo } from './links.ts'

export type Space = {
  project: string
  preview: Pick<Preview, 'id' | 'name'> | null
  apps: readonly Pick<App, 'id' | 'name'>[]
  machines: readonly Pick<Machine, 'id' | 'name'>[]
  deployments: readonly Pick<Deployment, 'id' | 'number' | 'app_id'>[]
}

export type Destination = {
  value: string
  label: string
  hint?: string
  to: LinkOptions
}

export const spaceName = (space: Pick<Space, 'project' | 'preview'>) =>
  `${space.project} / ${space.preview?.name ?? 'production'}`

const sorted = <T extends { name: string }>(items: readonly T[]) => [...items].sort(byName)

export const destinations = (
  projects: readonly Pick<Project, 'id' | 'name'>[],
  spaces: readonly Space[],
) => ({
  projects: sorted(projects).map((project): Destination => ({
    value: project.id,
    label: project.name,
    to: placeTo(project.name, null),
  })),
  places: spaces.map((space): Destination => ({
    value: space.preview?.id ?? `${space.project}/production`,
    label: spaceName(space),
    to: placeTo(space.project, space.preview?.name ?? null),
  })),
  apps: spaces.flatMap((space) =>
    sorted(space.apps).map((app): Destination => ({
      value: app.id,
      label: app.name,
      hint: spaceName(space),
      to: {
        to: '/apps/$app/{-$tab}',
        params: {
          app: app.id,
        },
      },
    })),
  ),
  machines: spaces.flatMap((space) =>
    sorted(space.machines).map((machine): Destination => ({
      value: machine.id,
      label: machine.name,
      hint: spaceName(space),
      to: {
        to: '/machines/$machine/{-$tab}',
        params: {
          machine: machine.id,
        },
      },
    })),
  ),
  deployments: spaces.flatMap((space) => {
    const names = new Map(space.apps.map((app) => [app.id, app.name]))

    return space.deployments.flatMap((deployment): Destination[] => {
      const app = names.get(deployment.app_id)

      return app
        ? [
            {
              value: deployment.id,
              label: `${app} #${deployment.number}`,
              hint: spaceName(space),
              to: {
                to: '/deployments/$deployment',
                params: {
                  deployment: deployment.id,
                },
              },
            },
          ]
        : []
    })
  }),
})

export type Page =
  | { kind: 'projects' }
  | { kind: 'project'; project: string }
  | { kind: 'place'; scope: Scope }
  | { kind: 'app'; scope: AppScope }
  | { kind: 'machine'; scope: Scope; machine: string }

export const pageProject = (page: Page) =>
  page.kind === 'project' ? page.project : 'scope' in page ? page.scope.project : null

export type PageText = { command: string; prompt?: string }

export const pageText = (page: Page): PageText => {
  switch (page.kind) {
    case 'projects':
      return {
        command: commands.createProject(),
      }
    case 'project':
      return {
        command: commands.createPreview(page.project),
      }

    case 'place': {
      const hint = agentHints[page.scope.preview ? 'preview' : 'production']

      return {
        command: hint.command(page.scope),
        prompt: hint.prompt(page.scope),
      }
    }

    case 'app': {
      const hint = agentHints.app

      return {
        command: hint.command(page.scope),
        prompt: hint.prompt(page.scope),
      }
    }

    case 'machine':
      return {
        command: commands.startMachine(page.scope, page.machine),
      }
  }
}
