import type { App, Approval, AppStatus, DeploymentStatus, Machine, MachineStatus } from '@/lib/api'
import {
  approvalStatus,
  appStatus,
  appStatusReason,
  deploymentStatus,
  machineReason,
  machineStatus,
  type Status,
} from '@/lib/labels'
import { isInFlight, isTransient } from '@/lib/status'
import { toneBadge, toneDot } from '@/lib/tone'
import { cn } from '@/lib/utils'

const crossfade = 'motion-safe:transition-colors motion-safe:duration-200'

export function AppStatusDot({ status, className }: { status: AppStatus; className?: string }) {
  return (
    <span className={cn('relative inline-flex size-2 shrink-0', className)} aria-hidden>
      {status === 'deploying' && (
        <span
          className={cn(
            'absolute inline-flex size-full animate-ping rounded-full opacity-60 motion-reduce:hidden',
            toneDot[appStatus[status].tone],
          )}
        />
      )}
      <span
        className={cn(
          'relative inline-flex size-2 rounded-full',
          crossfade,
          toneDot[appStatus[status].tone],
        )}
      />
    </span>
  )
}

export function AppStatus({
  status,
  reason,
}: {
  status: AppStatus
  reason?: App['status_reason']
}) {
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <AppStatusDot status={status} />
      <span>{appStatus[status].label}</span>
      {reason && <span className="text-muted-foreground">{appStatusReason[reason]}</span>}
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

export function Saving() {
  return (
    <span className="inline-flex items-center gap-1.5 text-muted-foreground" role="status">
      {pulse}
      Saving
    </span>
  )
}

export function StatusBadge({ status, busy }: { status: Status; busy?: boolean }) {
  return (
    <span className={cn(badge, crossfade, toneBadge[status.tone])}>
      {busy && pulse}
      <span key={status.label} className="motion-safe:animate-in motion-safe:fade-in-0">
        {status.label}
      </span>
    </span>
  )
}

export function DeploymentStatusBadge({ status }: { status: DeploymentStatus }) {
  return <StatusBadge status={deploymentStatus[status]} busy={isInFlight(status)} />
}

export function ApprovalStatusBadge({ status }: { status: Approval['status'] }) {
  return <StatusBadge status={approvalStatus[status]} />
}

export function MachineStatusBadge({
  status,
  reason,
}: {
  status: MachineStatus
  reason?: Machine['status_reason']
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <StatusBadge status={machineStatus[status]} busy={isTransient(status)} />
      {reason && status !== 'running' && (
        <span className="hidden text-xs text-muted-foreground sm:inline">
          {machineReason[reason]}
        </span>
      )}
    </span>
  )
}
