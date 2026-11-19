import { Optional, Type, type Static, type TSchema } from '@sinclair/typebox'

import {
  appFieldText,
  appKindValues,
  desiredStateValues,
  domainFieldText,
  firewallModeValues,
  injectionValues,
  keyNamePattern,
  portFieldText,
  portProtocolValues,
  portRange,
  scheduleConcurrencyValues,
  slugPattern,
  strategyValues,
  StringEnum,
  volumeFieldText,
} from '@stationly/protocol'

const strict = {
  additionalProperties: false,
} as const

export const repoPattern = '^github\\.com/[a-z0-9][a-z0-9-]*/[a-z0-9._-]+$'
const hostnamePattern =
  '^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z][a-z0-9-]{0,62}$'

const SlugMap = <T extends TSchema>(value: T, description: string) =>
  Type.Record(
    Type.String({
      pattern: slugPattern,
    }),
    value,
    {
      description,
      ...strict,
    },
  )
const KeyMap = <T extends TSchema>(value: T, description: string) =>
  Type.Record(
    Type.String({
      pattern: keyNamePattern,
    }),
    value,
    {
      description,
      ...strict,
    },
  )

const ImageSource = Type.Object(
  {
    type: Type.Literal('image', {
      description: 'A registry image, pinned to its digest at each deploy',
    }),
    ref: Type.String({
      minLength: 1,
      description: 'A registry reference with a tag or a digest',
    }),
  },
  {
    description: 'Run a prebuilt image',
    ...strict,
  },
)

const repo = Type.String({
  pattern: repoPattern,
  description: 'github.com/<owner>/<name>, lower case, without scheme or .git',
})
const branch = Type.String({
  minLength: 1,
  description: "The tracked branch; the repository's default branch at creation when omitted",
})
const path = Type.String({
  pattern: '^/',
  default: '/',
  description: 'The build context inside the repository',
})

const DockerfileSource = Type.Object(
  {
    type: Type.Literal('dockerfile', {
      description: 'Build a GitHub repository with its Dockerfile',
    }),
    repo,
    branch: Optional(branch),
    path: Optional(path),
    dockerfile: Optional(
      Type.String({
        minLength: 1,
        default: 'Dockerfile',
        description: 'The Dockerfile, relative to path',
      }),
    ),
  },
  {
    description: 'Build a GitHub repository with a Dockerfile',
    ...strict,
  },
)

const RailpackSource = Type.Object(
  {
    type: Type.Literal('railpack', {
      description: 'Build a GitHub repository with Railpack',
    }),
    repo,
    branch: Optional(branch),
    path: Optional(path),
  },
  {
    description: 'Build a GitHub repository with Railpack',
    ...strict,
  },
)

const LocalSource = Type.Object(
  {
    type: Type.Literal('local', {
      description: 'Whatever sly push uploads last',
    }),
    dockerfile: Optional(
      Type.String({
        minLength: 1,
        description:
          'The Dockerfile, relative to the uploaded directory; Railpack builds without one',
      }),
    ),
  },
  {
    description: 'A directory uploaded by sly push',
    ...strict,
  },
)

const TemplateSource = Type.Object(
  {
    type: Type.Literal('template', {
      description: 'A template (phase 1b)',
    }),
    template: Type.String({
      minLength: 1,
      description: 'The template name',
    }),
    version: Optional(
      Type.String({
        minLength: 1,
        description: 'A semver range, default latest',
      }),
    ),
  },
  {
    description: 'A template (phase 1b)',
    ...strict,
  },
)

export const Source = Type.Union(
  [ImageSource, DockerfileSource, RailpackSource, LocalSource, TemplateSource],
  {
    description: 'How the image is produced',
  },
)

const AppPort = Type.Object(
  {
    port: Type.Integer({
      ...portRange,
      description: portFieldText.port,
    }),
    protocol: Optional(
      StringEnum(portProtocolValues, {
        default: 'http',
        description: portFieldText.protocol,
      }),
    ),
    grpc: Optional(
      Type.Boolean({
        default: false,
        description: portFieldText.grpc,
      }),
    ),
  },
  {
    description: 'A port the app listens on',
    ...strict,
  },
)

export const Health = Type.Object(
  {
    type: Optional(
      StringEnum(['http', 'tcp', 'image', 'alive'], {
        description:
          'http on the first http port for web, tcp for a web app with only tcp ports, alive for worker',
      }),
    ),
    path: Optional(
      Type.String({
        pattern: '^/',
        default: '/',
        description: 'The http check path',
      }),
    ),
    host: Optional(
      Type.String({
        pattern: '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$',
        description:
          "http only: the Host header the check sends; the app's first domain, else <app>.internal",
      }),
    ),
    port: Optional(
      Type.Integer({
        ...portRange,
        description: 'A declared port; the first http port for http, the first port for tcp',
      }),
    ),
    interval_s: Optional(
      Type.Integer({
        minimum: 1,
        maximum: 300,
        default: 5,
        description: 'Seconds between checks',
      }),
    ),
    timeout_s: Optional(
      Type.Integer({
        minimum: 1,
        maximum: 300,
        default: 3,
        description: 'Seconds per check, at most interval_s',
      }),
    ),
    startup_timeout_s: Optional(
      Type.Integer({
        minimum: 5,
        maximum: 3600,
        description: '120 for http and image, 60 for tcp',
      }),
    ),
    passes: Optional(
      Type.Integer({
        minimum: 1,
        maximum: 10,
        default: 2,
        description: 'Consecutive passes before cutover',
      }),
    ),
    failures: Optional(
      Type.Integer({
        minimum: 1,
        maximum: 100,
        default: 3,
        description: 'Consecutive failures before failing',
      }),
    ),
    seconds: Optional(
      Type.Integer({
        minimum: 1,
        maximum: 3600,
        default: 10,
        description: 'alive only: seconds the process must stay up',
      }),
    ),
  },
  {
    description: appFieldText.health,
    ...strict,
  },
)

export const Limits = Type.Object(
  {
    cpu_millis: Optional(
      Type.Integer({
        minimum: 10,
        default: 1000,
        description: "CPU in millicores, up to the server's resources.cpu_millis",
      }),
    ),
    memory_bytes: Optional(
      Type.Integer({
        minimum: 8388608,
        default: 536870912,
        description: "Memory in bytes, up to the server's resources.memory_bytes",
      }),
    ),
  },
  {
    description: appFieldText.limits,
    ...strict,
  },
)

export const Schedule = Type.Object(
  {
    cron: Type.String({
      minLength: 1,
      description: 'A five-field cron expression',
    }),
    timezone: Optional(
      Type.String({
        minLength: 1,
        default: 'UTC',
        description: 'An IANA time zone name',
      }),
    ),
    concurrency: Optional(
      StringEnum(scheduleConcurrencyValues, {
        default: 'skip',
        description: 'What to do when the previous run is still going',
      }),
    ),
  },
  {
    description: appFieldText.schedule,
    ...strict,
  },
)

const Volume = Type.Object(
  {
    mount_path: Type.String({
      pattern: '^/',
      description: volumeFieldText.mount_path,
    }),
    server_volume: Optional(
      Type.String({
        minLength: 1,
        description: 'A server-owned volume to mount (phase 2)',
      }),
    ),
  },
  {
    description: 'A volume, identified by mount_path',
    ...strict,
  },
)

export const Domain = Type.Object(
  {
    generated: Optional(
      Type.Literal(true, {
        description: domainFieldText.generated,
      }),
    ),
    hostname: Optional(
      Type.String({
        pattern: hostnamePattern,
        description: domainFieldText.hostname,
      }),
    ),
    port: Optional(
      Type.Integer({
        ...portRange,
        description: "A declared http port; the app's first http port by default",
      }),
    ),
  },
  {
    description: 'A domain routed to an http port',
    ...strict,
  },
)

const Scalar = Type.Union([Type.String(), Type.Number(), Type.Boolean()])

const KeyObject = Type.Object(
  {
    value: Optional(
      Type.String({
        description: 'A literal, never evaluated',
      }),
    ),
    reference: Optional(
      Type.String({
        description: 'A reference expression, or ${{secret(N)}} with sealed',
      }),
    ),
    sealed: Optional(
      Type.Literal(true, {
        description: 'Declares a sealed key whose value is set out of band',
      }),
    ),
    injection: Optional(
      StringEnum(injectionValues, {
        default: 'env',
        description: 'file writes /run/secrets/<KEY> and sets <KEY>_FILE',
      }),
    ),
    build: Optional(
      Type.Boolean({
        default: false,
        description: 'Also a BuildKit secret during builds',
      }),
    ),
  },
  {
    description: 'The object form of an app key',
    ...strict,
  },
)

export const AppKey = Type.Union([Scalar, KeyObject], {
  description: 'A literal, a reference, an interpolation, or an object form',
})

const ProjectKeyObject = Type.Object(
  {
    production: Optional(Scalar),
    preview: Optional(Scalar),
    sealed: Optional(
      Type.Literal(true, {
        description: 'Declared; production and preview values are set with set_project_keys',
      }),
    ),
    reference: Optional(
      Type.String({
        description:
          '${{secret(N)}} with sealed: production and previews get their own generated values',
      }),
    ),
  },
  {
    description: 'The object form of a project key',
    ...strict,
  },
)

export const ProjectKey = Type.Union([Scalar, ProjectKeyObject], {
  description: 'A production value, production and preview values, or a sealed declaration',
})

const FirewallRule = Type.Object(
  {
    domain: Optional(Type.String()),
    wildcard: Optional(Type.Boolean()),
    cidr: Optional(Type.String()),
    app: Optional(Type.String()),
    preset: Optional(Type.String()),
    ports: Optional(
      Type.Array(
        Type.Object(
          {
            port: Type.Integer(portRange),
            protocol: Optional(StringEnum(['tcp', 'udp'])),
          },
          strict,
        ),
      ),
    ),
  },
  strict,
)

const Firewall = Type.Object(
  {
    mode: Optional(
      StringEnum(firewallModeValues, {
        default: 'learn',
      }),
    ),
    includes: Optional(Type.Array(Type.String())),
    allow: Optional(Type.Array(FirewallRule)),
  },
  {
    description: 'Runtime egress policy (phase 1b)',
    ...strict,
  },
)

export const App = Type.Object(
  {
    kind: StringEnum(appKindValues, {
      description: appFieldText.kind,
    }),
    source: Source,
    server: Optional(
      Type.String({
        minLength: 1,
        description: 'An enrolled server name; the only online server by default',
      }),
    ),
    command: Optional(
      Type.Union([Type.Array(Type.String()), Type.Null()], {
        default: null,
        description: appFieldText.command,
      }),
    ),
    build_args: Optional(KeyMap(Type.String(), appFieldText.build_args)),
    ports: Optional(
      Type.Array(AppPort, {
        default: [],
        description: appFieldText.ports,
      }),
    ),
    health: Optional(Health),
    limits: Optional(Limits),
    strategy: Optional(
      StringEnum(strategyValues, {
        description: appFieldText.strategy,
      }),
    ),
    multi_writer_safe: Optional(
      Type.Boolean({
        default: false,
        description: appFieldText.multi_writer_safe,
      }),
    ),
    drain_timeout_s: Optional(
      Type.Integer({
        minimum: 0,
        maximum: 3600,
        default: 30,
        description: appFieldText.drain_timeout_s,
      }),
    ),
    readonly_rootfs: Optional(
      Type.Boolean({
        default: false,
        description: appFieldText.readonly_rootfs,
      }),
    ),
    secrets_owner: Optional(
      Type.Union(
        [
          Type.Object(
            {
              uid: Type.Integer({
                minimum: 0,
              }),
              gid: Type.Integer({
                minimum: 0,
              }),
            },
            strict,
          ),
          Type.Null(),
        ],
        {
          default: null,
          description: appFieldText.secrets_owner,
        },
      ),
    ),
    pre_deploy: Optional(
      Type.Union([Type.Array(Type.String()), Type.Null()], {
        default: null,
        description: appFieldText.pre_deploy,
      }),
    ),
    schedule: Optional(Schedule),
    volumes: Optional(
      Type.Array(Volume, {
        description: 'Absent: not managed by the Manifest',
      }),
    ),
    domains: Optional(
      Type.Array(Domain, {
        description: 'Absent: not managed by the Manifest',
      }),
    ),
    keys: Optional(KeyMap(AppKey, 'App keys; absent: not managed by the Manifest')),
    desired_state: Optional(
      StringEnum(desiredStateValues, {
        default: 'running',
        description: 'running or stopped',
      }),
    ),
    firewall: Optional(Firewall),
    gpu: Optional(
      Type.Object(
        {
          count: Type.Integer({
            minimum: 1,
            description: 'GPUs (phase 2)',
          }),
        },
        strict,
      ),
    ),
  },
  {
    description: 'An app; the map key is its name and DNS label',
    ...strict,
  },
)

export const AppOverride = Type.Object(
  {
    source: Optional(
      Type.Object(
        {
          branch: Optional(branch),
          ref: Optional(
            Type.String({
              minLength: 1,
            }),
          ),
        },
        {
          description: 'Only branch and ref may differ',
          ...strict,
        },
      ),
    ),
    server: Optional(
      Type.Union([
        Type.String({
          minLength: 1,
        }),
        Type.Null(),
      ]),
    ),
    limits: Optional(Type.Union([Limits, Type.Null()])),
    domains: Optional(Type.Union([Type.Array(Domain), Type.Null()])),
    desired_state: Optional(Type.Union([StringEnum(desiredStateValues), Type.Null()])),
    schedule: Optional(Type.Union([Schedule, Type.Null()])),
    keys: Optional(Type.Union([KeyMap(AppKey, 'Keys merged one by one'), Type.Null()])),
  },
  {
    description: 'Keys that may differ in one preview; null resets a key to its production value',
    ...strict,
  },
)

const PreviewOverride = Type.Object(
  {
    apps: Optional(SlugMap(AppOverride, 'Per-app overrides')),
  },
  {
    description: 'Overrides for one preview',
    ...strict,
  },
)

const Attachment = Type.Object(
  {
    app: Type.String({
      pattern: slugPattern.replace('^', '^shared/'),
      description: 'shared/<app name>',
    }),
  },
  {
    description: 'An attachment (phase 1b)',
    ...strict,
  },
)

export const Manifest = Type.Object(
  {
    version: Type.Integer({
      description: 'The file format version, 1',
    }),
    project: Type.String({
      pattern: slugPattern,
      description: 'The project name; checked, never written',
    }),
    keys: Optional(KeyMap(ProjectKey, 'Project keys; absent: not managed by the Manifest')),
    apps: Optional(
      SlugMap(
        App,
        'Apps in production or the preview it is applied to; absent: not managed by the Manifest',
      ),
    ),
    previews: Optional(
      SlugMap(
        PreviewOverride,
        'Overrides applied when the Manifest is applied to the preview of this name',
      ),
    ),
    shared: Optional(SlugMap(Attachment, 'Attachments to shared apps (phase 1b)')),
  },
  {
    title: 'Stationly Manifest',
    description: 'stationly.yaml: one project, applied to production or one preview at a time',
    ...strict,
  },
)

export type ManifestDoc = Static<typeof Manifest>
export type AppDoc = Static<typeof App>
export type AppOverrideDoc = Static<typeof AppOverride>
export type AppKeyDoc = Static<typeof AppKey>
export type ProjectKeyDoc = Static<typeof ProjectKey>
export type DomainDoc = Static<typeof Domain>
export type HealthDoc = Static<typeof Health>

export const overridableKeys = [
  'source',
  'server',
  'limits',
  'domains',
  'desired_state',
  'schedule',
  'keys',
] as const
