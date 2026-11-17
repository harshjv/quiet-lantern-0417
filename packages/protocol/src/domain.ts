import type { machineStatusValues, runStatusValues } from './model.ts'

type RunStatus = (typeof runStatusValues)[number]

type MachineStatus = (typeof machineStatusValues)[number]

export const slugPattern = '^[a-z0-9][a-z0-9-]{0,62}$'

export const keyNamePattern = '^[A-Z_][A-Z0-9_]*$'

export const serverStatusValues = ['enrolling', 'online', 'offline', 'asleep'] as const

export const appStatusValues = [
  'healthy',
  'deploying',
  'failing',
  'stopped',
  'asleep',
  'not_deployed',
] as const

export const appStatusReasonValues = ['server_asleep', 'gaming_mode', 'schedule'] as const

export const volumeStatusValues = ['active', 'retained', 'destroyed'] as const

export const volumeSnapshotSourceValues = ['tar', 'restic', 'hook'] as const

export const volumeSnapshotTriggerValues = ['manual', 'schedule'] as const

export const volumeSnapshotStatusValues = ['running', 'complete', 'failed', 'expired'] as const

export const domainKindValues = ['generated', 'custom'] as const

export const domainStatusValues = ['pending', 'active', 'error'] as const

export const portAllocationStatusValues = ['active', 'removed'] as const

export const keyScopeValues = ['global', 'project', 'app', 'machine'] as const

export const keyKindValues = ['literal', 'reference', 'sealed'] as const

export const targetKindValues = ['production', 'preview'] as const

export const scopeTargetValues = ['production', 'previews', '*'] as const

export const grantSourceValues = ['manual', 'attachment'] as const

export const approvalStatusValues = ['waiting', 'approved', 'rejected', 'superseded'] as const

export const approvalSourceValues = ['api', 'manifest', 'compose_import', 'task', 'ui'] as const

export const tokenKindValues = ['personal', 'scoped', 'server_enroll', 'oauth'] as const

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

export const staleReasonCodeValues = ['KEYS_CHANGED', 'CONFIG_CHANGED'] as const

export const deploymentTriggerValues = [
  'push',
  'manual',
  'rollback',
  'key_change',
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

export const machineIdleStatuses = ['stopped', 'failed'] as const satisfies readonly MachineStatus[]

export const machineSteadyStatuses = [
  'running',
  ...machineIdleStatuses,
] as const satisfies readonly MachineStatus[]

export const machineSizeDefaults = {
  cpu_millis: 2000,
  memory_bytes: 4294967296,
  disk_bytes: 21474836480,
} as const

export const machineMemoryStep = 268435456

export const machineMemoryMinimum = 536870912

export const fitMachineMemory = (
  free: number | null,
  wanted: number = machineSizeDefaults.memory_bytes,
) => {
  if (free === null) {
    return wanted
  }

  const fitted = Math.min(wanted, Math.floor(free / machineMemoryStep) * machineMemoryStep)

  return fitted >= machineMemoryMinimum ? fitted : wanted
}
