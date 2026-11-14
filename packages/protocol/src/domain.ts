import type { runStatusValues, sandboxStatusValues } from './model.ts'

type RunStatus = (typeof runStatusValues)[number]

type SandboxStatus = (typeof sandboxStatusValues)[number]

export const slugPattern = '^[a-z0-9][a-z0-9-]{0,62}$'

export const variableKeyPattern = '^[A-Z_][A-Z0-9_]*$'

export const stationStatusValues = ['enrolling', 'online', 'offline', 'asleep'] as const

export const serviceStatusValues = ['green', 'amber', 'red', 'stopped', 'asleep'] as const

export const serviceStatusReasonValues = ['station_asleep', 'gaming_mode', 'schedule'] as const

export const volumeStatusValues = ['active', 'retained', 'destroyed'] as const

export const volumeSnapshotSourceValues = ['tar', 'restic', 'hook'] as const

export const volumeSnapshotTriggerValues = ['manual', 'schedule'] as const

export const volumeSnapshotStatusValues = ['running', 'complete', 'failed', 'expired'] as const

export const domainKindValues = ['generated', 'custom'] as const

export const domainStatusValues = ['pending', 'active', 'error'] as const

export const portAllocationStatusValues = ['active', 'removed'] as const

export const variableScopeValues = ['global', 'project', 'service', 'sandbox'] as const

export const variableKindValues = ['literal', 'reference', 'sealed'] as const

export const grantSourceValues = ['manual', 'attachment'] as const

export const stagedChangeStatusValues = ['staged', 'accepted', 'rejected', 'superseded'] as const

export const stagedChangeSourceValues = [
  'api',
  'manifest',
  'compose_import',
  'agent',
  'ui',
] as const

export const tokenKindValues = ['personal', 'scoped', 'station_enroll', 'oauth'] as const

export const tokenLevelValues = ['read', 'deploy', 'admin'] as const

export const notificationChannelKindValues = ['webhook', 'slack', 'discord', 'email'] as const

export const notificationChannelStatusValues = ['active', 'failing'] as const

export const platformUpgradeStatusValues = [
  'running',
  'reverting',
  'done',
  'failed',
  'reverted',
] as const

export const githubRepositorySelectionValues = ['all', 'selected'] as const

export const repoAuthValues = ['app', 'public'] as const

export const baseImageCheckValues = [
  'current',
  'moved',
  'auth_required',
  'not_found',
  'rate_limited',
  'no_digest',
  'unreachable',
] as const

export const staleReasonCodeValues = ['VARIABLES_CHANGED', 'CONFIG_CHANGED'] as const

export const deploymentTriggerValues = [
  'push',
  'manual',
  'rollback',
  'variable_change',
  'redeploy',
  'base_image',
  'agent',
] as const

export const deploymentInFlightStatuses = [
  'building',
  'pre_deploy',
  'starting',
  'waiting_health',
] as const

export const deploymentCancellableStatuses = ['queued', ...deploymentInFlightStatuses] as const

export const deploymentPastCutoverStatuses = ['cutover', 'draining'] as const

export const deploymentOpenStatuses = [
  ...deploymentCancellableStatuses,
  ...deploymentPastCutoverStatuses,
] as const

export const deploymentTerminalStatuses = ['active', 'failed', 'cancelled', 'superseded'] as const

export const deploymentStatusValues = [
  ...deploymentOpenStatuses,
  ...deploymentTerminalStatuses,
] as const

export const runActiveStatuses = ['queued', 'running'] as const satisfies readonly RunStatus[]

export const runTerminalStatuses = [
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
] as const satisfies readonly RunStatus[]

export const sandboxIdleStatuses = ['stopped', 'failed'] as const satisfies readonly SandboxStatus[]

export const sandboxSteadyStatuses = [
  'running',
  ...sandboxIdleStatuses,
] as const satisfies readonly SandboxStatus[]

export const sandboxSizeDefaults = {
  cpu_millis: 2000,
  memory_bytes: 4294967296,
  disk_bytes: 21474836480,
} as const

export const sandboxMemoryStep = 268435456

export const sandboxMemoryMinimum = 536870912

export const fitSandboxMemory = (
  free: number | null,
  wanted: number = sandboxSizeDefaults.memory_bytes,
) => {
  if (free === null) {
    return wanted
  }

  const fitted = Math.min(wanted, Math.floor(free / sandboxMemoryStep) * sandboxMemoryStep)

  return fitted >= sandboxMemoryMinimum ? fitted : wanted
}
