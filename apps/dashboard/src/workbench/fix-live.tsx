import { useQuery } from '@tanstack/react-query'

import type { App, Diagnosis } from '@/lib/api'
import { appStatus } from '@/lib/labels'
import {
  appQuery,
  deploymentQuery,
  diagnosisQuery,
  previewQueryOf,
  projectsQuery,
} from '@/lib/queries'

export type FixTarget = { kind: 'deployment' | 'app'; id: string }

export const fixTarget = (value: string | null): FixTarget | null => {
  const [kind, id] = (value ?? '').split(':')

  return (kind === 'deployment' || kind === 'app') && id
    ? {
        kind,
        id,
      }
    : null
}

export const repositoryOf = (app: Pick<App, 'source'>) => {
  const source = app.source as { repo?: string }

  if (!source.repo) {
    return null
  }

  return source.repo.startsWith('http') ? source.repo : `https://${source.repo}`
}

export const fixPrompt = (options: {
  app: string
  project: string
  preview: string | null
  diagnosis: Diagnosis | null
  number: number | null
  status: App['status']
}) => {
  const where = `${options.app} in ${options.project}/${options.preview ?? 'production'} on Stationly`
  const failedStep = options.diagnosis?.events?.find((event) => event.status === 'failed')?.step
  const lines = [
    options.diagnosis
      ? `The deployment${options.number === null ? '' : ` #${options.number}`} of ${where} failed: ${options.diagnosis.summary}`
      : `The app ${where} is ${appStatus[options.status].label.toLowerCase()}.`,
    ...(failedStep ? [`It failed at the ${failedStep} step.`] : []),
    ...(options.diagnosis?.fixes?.length
      ? ['Stationly suggests:', ...options.diagnosis.fixes.map((fix) => `- ${fix.text}`)]
      : []),
    'Find the cause in this repository, fix it on this branch, run what checks you can, and say what you changed. Do not deploy.',
  ]

  return lines.join('\n')
}

export const useFixPrefill = (target: FixTarget | null) => {
  const deployment = useQuery({
    ...deploymentQuery(target?.id ?? ''),
    enabled: target?.kind === 'deployment',
  })
  const appId =
    target?.kind === 'app'
      ? target.id
      : ((deployment.data as { app_id?: string } | undefined)?.app_id ?? '')
  const app = useQuery({
    ...appQuery(appId),
    enabled: Boolean(appId),
  })
  const diagnosis = useQuery({
    ...diagnosisQuery(target?.id ?? ''),
    enabled: target?.kind === 'deployment' && deployment.data?.status === 'failed',
  })
  const preview = useQuery({
    ...previewQueryOf(app.data?.preview_id ?? ''),
    enabled: Boolean(app.data?.preview_id),
  })
  const projects = useQuery(projectsQuery)

  if (
    !target ||
    !app.data ||
    (app.data.preview_id !== null && !preview.data) ||
    (target.kind === 'deployment' && !deployment.data)
  ) {
    return null
  }

  const project = projects.data?.items.find((p) => p.id === app.data.project_id)

  return {
    project: project?.name ?? null,
    repository: repositoryOf(app.data),
    prompt: fixPrompt({
      app: app.data.name,
      project: project?.name ?? 'its project',
      preview: preview.data?.name ?? null,
      diagnosis: diagnosis.data ?? null,
      number: deployment.data?.number ?? null,
      status: app.data.status,
    }),
  }
}
