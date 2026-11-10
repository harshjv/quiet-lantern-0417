import { cn } from '@/lib/utils'
import type { DeploymentStatus, SandboxStatus, ServiceStatus } from '@/lib/api'
import { isInFlight, isTransient } from '@/lib/status'
import { toneBadge, toneDot, type Tone } from '@/lib/tone'

const serviceTone: Record<ServiceStatus, Tone> = {
  green: 'success',
  amber: 'warning',
  red: 'danger',
  stopped: 'neutral',
  asleep: 'info'
}

const serviceLabel: Record<ServiceStatus, string> = {
  green: 'Healthy',
  amber: 'Degraded',
  red: 'Failing',
  stopped: 'Stopped',
  asleep: 'Asleep'
}

export function ServiceStatusDot({ status, className }: { status: ServiceStatus; className?: string }) {
  return (
    <span className={cn('relative inline-flex size-2 shrink-0', className)} aria-hidden>
      {status === 'amber' && <span className="absolute inline-flex size-full animate-ping rounded-full bg-amber-400 opacity-60 motion-reduce:hidden" />}
      <span className={cn('relative inline-flex size-2 rounded-full', toneDot[serviceTone[status]])} />
    </span>
  )
}

export function ServiceStatus({ status, reason }: { status: ServiceStatus; reason?: string | null }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <ServiceStatusDot status={status} />
      <span>{serviceLabel[status]}</span>
      {reason && <span className="text-muted-foreground">({reason.replaceAll('_', ' ')})</span>}
    </span>
  )
}

const deploymentTone: Record<DeploymentStatus, Tone> = {
  queued: 'neutral',
  building: 'info',
  pre_deploy: 'info',
  starting: 'info',
  waiting_health: 'warning',
  cutover: 'warning',
  draining: 'warning',
  active: 'success',
  failed: 'danger',
  cancelled: 'neutral',
  superseded: 'neutral'
}

const badge = 'inline-flex h-5 w-fit items-center gap-1.5 rounded-md border px-1.5 text-xs font-medium whitespace-nowrap'

const pulse = <span className="size-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none" aria-hidden />

export function DeploymentStatusBadge({ status }: { status: DeploymentStatus }) {
  return (
    <span className={cn(badge, toneBadge[deploymentTone[status]])}>
      {isInFlight(status) && pulse}
      {status.replaceAll('_', ' ')}
    </span>
  )
}

const stagedTone: Record<string, Tone> = {
  staged: 'warning',
  accepted: 'success',
  rejected: 'danger',
  superseded: 'neutral'
}

export function StagedStatusBadge({ status }: { status: string }) {
  return <span className={cn(badge, toneBadge[stagedTone[status] ?? 'neutral'])}>{status}</span>
}

const sandboxTone: Record<SandboxStatus, Tone> = {
  creating: 'info',
  starting: 'info',
  running: 'success',
  stopping: 'warning',
  stopped: 'neutral',
  failed: 'danger',
  deleting: 'warning'
}

export function SandboxStatusBadge({ status, reason }: { status: SandboxStatus; reason?: string | null }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn(badge, toneBadge[sandboxTone[status]])}>
        {isTransient(status) && pulse}
        {status}
      </span>
      {reason && status !== 'running' && <span className="hidden text-xs text-muted-foreground sm:inline">{reason.replaceAll('_', ' ')}</span>}
    </span>
  )
}
