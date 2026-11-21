import type { LinkOptions } from '@tanstack/react-router'
import { defaultFilter } from 'cmdk'

import { agentHints } from './agent-hints.ts'
import type { App, Deployment, Preview, Project } from './api.ts'
import { commands, type AppScope, type Scope } from './commands.ts'
import { byName } from './format.ts'
import { appTo, placeTo } from './links.ts'

export type Space = {
  project: string
  preview: Pick<Preview, 'id' | 'name'> | null
  apps: readonly Pick<App, 'id' | 'name'>[]
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

type Placed = { preview: boolean; entry: Destination }

const placed = (space: Space, entry: Destination): Placed => ({
  preview: space.preview !== null,
  entry,
})

const byLabel = (a: Destination, b: Destination) =>
  a.label.localeCompare(b.label, undefined, {
    numeric: true,
  }) || (a.hint ?? '').localeCompare(b.hint ?? '')

const productionFirst = (items: Placed[], named = true) =>
  [...items]
    .sort(
      (a, b) => Number(a.preview) - Number(b.preview) || (named ? byLabel(a.entry, b.entry) : 0),
    )
    .map((item) => item.entry)

export const destinations = (
  projects: readonly Pick<Project, 'id' | 'name'>[],
  spaces: readonly Space[],
) => ({
  projects: sorted(projects).map((project): Destination => ({
    value: project.id,
    label: project.name,
    to: placeTo(project.name, null),
  })),
  places: productionFirst(
    spaces.map((space) =>
      placed(space, {
        value: space.preview?.id ?? `${space.project}/production`,
        label: spaceName(space),
        to: placeTo(space.project, space.preview?.name ?? null),
      }),
    ),
  ),
  apps: productionFirst(
    spaces.flatMap((space) =>
      space.apps.map((app) =>
        placed(space, {
          value: app.id,
          label: app.name,
          hint: spaceName(space),
          to: appTo(space.project, app.id),
        }),
      ),
    ),
  ),
  deployments: productionFirst(
    spaces.flatMap((space) => {
      const names = new Map(space.apps.map((app) => [app.id, app.name]))

      return space.deployments.flatMap((deployment): Placed[] => {
        const app = names.get(deployment.app_id)

        return app
          ? [
              placed(space, {
                value: deployment.id,
                label: `${app} #${deployment.number}`,
                hint: spaceName(space),
                to: {
                  to: '/deployments/$deployment',
                  params: {
                    deployment: deployment.id,
                  },
                },
              }),
            ]
          : []
      })
    }),
    false,
  ),
})

export type Ranked = { value: string; label: string; hint?: string; terms?: string }

export type Ranking<T extends Ranked> = { heading: string; items: T[] }

export const matchScore = (entry: Ranked, search: string) => {
  const query = search.trim()

  if (!query) {
    return 1
  }

  const score = defaultFilter(
    entry.label,
    query,
    [entry.hint, entry.terms].filter((text): text is string => Boolean(text)),
  )

  return score > 0 && entry.label.toLowerCase() === query.toLowerCase() ? score + 1 : score
}

export const rank = <T extends Ranked>(sections: Ranking<T>[], search: string): Ranking<T>[] =>
  sections
    .map((section) => {
      const scored = section.items
        .map((item) => ({
          item,
          score: matchScore(item, search),
        }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)

      return {
        section: {
          ...section,
          items: scored.map((entry) => entry.item),
        },
        best: scored[0]?.score ?? 0,
      }
    })
    .filter((entry) => entry.section.items.length > 0)
    .sort((a, b) => b.best - a.best)
    .map((entry) => entry.section)

export type Page =
  | { kind: 'projects' }
  | { kind: 'project'; project: string }
  | { kind: 'place'; scope: Scope }
  | { kind: 'app'; scope: AppScope }

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
  }
}
