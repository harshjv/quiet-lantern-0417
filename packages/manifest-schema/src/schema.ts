import { Optional, Type, type Static, type TSchema } from '@sinclair/typebox'

import {
  desiredStateValues,
  domainFieldText,
  firewallModeValues,
  ingressValues,
  injectionValues,
  portFieldText,
  portProtocolValues,
  portRange,
  scheduleConcurrencyValues,
  serviceFieldText,
  serviceKindValues,
  slugPattern,
  strategyValues,
  StringEnum,
  variableKeyPattern,
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
      pattern: variableKeyPattern,
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

const ServicePort = Type.Object(
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
    description: 'A port the service listens on',
    ...strict,
  },
)

export const Health = Type.Object(
  {
    type: Optional(
      StringEnum(['http', 'tcp', 'image', 'alive'], {
        description:
          'http on the first http port for web, tcp for a web service with only tcp ports, alive for worker',
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
          "http only: the Host header the check sends; the service's first domain, else <service>.internal",
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
        description: 'Consecutive failures before red',
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
    description: serviceFieldText.health,
    ...strict,
  },
)

export const Limits = Type.Object(
  {
    cpu_millis: Optional(
      Type.Integer({
        minimum: 10,
        default: 1000,
        description: "CPU in millicores, up to the station's resources.cpu_millis",
      }),
    ),
    memory_bytes: Optional(
      Type.Integer({
        minimum: 8388608,
        default: 536870912,
        description: "Memory in bytes, up to the station's resources.memory_bytes",
      }),
    ),
  },
  {
    description: serviceFieldText.limits,
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
    description: serviceFieldText.schedule,
    ...strict,
  },
)

const Volume = Type.Object(
  {
    mount_path: Type.String({
      pattern: '^/',
      description: volumeFieldText.mount_path,
    }),
    station_volume: Optional(
      Type.String({
        minLength: 1,
        description: 'A station-owned volume to mount (phase 2)',
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
        description: "A declared http port; the service's first http port by default",
      }),
    ),
    ingress: Optional(
      StringEnum(ingressValues, {
        description: domainFieldText.ingress,
      }),
    ),
  },
  {
    description: 'A domain routed to an http port',
    ...strict,
  },
)

const Scalar = Type.Union([Type.String(), Type.Number(), Type.Boolean()])

const VariableObject = Type.Object(
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
    description: 'The object form of a service variable',
    ...strict,
  },
)

export const ServiceVariable = Type.Union([Scalar, VariableObject], {
  description: 'A literal, a reference, an interpolation, or an object form',
})

const ProjectVariableObject = Type.Object(
  {
    default: Optional(Scalar),
    environments: Optional(SlugMap(Scalar, 'Literal values per environment name')),
    sealed: Optional(
      Type.Literal(true, {
        description: 'Declared; values are set per environment with set_project_variables',
      }),
    ),
    reference: Optional(
      Type.String({
        description: '${{secret(N)}} with sealed: each environment gets its own generated value',
      }),
    ),
  },
  {
    description: 'The object form of a project variable',
    ...strict,
  },
)

export const ProjectVariable = Type.Union([Scalar, ProjectVariableObject], {
  description: 'A project default, per-environment values, or a sealed declaration',
})

const FirewallRule = Type.Object(
  {
    domain: Optional(Type.String()),
    wildcard: Optional(Type.Boolean()),
    cidr: Optional(Type.String()),
    service: Optional(Type.String()),
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

export const Service = Type.Object(
  {
    kind: StringEnum(serviceKindValues, {
      description: serviceFieldText.kind,
    }),
    source: Source,
    station: Optional(
      Type.String({
        minLength: 1,
        description: 'An enrolled station name; the only online station by default',
      }),
    ),
    command: Optional(
      Type.Union([Type.Array(Type.String()), Type.Null()], {
        default: null,
        description: serviceFieldText.command,
      }),
    ),
    build_args: Optional(KeyMap(Type.String(), serviceFieldText.build_args)),
    ports: Optional(
      Type.Array(ServicePort, {
        default: [],
        description: serviceFieldText.ports,
      }),
    ),
    health: Optional(Health),
    limits: Optional(Limits),
    strategy: Optional(
      StringEnum(strategyValues, {
        description: serviceFieldText.strategy,
      }),
    ),
    multi_writer_safe: Optional(
      Type.Boolean({
        default: false,
        description: serviceFieldText.multi_writer_safe,
      }),
    ),
    drain_timeout_s: Optional(
      Type.Integer({
        minimum: 0,
        maximum: 3600,
        default: 30,
        description: serviceFieldText.drain_timeout_s,
      }),
    ),
    readonly_rootfs: Optional(
      Type.Boolean({
        default: false,
        description: serviceFieldText.readonly_rootfs,
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
          description: serviceFieldText.secrets_owner,
        },
      ),
    ),
    pre_deploy: Optional(
      Type.Union([Type.Array(Type.String()), Type.Null()], {
        default: null,
        description: serviceFieldText.pre_deploy,
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
    expose_tcp: Optional(
      Type.Array(Type.Integer(portRange), {
        description: 'Declared tcp ports exposed on a host port',
      }),
    ),
    variables: Optional(
      KeyMap(ServiceVariable, 'Service variables; absent: not managed by the Manifest'),
    ),
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
    description: 'A service; the map key is its name and DNS label',
    ...strict,
  },
)

export const ServiceOverride = Type.Object(
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
    station: Optional(
      Type.Union([
        Type.String({
          minLength: 1,
        }),
        Type.Null(),
      ]),
    ),
    limits: Optional(Type.Union([Limits, Type.Null()])),
    domains: Optional(Type.Union([Type.Array(Domain), Type.Null()])),
    expose_tcp: Optional(Type.Union([Type.Array(Type.Integer(portRange)), Type.Null()])),
    desired_state: Optional(Type.Union([StringEnum(desiredStateValues), Type.Null()])),
    schedule: Optional(Type.Union([Schedule, Type.Null()])),
    variables: Optional(
      Type.Union([KeyMap(ServiceVariable, 'Variables merged key by key'), Type.Null()]),
    ),
  },
  {
    description: 'Keys that may differ in one environment; null resets a key to its default',
    ...strict,
  },
)

const EnvironmentOverride = Type.Object(
  {
    services: Optional(SlugMap(ServiceOverride, 'Per-service overrides')),
  },
  {
    description: 'Overrides for one environment',
    ...strict,
  },
)

const Attachment = Type.Object(
  {
    service: Type.String({
      pattern: slugPattern.replace('^', '^shared/'),
      description: 'shared/<service name>',
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
    variables: Optional(
      KeyMap(ProjectVariable, 'Project variables; absent: not managed by the Manifest'),
    ),
    services: Optional(
      SlugMap(Service, 'Services in the target environment; absent: not managed by the Manifest'),
    ),
    environments: Optional(
      SlugMap(EnvironmentOverride, 'Overrides applied when the name equals the target environment'),
    ),
    shared: Optional(SlugMap(Attachment, 'Attachments to shared services (phase 1b)')),
  },
  {
    title: 'Stationly Manifest',
    description: 'stationly.yaml: one project, applied to one environment at a time',
    ...strict,
  },
)

export type ManifestDoc = Static<typeof Manifest>
export type ServiceDoc = Static<typeof Service>
export type ServiceOverrideDoc = Static<typeof ServiceOverride>
export type ServiceVariableDoc = Static<typeof ServiceVariable>
export type ProjectVariableDoc = Static<typeof ProjectVariable>
export type DomainDoc = Static<typeof Domain>
export type HealthDoc = Static<typeof Health>

export const overridableKeys = [
  'source',
  'station',
  'limits',
  'domains',
  'expose_tcp',
  'desired_state',
  'schedule',
  'variables',
] as const
