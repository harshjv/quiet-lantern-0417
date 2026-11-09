import { cn } from '@/lib/utils'
import type { DeploymentStatus, SandboxStatus, ServiceStatus } from '@/lib/api'

const serviceTone: Record<ServiceStatus, string> = {
  green: 'bg-emerald-500',
  amber: 'bg-amber-500',
  red: 'bg-red-500',
  stopped: 'bg-zinc-400 dark:bg-zinc-500',
  asleep: 'bg-sky-500'
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
      <span className={cn('relative inline-flex size-2 rounded-full', serviceTone[status])} />
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

const deploymentTone: Record<DeploymentStatus, string> = {
  queued: 'border-zinc-300 text-zinc-700 dark:border-zinc-700 dark:text-zinc-300',
  building: 'border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200',
  pre_deploy: 'border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200',
  starting: 'border-sky-300 bg-sky-50 text-sky-800 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200',
  waiting_health: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200',
  cutover: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200',
  draining: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200',
  active: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  failed: 'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200',
  cancelled: 'border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400',
  superseded: 'border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400'
}

const inFlight = new Set<DeploymentStatus>(['queued', 'building', 'pre_deploy', 'starting', 'waiting_health', 'cutover', 'draining'])

export function DeploymentStatusBadge({ status }: { status: DeploymentStatus }) {
  return (
    <span className={cn('inline-flex h-5 w-fit items-center gap-1.5 rounded-md border px-1.5 text-xs font-medium whitespace-nowrap', deploymentTone[status])}>
      {inFlight.has(status) && <span className="size-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none" aria-hidden />}
      {status.replaceAll('_', ' ')}
    </span>
  )
}

const stagedTone: Record<string, string> = {
  staged: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200',
  accepted: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  rejected: 'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200',
  superseded: 'border-zinc-300 text-zinc-600 dark:border-zinc-700 dark:text-zinc-400'
}

export function StagedStatusBadge({ status }: { status: string }) {
  return <span className={cn('inline-flex h-5 w-fit items-center rounded-md border px-1.5 text-xs font-medium', stagedTone[status] ?? stagedTone.superseded)}>{status}</span>
}

const sandboxTone: Record<SandboxStatus, string> = {
  creating: deploymentTone.starting,
  starting: deploymentTone.starting,
  running: deploymentTone.active,
  stopping: deploymentTone.waiting_health,
  stopped: deploymentTone.cancelled,
  failed: deploymentTone.failed,
  deleting: deploymentTone.waiting_health
}

const sandboxTransient = new Set<SandboxStatus>(['creating', 'starting', 'stopping', 'deleting'])

export function SandboxStatusBadge({ status, reason }: { status: SandboxStatus; reason?: string | null }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('inline-flex h-5 w-fit items-center gap-1.5 rounded-md border px-1.5 text-xs font-medium whitespace-nowrap', sandboxTone[status])}>
        {sandboxTransient.has(status) && <span className="size-1.5 animate-pulse rounded-full bg-current motion-reduce:animate-none" aria-hidden />}
        {status}
      </span>
      {reason && status !== 'running' && <span className="hidden text-xs text-muted-foreground sm:inline">{reason.replaceAll('_', ' ')}</span>}
    </span>
  )
}
