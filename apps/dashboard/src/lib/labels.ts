import type {
  Connections,
  Deployment,
  DeploymentStatus,
  Diagnosis,
  Explanation,
  NetworkMap,
  Probe,
  Sandbox,
  SandboxSnapshot,
  SandboxStatus,
  Service,
  ServiceStatus,
  StagedChange,
  Variable,
} from './api'
import type { Level } from './commands'
import type { Tone } from './tone'

export type Status = { label: string; tone: Tone }

type MapService = NetworkMap['services'][number]
type MapDomain = MapService['domains'][number]
type Connection = Connections['connections'][number]
type Hop = Explanation['hops'][number]

type PathId = NetworkMap['paths'][number]['path'] | Connections['refused'][number]['path']
type FindingCode = NetworkMap['warnings'][number]['code'] | NonNullable<Explanation['code']>

export const serviceStatus: Record<ServiceStatus, Status> = {
  green: {
    label: 'Healthy',
    tone: 'success',
  },
  amber: {
    label: 'Degraded',
    tone: 'warning',
  },
  red: {
    label: 'Failing',
    tone: 'danger',
  },
  stopped: {
    label: 'Stopped',
    tone: 'neutral',
  },
  asleep: {
    label: 'Asleep',
    tone: 'info',
  },
}

export const serviceStatusReason: Record<NonNullable<Service['status_reason']>, string> = {
  station_asleep: 'station asleep',
  gaming_mode: 'gaming mode',
  schedule: 'on schedule',
}

export const serviceKind: Record<Service['kind'], string> = {
  web: 'Web',
  worker: 'Worker',
  cron: 'Cron',
  one_off: 'One-off',
}

export const staleReason: Record<NonNullable<Service['stale_reasons']>[number]['code'], string> = {
  VARIABLES_CHANGED: 'Variables changed',
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
  variable_change: 'Variable change',
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
  station_offline: 'The station went offline',
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
  recovery: 'Recovery after a station restart',
  run: 'Run',
  route: 'Routing',
  certificate: 'Certificate',
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
  recovery: 'couldn’t recover after a station restart',
  run: 'failed while running',
  route: 'couldn’t get a route on the station',
  certificate: 'couldn’t get a certificate',
  unpack: 'couldn’t unpack its image',
  disk: 'ran out of disk',
  network: 'couldn’t set up its network',
}

export const stagedStatus: Record<StagedChange['status'], Status> = {
  staged: {
    label: 'Waiting for review',
    tone: 'warning',
  },
  accepted: {
    label: 'Accepted',
    tone: 'success',
  },
  rejected: {
    label: 'Rejected',
    tone: 'danger',
  },
  superseded: {
    label: 'Replaced',
    tone: 'neutral',
  },
}

export const sandboxStatus: Record<SandboxStatus, Status> = {
  creating: {
    label: 'Creating',
    tone: 'info',
  },
  starting: {
    label: 'Starting',
    tone: 'info',
  },
  running: {
    label: 'Running',
    tone: 'success',
  },
  stopping: {
    label: 'Stopping',
    tone: 'warning',
  },
  stopped: {
    label: 'Stopped',
    tone: 'neutral',
  },
  failed: {
    label: 'Failed',
    tone: 'danger',
  },
  deleting: {
    label: 'Deleting',
    tone: 'warning',
  },
}

export const sandboxReason: Record<NonNullable<Sandbox['status_reason']>, string> = {
  user: 'stopped by a person',
  ttl: 'time limit reached',
  exited: 'startup process exited',
  oom: 'out of memory',
  created_stopped: 'created stopped',
  station_restart: 'station restarted',
}

export const sandboxNetwork: Record<Sandbox['network'], string> = {
  isolated: 'Isolated',
  environment: 'Environment network',
}

export const snapshotSource: Record<SandboxSnapshot['source_state'], string> = {
  running: 'While running',
  stopped: 'While stopped',
}

export const snapshotStatus: Record<SandboxSnapshot['status'], Status> = {
  creating: {
    label: 'Saving',
    tone: 'info',
  },
  ready: {
    label: 'Ready',
    tone: 'success',
  },
  failed: {
    label: 'Failed',
    tone: 'danger',
  },
  deleting: {
    label: 'Deleting',
    tone: 'warning',
  },
}

export const routing: Record<MapService['switch']['state'], Status> = {
  serving: {
    label: 'Serving',
    tone: 'success',
  },
  pending: {
    label: 'Switching',
    tone: 'warning',
  },
  mismatch: {
    label: 'Routing is out of date',
    tone: 'danger',
  },
  no_target: {
    label: 'Not running',
    tone: 'neutral',
  },
}

export const domainStatus: Record<MapDomain['status'], Status> = {
  pending: {
    label: 'Waiting for certificate',
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

export const domainIngress: Record<MapDomain['ingress'], string> = {
  direct: 'Direct',
  tunnel: 'Tunnel',
}

export const routeResult: Record<NonNullable<MapDomain['route']['result']>, Status> = {
  ok: {
    label: 'Live',
    tone: 'success',
  },
  pending: {
    label: 'Waiting for the station',
    tone: 'warning',
  },
  failed: {
    label: 'The station couldn’t apply it',
    tone: 'danger',
  },
  blocked: {
    label: 'Blocked',
    tone: 'danger',
  },
}

export const path: Record<PathId, string> = {
  same_environment: 'Other services in this environment',
  resolver: 'Internal names (.internal)',
  loopback: 'Itself (localhost)',
  host_address: 'The station and Stationly’s own services',
  other_environment: 'Other environments',
  cloud_metadata: 'Cloud metadata (169.254.169.254)',
  private_range: 'Other private networks',
  public_internet: 'The internet',
  no_switch_target: 'A service that isn’t running',
  shared_service: 'Shared services',
  guard: 'Destinations its outbound rules don’t allow',
  inbound_domain: 'Your domains, from the internet',
  inbound_tcp: 'Public TCP ports, from the internet',
  inbound_other: 'Any other port, from the internet',
  sandbox_inbound: 'Sandboxes, from anywhere',
  domain_not_allowed: 'Domains outside a sandbox’s allowlist',
}

export const pathFrom: Record<NetworkMap['paths'][number]['from'], string> = {
  'every service': 'Services in this environment',
  internet: 'The internet',
  'a sandbox': 'A sandbox',
}

export const pathResult: Record<NetworkMap['paths'][number]['verdict'], Status & { hint: string }> =
  {
    allowed: {
      label: 'Allowed',
      tone: 'success',
      hint: 'Connections go through.',
    },
    blocked: {
      label: 'Blocked',
      tone: 'danger',
      hint: 'Stationly drops the traffic, so the caller waits for a timeout.',
    },
    rejected: {
      label: 'Refused',
      tone: 'warning',
      hint: 'The caller gets an immediate error.',
    },
  }

export const probeVerdict: Record<NonNullable<Probe['verdict']>['verdict'], Status> = {
  accept: pathResult.allowed,
  drop: pathResult.blocked,
  reject: pathResult.rejected,
}

export const explanationVerdict: Record<Explanation['verdict'], Status> = {
  reachable: {
    label: 'Reachable',
    tone: 'success',
  },
  blocked: {
    label: 'Blocked by a traffic rule',
    tone: 'danger',
  },
  broken: {
    label: 'Broken',
    tone: 'warning',
  },
  unknown: {
    label: 'Can’t tell yet',
    tone: 'neutral',
  },
}

export const hop: Record<Hop['hop'], string> = {
  source: 'Source is running',
  applied: 'Station has the latest config',
  dns: 'Name resolves',
  allowlist: 'Outbound allowlist',
  firewall: 'Traffic rule',
  switch: 'Routing (the Switch)',
  target: 'Destination is running and healthy',
  listening: 'Destination listens on the port',
  port: 'Port is declared',
  probe_required: 'Needs a test connection',
  domain: 'Domain',
  exposure: 'Public TCP port',
  public_address: 'Station public address',
  web_ports: 'Web traffic',
  certificate: 'Certificate',
  route: 'Route on the station',
}

export const hopStatus: Record<Hop['status'], Status> = {
  pass: {
    label: 'Passed',
    tone: 'success',
  },
  fail: {
    label: 'Failed',
    tone: 'danger',
  },
  warn: {
    label: 'Warning',
    tone: 'warning',
  },
  skipped: {
    label: 'Not checked',
    tone: 'neutral',
  },
  unknown: {
    label: 'Unknown',
    tone: 'neutral',
  },
}

export const finding: Record<FindingCode, string> = {
  SWITCH_NO_TARGET: 'Service isn’t running',
  SWITCH_PENDING: 'Routing is switching',
  SWITCH_MISMATCH: 'Routing is out of date',
  NAME_NOT_IN_ENVIRONMENT: 'Name isn’t in this environment',
  PATH_BLOCKED: 'A traffic rule blocks it',
  DOMAIN_NOT_ALLOWED: 'Domain isn’t in the allowlist',
  TARGET_NOT_RUNNING: 'Destination isn’t running',
  TARGET_UNHEALTHY: 'Destination is unhealthy',
  NOT_LISTENING: 'Nothing listens on the port',
  LISTENING_LOOPBACK_ONLY: 'Listens on localhost only',
  PORT_NOT_DECLARED: 'Port isn’t declared',
  DOMAIN_NOT_ACTIVE: 'Domain isn’t live',
  CERTIFICATE_NOT_VALID: 'Certificate isn’t valid',
  WEB_PORTS_CLOSED: 'Web traffic is closed',
  ROUTE_NOT_APPLIED: 'Route isn’t on the station yet',
  NO_PUBLIC_ADDRESS: 'Station has no public address',
  STATION_STALE: 'Station report is out of date',
}

export const direction: Record<Connection['direction'], string> = {
  in: 'Incoming',
  out: 'Outgoing',
}

export const peerKind: Record<Connection['peer']['kind'], string> = {
  service: 'Service',
  sandbox: 'Sandbox',
  resolver: 'Internal name server',
  gateway: 'Gateway',
  station: 'Station health checks',
  internet: 'Internet',
  public: 'Internet',
  address: 'Address',
  other: 'Other',
}

export const probeTcp: Record<NonNullable<Probe['tcp']>['result'], string> = {
  connected: 'Connected',
  refused: 'Refused',
  rejected: 'Refused by a traffic rule',
  timeout: 'Timed out',
  no_route: 'No route',
  no_answer: 'No answer',
}

const rcodes: Record<string, string> = {
  NOERROR: 'Found',
  NXDOMAIN: 'No such name',
  REFUSED: 'Refused',
  SERVFAIL: 'Lookup failed',
}

export const rcode = (code: string) => rcodes[code] ?? code

export const variableKind: Record<Variable['kind'], string> = {
  literal: 'Plain',
  sealed: 'Sealed',
  reference: 'Reference',
}

export const injection: Record<Variable['injection'], string> = {
  env: 'Environment variable',
  file: 'File',
}

export const stagedSource: Record<StagedChange['source'], string> = {
  api: 'the API',
  manifest: 'a Manifest',
  compose_import: 'a Compose import',
  agent: 'an agent',
  ui: 'the dashboard',
}

export const actor: Record<StagedChange['actor']['type'], string> = {
  user: 'You',
  token: 'A token',
  oauth_client: 'An agent',
  station: 'A station',
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

type Who = Pick<StagedChange['actor'], 'type' | 'client'>

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
    hint: 'Reads everything, deploys, rolls back, restarts services and runs commands and sandboxes.',
  },
  admin: {
    label: 'Admin',
    hint: 'Everything Deploy allows, plus creating and deleting services, domains and sealed variables.',
  },
}

export const sentence = (value: string) => {
  const words = value.replaceAll('_', ' ').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export const terms = {
  station: {
    term: 'Station',
    definition: 'A server that runs your services.',
  },
  gateway: {
    term: 'Gateway',
    definition: 'Stationly’s web entry point. It serves your domains and their certificates.',
  },
  switch: {
    term: 'Switch',
    definition: 'Routes a service’s stable address to its current deployment.',
  },
  internalName: {
    term: 'Internal name',
    definition: 'Other services in this environment reach the service at this name.',
  },
  stableAddress: {
    term: 'Stable address',
    definition:
      'A virtual IP that stays the same across deployments. The Switch points it at the current one.',
  },
  trafficRule: {
    term: 'Traffic rule',
    definition: 'Decides what a service can reach and what can reach it. Stations enforce them.',
  },
  publicTcpPort: {
    term: 'Public TCP port',
    definition:
      'A port on the station that forwards to a TCP port of a service, for databases and other protocols.',
  },
  liveTraffic: {
    term: 'Live traffic',
    definition: 'Open connections, sampled every 5 seconds while you watch.',
  },
  protectedEnvironment: {
    term: 'Protected environment',
    definition: 'Changes from agents and tokens wait for you to accept them.',
  },
  stagedChange: {
    term: 'Staged change',
    definition: 'A change waiting for you to accept or reject it.',
  },
  sandbox: {
    term: 'Sandbox',
    definition: 'A machine for an agent or for you, with its own disk and a time limit.',
  },
  snapshot: {
    term: 'Snapshot',
    definition: 'A saved copy of a sandbox’s disk. You can fork new sandboxes from it.',
  },
  fork: {
    term: 'Fork',
    definition: 'A new sandbox that starts from another sandbox or a snapshot.',
  },
  outboundTraffic: {
    term: 'Outbound traffic',
    definition: 'Which public destinations a sandbox can reach.',
  },
  manifest: {
    term: 'Manifest',
    definition: 'A stationly.yaml file that describes a project. sly apply creates what it lists.',
  },
} as const satisfies Record<string, { term: string; definition: string }>

export type TermKey = keyof typeof terms
