import type { QueryClient } from '@tanstack/react-query'

import {
  appQuery,
  approvalQuery,
  deploymentQuery,
  machineQuery,
  previewQueryOf,
  projectQuery,
  taskQuery,
} from './queries'
import { placeTitle, titled } from './title'

export type Heading = { title: string[]; project?: string }

type Placed = { project_id: string; preview_id: string | null }

const placed = async (client: QueryClient, row: Placed, name: string): Promise<Heading> => {
  const project = await client.ensureQueryData(projectQuery(row.project_id))
  const preview = row.preview_id
    ? await client.ensureQueryData(previewQueryOf(row.preview_id))
    : null

  return {
    title: [name, placeTitle(project.name, preview?.name ?? null), 'Ship'],
    project: project.name,
  }
}

const settled = (heading: Promise<Heading>) => heading.catch((): Heading | undefined => undefined)

export const appHeading = (client: QueryClient, id: string) =>
  settled(client.ensureQueryData(appQuery(id)).then((app) => placed(client, app, app.name)))

export const deploymentHeading = (client: QueryClient, id: string) =>
  settled(
    client
      .ensureQueryData(deploymentQuery(id))
      .then(async (deployment) =>
        placed(
          client,
          await client.ensureQueryData(appQuery(deployment.app_id)),
          `Deployment #${deployment.number}`,
        ),
      ),
  )

export const machineHeading = (client: QueryClient, id: string) =>
  settled(
    client
      .ensureQueryData(machineQuery(id))
      .then((machine) => placed(client, machine, machine.name)),
  )

export const approvalHeading = (client: QueryClient, id: string) =>
  settled(
    client.ensureQueryData(approvalQuery(id)).then((approval) => ({
      title: [approval.title],
    })),
  )

export const taskHeading = (client: QueryClient, id: string) =>
  settled(
    client.ensureQueryData(taskQuery(id)).then((task) => ({
      title: [task.title, task.project.name, 'Build'],
    })),
  )

export const headOf = (heading: Heading | undefined, ...fallback: string[]) =>
  titled(...(heading?.title ?? fallback))
