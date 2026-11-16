import { useQuery } from '@tanstack/react-query'

import type { Diagnosis, Service } from '@/lib/api'
import {
  deploymentQuery,
  diagnosisQuery,
  environmentQuery,
  projectsQuery,
  serviceQuery,
} from '@/lib/queries'

import { healthText } from './ops-live'

export type FixTarget = { kind: 'deployment' | 'service'; id: string }

export const fixTarget = (value: string | null): FixTarget | null => {
  const [kind, id] = (value ?? '').split(':')

  return (kind === 'deployment' || kind === 'service') && id
    ? {
        kind,
        id,
      }
    : null
}

export const repositoryOf = (service: Pick<Service, 'source'>) => {
  const source = service.source as { repo?: string }

  if (!source.repo) {
    return null
  }

  return source.repo.startsWith('http') ? source.repo : `https://${source.repo}`
}

export const fixPrompt = (options: {
  service: string
  project: string
  environment: string
  diagnosis: Diagnosis | null
  number: number | null
  status: Service['status']
}) => {
  const where = `${options.service} in ${options.project}/${options.environment} on Stationly`
  const failedStep = options.diagnosis?.events?.find((event) => event.status === 'failed')?.step
  const lines = [
    options.diagnosis
      ? `The deployment${options.number === null ? '' : ` #${options.number}`} of ${where} failed: ${options.diagnosis.summary}`
      : `The service ${where} is ${healthText[options.status].toLowerCase()}.`,
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
  const serviceId =
    target?.kind === 'service'
      ? target.id
      : ((deployment.data as { service_id?: string } | undefined)?.service_id ?? '')
  const service = useQuery({
    ...serviceQuery(serviceId),
    enabled: Boolean(serviceId),
  })
  const diagnosis = useQuery({
    ...diagnosisQuery(target?.id ?? ''),
    enabled: target?.kind === 'deployment' && deployment.data?.status === 'failed',
  })
  const environment = useQuery({
    ...environmentQuery(service.data?.environment_id ?? ''),
    enabled: Boolean(service.data?.environment_id),
  })
  const projects = useQuery(projectsQuery)

  if (
    !target ||
    !service.data ||
    !environment.data ||
    (target.kind === 'deployment' && !deployment.data)
  ) {
    return null
  }

  const project = projects.data?.items.find((p) => p.id === environment.data.project_id)

  return {
    project: project?.name ?? null,
    repository: repositoryOf(service.data),
    prompt: fixPrompt({
      service: service.data.name,
      project: project?.name ?? 'its project',
      environment: environment.data.name,
      diagnosis: diagnosis.data ?? null,
      number: deployment.data?.number ?? null,
      status: service.data.status,
    }),
  }
}
