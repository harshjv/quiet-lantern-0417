import type { LinkOptions } from '@tanstack/react-router'

import { agentHints } from './agent-hints.ts'
import type { Deployment, Environment, Project, Sandbox, Service } from './api.ts'
import { commands, type Scope, type ServiceScope } from './commands.ts'
import { byName } from './format.ts'

export type Space = {
  project: string
  environment: Pick<Environment, 'id' | 'name'>
  services: readonly Pick<Service, 'id' | 'name'>[]
  sandboxes: readonly Pick<Sandbox, 'id' | 'name'>[]
  deployments: readonly Pick<Deployment, 'id' | 'number' | 'service_id'>[]
}

export type Destination = {
  value: string
  label: string
  hint?: string
  link: LinkOptions
}

export const spaceName = (space: Pick<Space, 'project' | 'environment'>) =>
  `${space.project} / ${space.environment.name}`

const sorted = <T extends { name: string }>(items: readonly T[]) => [...items].sort(byName)

export const destinations = (
  projects: readonly Pick<Project, 'id' | 'name'>[],
  spaces: readonly Space[],
) => ({
  projects: sorted(projects).map((project): Destination => ({
    value: project.id,
    label: project.name,
    link: {
      to: '/projects/$project',
      params: {
        project: project.name,
      },
    },
  })),
  environments: spaces.map((space): Destination => ({
    value: space.environment.id,
    label: spaceName(space),
    link: {
      to: '/projects/$project/$environment',
      params: {
        project: space.project,
        environment: space.environment.name,
      },
    },
  })),
  services: spaces.flatMap((space) =>
    sorted(space.services).map((service): Destination => ({
      value: service.id,
      label: service.name,
      hint: spaceName(space),
      link: {
        to: '/services/$service',
        params: {
          service: service.id,
        },
      },
    })),
  ),
  sandboxes: spaces.flatMap((space) =>
    sorted(space.sandboxes).map((sandbox): Destination => ({
      value: sandbox.id,
      label: sandbox.name,
      hint: spaceName(space),
      link: {
        to: '/sandboxes/$sandbox',
        params: {
          sandbox: sandbox.id,
        },
      },
    })),
  ),
  deployments: spaces.flatMap((space) => {
    const names = new Map(space.services.map((service) => [service.id, service.name]))

    return space.deployments.flatMap((deployment): Destination[] => {
      const service = names.get(deployment.service_id)

      return service
        ? [
            {
              value: deployment.id,
              label: `${service} #${deployment.number}`,
              hint: spaceName(space),
              link: {
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
  | { kind: 'environment'; scope: Scope }
  | { kind: 'service'; scope: ServiceScope }
  | { kind: 'sandbox'; scope: Scope; sandbox: string }

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
        command: commands.createEnvironment(page.project),
      }

    case 'environment': {
      const hint = agentHints['/_app/projects/$project/$environment']

      return {
        command: hint.command(page.scope),
        prompt: hint.prompt(page.scope),
      }
    }

    case 'service': {
      const hint = agentHints['/_app/services/$service']

      return {
        command: hint.command(page.scope),
        prompt: hint.prompt(page.scope),
      }
    }

    case 'sandbox':
      return {
        command: commands.startSandbox(page.scope, page.sandbox),
      }
  }
}
