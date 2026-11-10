import {
  deploymentCancellableStatuses,
  deploymentOpenStatuses,
  sandboxIdleStatuses,
} from '@stationly/protocol/domain'

import type { Deployment, DeploymentStatus, DeploymentStep } from './api'
import { optimistic } from './cache.ts'
import { duration } from './format.ts'
import { deploymentStep } from './labels.ts'

const inFlight = new Set<DeploymentStatus>(deploymentOpenStatuses)

const cancellable = new Set<DeploymentStatus>(deploymentCancellableStatuses)

export const isInFlight = (status: DeploymentStatus) => inFlight.has(status)

export const isTerminal = (status: DeploymentStatus | undefined) =>
  status ? !inFlight.has(status) : false

export const isCancellable = (status: DeploymentStatus) => cancellable.has(status)

const idle = new Set<string>(sandboxIdleStatuses)

const live = new Set<string>(['running', 'starting', 'creating'])

const transient = new Set<string>(['creating', 'starting', 'stopping', 'deleting'])

export const isIdle = (status: string) => idle.has(status)

export const isLive = (status: string) => live.has(status)

export const isTransient = (status: string) => transient.has(status)

export const snapshotsBusy = (items: { status: string }[] | undefined) =>
  items?.some((s) => s.status === 'creating' || s.status === 'deleting') ?? false

export type TriggerType = Deployment['trigger']['type']

export const withQueued = (
  list: Deployment[],
  trigger: TriggerType,
  now = new Date().toISOString(),
): Deployment[] => {
  const latest = list[0]
  if (!latest) return list
  return [
    optimistic({
      id: `queued-${latest.service_id}`,
      service_id: latest.service_id,
      number: Math.max(...list.map((d) => d.number)) + 1,
      status: 'queued',
      trigger: {
        type: trigger,
        source_sha: null,
      },
      strategy: latest.strategy,
      image_ref: null,
      cancel_reason: null,
      started_at: null,
      finished_at: null,
      failure: null,
      created_at: now,
    }),
    ...list,
  ]
}

export const stepProgress = (steps: DeploymentStep[], now = new Date()) => {
  const current = steps.find((s) => s.status === 'running')
  if (!current) return null
  const names = [...new Set(steps.filter((s) => s.status !== 'skipped').map((s) => s.step))]
  return [
    `Step ${names.indexOf(current.step) + 1} of ${names.length}`,
    deploymentStep[current.step],
    duration(current.started_at, null, now),
  ].join(' · ')
}
