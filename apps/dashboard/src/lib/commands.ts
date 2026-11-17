export type Scope = { project: string; preview: string | null }

export type AppScope = Scope & { app: string }

export type Level = 'read' | 'deploy' | 'admin'

export type TokenTarget = 'production' | 'previews' | '*'

export type TokenScope = { project: string; target: TokenTarget; level: Level }

export type McpInstall = {
  client: string
  project: string
  target: TokenTarget
  level: Level
  ttl: string
}

const plain = /^[\w@%+=:,./<>-]+$/

const quote = (arg: string) => (plain.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`)

const sly = (...args: string[]) => ['sly', ...args].map(quote).join(' ')

const scoped = ({ project, preview }: Scope) => [
  '--project',
  project,
  ...(preview ? ['--preview', preview] : []),
]

export const scopeLabel = ({ project, preview }: Scope) =>
  preview ? `the ${preview} preview of ${project}` : `${project} production`

const appScoped = (scope: AppScope) => [...scoped(scope), '--app', scope.app]

export const commands = {
  login: (instance?: string) => sly('login', ...(instance ? ['--instance', instance] : [])),
  mcpInstall: ({ client, project, target, level, ttl }: McpInstall) =>
    sly(
      'mcp',
      'install',
      client,
      '--project',
      project,
      ...(target === '*' ? [] : ['--target', target]),
      ...(level === 'deploy' ? [] : ['--level', level]),
      ...(ttl === '30d' ? [] : ['--ttl', ttl]),
    ),
  createToken: ({ project, target, level }: TokenScope, ttl: string) =>
    sly(
      'tokens',
      'create',
      '<name>',
      '--kind',
      'scoped',
      '--scopes',
      `project_id=${project},target=${target},level=${level}`,
      '--expires-in-s',
      ttl,
    ),
  listApps: (scope: Scope) => sly(...scoped(scope), 'apps', 'list'),
  createProject: () => sly('projects', 'create', '<name>'),
  createPreview: (project: string) => sly('--project', project, 'previews', 'create', '<name>'),
  createApp: (scope: Scope) =>
    sly(
      ...scoped(scope),
      'apps',
      'create',
      '<name>',
      '--kind',
      'web',
      '--source',
      'type=image,ref=<image>',
    ),
  deploy: (scope: AppScope) => sly(...appScoped(scope), 'deploy', '--wait'),
  startApp: (scope: AppScope) => sly(...appScoped(scope), 'apps', 'start'),
  rollback: (scope: AppScope, deployment: string) =>
    sly(...appScoped(scope), 'rollback', '--deployment-id', deployment, '--wait'),
  setMemory: (scope: AppScope, bytes: number) =>
    sly(...appScoped(scope), 'apps', 'update', '--limits', `memory_bytes=${bytes}`),
  setHealth: (scope: AppScope, port: number | null) =>
    sly(
      ...appScoped(scope),
      'apps',
      'update',
      '--health',
      `type=http,path=/,port=${port ?? '<port>'}`,
    ),
  logs: (scope: AppScope, deployment: string, build: string | null) =>
    sly(
      ...appScoped(scope),
      'logs',
      ...(build ? ['--build', build] : ['--deployment', deployment]),
    ),
  probe: (scope: AppScope, to: string, port: number | null) =>
    sly(
      ...appScoped(scope),
      'network',
      'explain',
      '--to',
      to,
      ...(port === null ? [] : ['--port', String(port)]),
      '--probe',
    ),
  setAppKey: (scope: AppScope) => sly(...appScoped(scope), 'keys', 'set', 'KEY=value'),
  setProjectKey: (scope: Scope) => sly(...scoped(scope), 'keys', 'set', 'KEY=value'),
  addDomain: (port: string | null) =>
    sly('domains', 'add', port ?? '<port-id>', '--hostname', '<hostname>'),
  exposeTcp: (port: string | null) => sly('domains', 'expose-tcp', port ?? '<port-id>'),
  setPublicAddress: (station: string) =>
    sly('servers', 'update', station, '--public-address', '<ipv4>'),
  setMachineRuntime: (station: string) =>
    sly('servers', 'update', station, '--default-machine-runtime', '<runtime>'),
  startMachine: (scope: Scope, machine: string) =>
    sly(...scoped(scope), '--machine', machine, 'machines', 'start'),
  machineShell: (scope: Scope, name: string) => sly('machines', 'shell', name, ...scoped(scope)),
  createMachine: (scope: Scope) =>
    sly(...scoped(scope), 'machines', 'create', '<name>', '--ttl-s', '2h'),
  snapshotMachine: (scope: Scope, machine: string) =>
    sly(...scoped(scope), '--machine', machine, 'machines', 'snapshot'),
  setMachineKey: (machine: string) => sly('--machine', machine, 'keys', 'set', 'KEY=value'),
  forward: (machine: string, port: number) =>
    sly('--machine', machine, 'machines', 'forward', String(port)),
} as const

export const tools = [
  'whoami',
  'get_project',
  'describe_preview',
  'list_apps',
  'describe_app',
  'get_deployment_diagnosis',
  'get_logs',
  'create_project',
  'create_preview',
  'create_app',
  'deploy',
  'start_app',
  'rollback',
  'probe_network',
  'start_machine',
  'update_machine',
  'set_app_keys',
  'set_project_keys',
  'add_domain',
  'expose_tcp',
  'update_server',
  'update_app',
  'create_machine',
  'snapshot_machine',
  'set_machine_keys',
] as const

export type Tool = (typeof tools)[number]

export const placeholders = (command: string) =>
  [...command.matchAll(/<([^<>]+)>/g)].map((m) => m[1]!)
