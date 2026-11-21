import {
  machineRuntimeTradeoffs,
  type MachineRuntimeKind,
} from '@stationly/protocol/sandbox-runtime'

import type {
  App,
  Approval,
  AppStatus,
  Deployment,
  DeploymentStatus,
  Diagnosis,
  EnvironmentVariable,
  HostProbe,
  NetworkMap,
} from './api'
import type { Level } from './commands'
import type { Tone } from './tone'

export type Status = { label: string; tone: Tone }

type MapApp = NetworkMap['apps'][number]
type MapDomain = MapApp['domains'][number]

export const appStatus: Record<AppStatus, Status> = {
  healthy: {
    label: 'Healthy',
    tone: 'success',
  },
  deploying: {
    label: 'Deploying',
    tone: 'info',
  },
  failing: {
    label: 'Failing',
    tone: 'danger',
  },
  stopped: {
    label: 'Stopped',
    tone: 'neutral',
  },
  asleep: {
    label: 'Asleep',
    tone: 'violet',
  },
  not_deployed: {
    label: 'Not deployed',
    tone: 'neutral',
  },
}

export const appStatusReason: Record<NonNullable<App['status_reason']>, string> = {
  server_asleep: 'server asleep',
  gaming_mode: 'gaming mode',
  schedule: 'on schedule',
}

export const appKind: Record<App['kind'], string> = {
  web: 'Web',
  worker: 'Worker',
  cron: 'Cron',
  one_off: 'One-off',
}

export const staleReason: Record<NonNullable<App['stale_reasons']>[number]['code'], string> = {
  ENVIRONMENT_VARIABLES_CHANGED: 'Environment variables changed',
  CONFIG_CHANGED: 'Settings changed',
}

export const deploymentStatus: Record<DeploymentStatus, Status> = {
  queued: {
    label: 'Queued',
    tone: 'neutral',
  },
  building: {
    label: 'Building',
    tone: 'info',
  },
  pre_deploy: {
    label: 'Pre-deploy',
    tone: 'info',
  },
  starting: {
    label: 'Starting',
    tone: 'info',
  },
  waiting_health: {
    label: 'Health check',
    tone: 'warning',
  },
  cutover: {
    label: 'Switching traffic',
    tone: 'warning',
  },
  draining: {
    label: 'Retiring old',
    tone: 'warning',
  },
  active: {
    label: 'Active',
    tone: 'success',
  },
  failed: {
    label: 'Failed',
    tone: 'danger',
  },
  cancelled: {
    label: 'Cancelled',
    tone: 'neutral',
  },
  superseded: {
    label: 'Replaced',
    tone: 'neutral',
  },
}

export const deploymentTrigger: Record<Deployment['trigger']['type'], string> = {
  push: 'Git push',
  manual: 'Manual',
  rollback: 'Rollback',
  environment_variable_change: 'Environment variable change',
  redeploy: 'Redeploy',
  base_image: 'Base image update',
  agent: 'Agent',
}

export const deploymentStrategy: Record<Deployment['strategy'], string> = {
  overlap: 'Start new, then stop old',
  replace: 'Stop old, then start new',
}

export const cancelReason: Record<NonNullable<Deployment['cancel_reason']>, string> = {
  user: 'Cancelled by a person',
  superseded: 'Replaced by a newer deployment',
  station_offline: 'The server went offline',
}

type Step = NonNullable<Deployment['steps']>[number]

export const deploymentStep: Record<Step['step'], string> = {
  pull: 'Pull image',
  pre_deploy: 'Pre-deploy command',
  namespace: 'Prepare network',
  baseline: 'Apply traffic rules',
  guard: 'Start outbound filter',
  service: 'Start container',
  health: 'Health check',
  cutover: 'Switch traffic',
  drain: 'Stop old deployment',
  cleanup: 'Clean up',
}

export const stepStatus: Record<Step['status'], string> = {
  pending: 'Waiting',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
}

type Build = NonNullable<Deployment['build']>

export const builder: Record<Build['builder'], string> = {
  dockerfile: 'Dockerfile',
  railpack: 'Railpack',
  image: 'Image',
}

export const buildStatus: Record<Build['status'], string> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

export const diagnosisPhase: Record<Diagnosis['phase'], string> = {
  preflight: 'Before the build',
  build: 'Build',
  pre_deploy: 'Pre-deploy command',
  start: 'Start',
  health: 'Health check',
  cutover: 'Switch traffic',
  recovery: 'Recovery after a server restart',
  run: 'Run',
  route: 'Routing',
  unpack: 'Unpack',
  disk: 'Disk',
  network: 'Network',
}

export const diagnosisFailed: Record<Diagnosis['phase'], string> = {
  preflight: 'couldn’t be prepared for deployment',
  build: 'failed to build',
  pre_deploy: 'failed its pre-deploy command',
  start: 'failed to start',
  health: 'failed its health check',
  cutover: 'couldn’t take over traffic',
  recovery: 'couldn’t recover after a server restart',
  run: 'failed while running',
  route: 'couldn’t get a route on the server',
  unpack: 'couldn’t unpack its image',
  disk: 'ran out of disk',
  network: 'couldn’t set up its network',
}

export const approvalStatus: Record<Approval['status'], Status> = {
  waiting: {
    label: 'Waiting',
    tone: 'warning',
  },
  approved: {
    label: 'Approved',
    tone: 'success',
  },
  rejected: {
    label: 'Rejected',
    tone: 'danger',
  },
  superseded: {
    label: 'Superseded',
    tone: 'neutral',
  },
}

export const taskRuntime: Record<MachineRuntimeKind, string> = {
  gvisor: machineRuntimeTradeoffs.gvisor.label,
  microvm: machineRuntimeTradeoffs.microvm.label,
}

export const cpuVirtualization: Record<NonNullable<HostProbe['cpu_virtualization']>, string> = {
  vmx: 'Intel VT-x (vmx)',
  svm: 'AMD-V (svm)',
}

export const domainStatus: Record<MapDomain['status'], Status> = {
  pending: {
    label: 'Not reachable yet',
    tone: 'warning',
  },
  active: {
    label: 'Live',
    tone: 'success',
  },
  error: {
    label: 'Not working',
    tone: 'danger',
  },
}

export const domainKind: Record<MapDomain['kind'], string> = {
  generated: 'Generated',
  custom: 'Your own',
}

export const routeResult: Record<NonNullable<MapDomain['route']['result']>, Status> = {
  ok: {
    label: 'Live',
    tone: 'success',
  },
  pending: {
    label: 'Waiting for the server',
    tone: 'warning',
  },
  failed: {
    label: 'The server couldn’t apply it',
    tone: 'danger',
  },
  blocked: {
    label: 'Blocked',
    tone: 'danger',
  },
}

export const variableKind: Record<EnvironmentVariable['kind'], string> = {
  literal: 'Visible',
  secret: 'Secret',
  reference: 'Reference',
}

export const injection: Record<EnvironmentVariable['injection'], string> = {
  env: 'Environment variable',
  file: 'File',
}

export const approvalSource: Record<Approval['source'], string> = {
  api: 'the API',
  manifest: 'a Manifest',
  compose_import: 'a Compose import',
  task: 'a task',
  ui: 'the dashboard',
}

export const actor: Record<Approval['requested_by']['type'], string> = {
  user: 'You',
  token: 'A token',
  oauth_client: 'An agent',
  station: 'A server',
  system: 'Stationly',
}

export const mcpClient = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  codex: 'Codex',
  windsurf: 'Windsurf',
  generic: 'MCP client',
} as const

export type McpClient = keyof typeof mcpClient

export const mcpClients = Object.keys(mcpClient) as McpClient[]

const isMcpClient = (id: string): id is McpClient => Object.hasOwn(mcpClient, id)

export const client = (id: string) => {
  const name = id.replace(/^mcp\//, '')

  return isMcpClient(name) ? mcpClient[name] : name
}

type Who = Pick<Approval['requested_by'], 'type' | 'client'>

export const isAgent = (who: Who) =>
  who.type === 'oauth_client' || (who.type === 'token' && Boolean(who.client?.startsWith('mcp/')))

export const actorText = (who: Who) =>
  isAgent(who) && who.client ? client(who.client) : actor[who.type]

export const level: Record<Level, { label: string; hint: string }> = {
  read: {
    label: 'Read',
    hint: 'Sees everything, changes nothing.',
  },
  deploy: {
    label: 'Deploy',
    hint: 'Reads everything, deploys, rolls back, restarts apps and runs tasks.',
  },
  admin: {
    label: 'Admin',
    hint: 'Deploy, plus creating and deleting apps, domains and secret environment variables.',
  },
}

export const sentence = (value: string) => {
  const words = value.replaceAll('_', ' ').toLowerCase()

  return words.charAt(0).toUpperCase() + words.slice(1)
}

export const terms = {
  gateway: {
    term: 'Gateway',
    definition: 'Stationly’s web entry point. Cloudflare Tunnel sends it your domains’ traffic.',
  },
} as const satisfies Record<string, { term: string; definition: string }>

export type TermKey = keyof typeof terms
