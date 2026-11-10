import type {
  DeploymentStatus,
  Sandbox,
  SandboxStatus,
  Service,
  ServiceStatus,
  StagedChange,
} from '@/lib/api'
import {
  deploymentStatus,
  sandboxReason,
  sandboxStatus,
  serviceStatus,
  serviceStatusReason,
  stagedStatus,
  type Status,
} from '@/lib/labels'
import { isInFlight, isTransient } from '@/lib/status'
import { toneBadge, toneDot } from '@/lib/tone'
import { cn } from '@/lib/utils'

export function ServiceStatusDot({
  status,
  className,
}: {
  status: ServiceStatus
  className?: string
}) {
  return (
    <span className={cn('relative inline-flex size-2 shrink-0', className)} aria-hidden>
      {status === 'amber' && (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-amber-400 opacity-60 motion-reduce:hidden" />
      )}
      <span
        className={cn(
          'relative inline-flex size-2 rounded-full',
          toneDot[serviceStatus[status].tone],
        )}
      />
    </span>
  )
}

export function ServiceStatus({
  status,
  reason,
}: {
  status: ServiceStatus
  reason?: Service['status_reason']
}) {
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <ServiceStatusDot status={status} />
      <span>{serviceStatus[status].label}</span>
      {reason && <span className="text-muted-foreground">{serviceStatusReason[reason]}</span>}
    </span>
  )
}

const badge =
  'inline-flex h-5 w-fit items-center gap-1.5 rounded-md border px-1.5 text-xs font-medium whitespace-nowrap'

const pulse = (
  <span
    className="size-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none"
    aria-hidden
  />
)

export function StatusBadge({ status, busy }: { status: Status; busy?: boolean }) {
  return (
    <span className={cn(badge, toneBadge[status.tone])}>
      {busy && pulse}
      {status.label}
    </span>
  )
}

export function DeploymentStatusBadge({ status }: { status: DeploymentStatus }) {
  return <StatusBadge status={deploymentStatus[status]} busy={isInFlight(status)} />
}

export function StagedStatusBadge({ status }: { status: StagedChange['status'] }) {
  return <StatusBadge status={stagedStatus[status]} />
}

export function SandboxStatusBadge({
  status,
  reason,
}: {
  status: SandboxStatus
  reason?: Sandbox['status_reason']
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <StatusBadge status={sandboxStatus[status]} busy={isTransient(status)} />
      {reason && status !== 'running' && (
        <span className="hidden text-xs text-muted-foreground sm:inline">
          {sandboxReason[reason]}
        </span>
      )}
    </span>
  )
}
