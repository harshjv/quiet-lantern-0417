export type Scope = { project: string; environment: string }

export type ServiceScope = Scope & { service: string }

export type Level = 'read' | 'deploy' | 'admin'

export type McpInstall = {
  client: string
  project: string
  environment: string | null
  level: Level
  ttl: string
}

const plain = /^[\w@%+=:,./<>-]+$/

const quote = (arg: string) => (plain.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`)

const sly = (...args: string[]) => ['sly', ...args].map(quote).join(' ')

const scoped = ({ project, environment }: Scope) => [
  '--project',
  project,
  '--environment',
  environment,
]

const serviceScoped = (scope: ServiceScope) => [...scoped(scope), '--service', scope.service]

export const commands = {
  login: (instance?: string) => sly('login', ...(instance ? ['--instance', instance] : [])),
  mcpInstall: ({ client, project, environment, level, ttl }: McpInstall) =>
    sly(
      'mcp',
      'install',
      client,
      '--project',
      project,
      ...(environment ? ['--environment', environment] : []),
      ...(level === 'deploy' ? [] : ['--level', level]),
      ...(ttl === '30d' ? [] : ['--ttl', ttl]),
    ),
  createToken: (scope: string, ttl: string) =>
    sly('tokens', 'create', '<name>', '--scope', scope, '--ttl', ttl),
  listServices: (scope: Scope) => sly(...scoped(scope), 'services', 'list'),
  createProject: () => sly('projects', 'create', '<name>'),
  createEnvironment: (project: string) =>
    sly('--project', project, 'environments', 'create', '<name>'),
  createService: (scope: Scope) =>
    sly(...scoped(scope), 'services', 'create', '<name>', '--image', '<image>'),
  deploy: (scope: ServiceScope) => sly(...serviceScoped(scope), 'deploy', '--wait'),
  setServiceVariable: (scope: ServiceScope) =>
    sly(...serviceScoped(scope), 'variables', 'set', 'KEY=value'),
  setProjectVariable: (scope: Scope) => sly(...scoped(scope), 'variables', 'set', 'KEY=value'),
  addDomain: (scope: ServiceScope, port: number | null) =>
    sly(
      ...serviceScoped(scope),
      'domains',
      'add',
      '<hostname>',
      '--port',
      port === null ? '<port>' : String(port),
    ),
  exposeTcp: (scope: ServiceScope, port: number | null) =>
    sly(...serviceScoped(scope), 'expose', 'tcp', port === null ? '<port>' : String(port)),
  setPublicAddress: (station: string) =>
    sly('stations', 'update', station, '--public-address', '<ipv4>'),
  createSandbox: (scope: Scope) =>
    sly(...scoped(scope), 'sandbox', 'create', '<name>', '--ttl', '2h'),
  snapshotSandbox: (scope: Scope, sandbox: string) =>
    sly(...scoped(scope), 'sandbox', 'snapshot', sandbox),
  setSandboxVariable: (sandbox: string) => sly('sandbox', 'variables', 'set', sandbox, 'KEY=value'),
  forward: (sandbox: string, port: number) => sly('sandbox', 'forward', sandbox, String(port)),
} as const

export const tools = [
  'whoami',
  'describe_environment',
  'list_services',
  'describe_service',
  'get_deployment_diagnosis',
  'get_logs',
  'create_project',
  'create_environment',
  'create_service',
  'deploy',
  'set_service_variables',
  'set_project_variables',
  'add_domain',
  'expose_tcp',
  'update_station',
  'update_service',
  'create_sandbox',
  'snapshot_sandbox',
  'set_sandbox_variables',
] as const

export type Tool = (typeof tools)[number]

export const placeholders = (command: string) =>
  [...command.matchAll(/<([^<>]+)>/g)].map((m) => m[1]!)
