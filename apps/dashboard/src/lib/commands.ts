export type Scope = { project: string; environment: string }

export type ServiceScope = Scope & { service: string }

export type Level = 'read' | 'deploy' | 'admin'

export type TokenScope = { project: string; environment: string; level: Level }

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
  createToken: ({ project, environment, level }: TokenScope, ttl: string) =>
    sly(
      'tokens',
      'create',
      '<name>',
      '--kind',
      'scoped',
      '--scopes',
      `project_id=${project},environment_id=${environment},level=${level}`,
      '--expires-in-s',
      ttl,
    ),
  listServices: (scope: Scope) => sly(...scoped(scope), 'services', 'list'),
  createProject: () => sly('projects', 'create', '<name>'),
  createEnvironment: (project: string) =>
    sly('--project', project, 'environments', 'create', '<name>'),
  createService: (scope: Scope) =>
    sly(
      ...scoped(scope),
      'services',
      'create',
      '<name>',
      '--kind',
      'web',
      '--source',
      'type=image,ref=<image>',
    ),
  deploy: (scope: ServiceScope) => sly(...serviceScoped(scope), 'deploy', '--wait'),
  startService: (scope: ServiceScope) => sly(...serviceScoped(scope), 'services', 'start'),
  rollback: (scope: ServiceScope, deployment: string) =>
    sly(...serviceScoped(scope), 'rollback', '--deployment-id', deployment, '--wait'),
  setMemory: (scope: ServiceScope, bytes: number) =>
    sly(...serviceScoped(scope), 'services', 'update', '--limits', `memory_bytes=${bytes}`),
  setHealth: (scope: ServiceScope, port: number | null) =>
    sly(
      ...serviceScoped(scope),
      'services',
      'update',
      '--health',
      `type=http,path=/,port=${port ?? '<port>'}`,
    ),
  logs: (scope: ServiceScope, deployment: string, build: string | null) =>
    sly(
      ...serviceScoped(scope),
      'logs',
      ...(build ? ['--build', build] : ['--deployment', deployment]),
    ),
  probe: (scope: ServiceScope, to: string, port: number | null) =>
    sly(
      ...serviceScoped(scope),
      'network',
      'explain',
      '--to',
      to,
      ...(port === null ? [] : ['--port', String(port)]),
      '--probe',
    ),
  setServiceVariable: (scope: ServiceScope) =>
    sly(...serviceScoped(scope), 'variables', 'set', 'KEY=value'),
  setProjectVariable: (scope: Scope) => sly(...scoped(scope), 'variables', 'set', 'KEY=value'),
  addDomain: (port: string | null) =>
    sly('domains', 'add', port ?? '<port-id>', '--hostname', '<hostname>'),
  exposeTcp: (port: string | null) => sly('domains', 'expose-tcp', port ?? '<port-id>'),
  setPublicAddress: (station: string) =>
    sly('stations', 'update', station, '--public-address', '<ipv4>'),
  setSandboxRuntime: (station: string) =>
    sly('stations', 'update', station, '--default-sandbox-runtime', '<runtime>'),
  startSandbox: (scope: Scope, sandbox: string) =>
    sly(...scoped(scope), '--sandbox', sandbox, 'sandboxes', 'start'),
  createWorkspace: (scope: Scope) =>
    sly(
      ...scoped(scope),
      'sandboxes',
      'create',
      '<name>',
      '--workspace',
      'agent=claude,repository=<repository-url>',
    ),
  openWorkspace: (name: string) => sly('sandboxes', 'shell', name),
  createSandbox: (scope: Scope) =>
    sly(...scoped(scope), 'sandboxes', 'create', '<name>', '--ttl-s', '2h'),
  snapshotSandbox: (scope: Scope, sandbox: string) =>
    sly(...scoped(scope), '--sandbox', sandbox, 'sandboxes', 'snapshot'),
  setSandboxVariable: (sandbox: string) =>
    sly('--sandbox', sandbox, 'variables', 'set', 'KEY=value'),
  forward: (sandbox: string, port: number) =>
    sly('--sandbox', sandbox, 'sandboxes', 'forward', String(port)),
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
  'start_service',
  'rollback',
  'probe_network',
  'start_sandbox',
  'update_sandbox',
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
