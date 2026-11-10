import {
  deploymentCancellableStatuses,
  deploymentOpenStatuses,
  sandboxIdleStatuses,
} from '@stationly/protocol/domain'

import type { DeploymentStatus } from './api'

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
