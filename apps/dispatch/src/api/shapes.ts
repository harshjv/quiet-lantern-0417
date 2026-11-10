import {
  Type,
  type Static,
  type TLiteral,
  type TNull,
  type TObject,
  type TOptional,
  type TProperties,
  type TSchema,
  type TUnion,
  type TUnsafe,
} from '@sinclair/typebox'
import { Elysia, type t } from 'elysia'

import {
  Actor as ActorSchema,
  appliedStatusValues,
  attestationKindValues,
  baseImageCheckValues,
  BaseImage as BaseImageSchema,
  builderValues,
  buildStatusValues,
  cancelReasonValues,
  componentNameValues,
  componentStatusValues,
  deploymentStatusValues,
  deploymentStepNameValues,
  deploymentStepStatusValues,
  deploymentTriggerValues,
  desiredStateValues,
  Diagnosis as DiagnosisSchema,
  domainKindValues,
  domainStatusValues,
  ErrorBody,
  errorCatalog,
  HealthCheck as HealthCheckSchema,
  ingressValues,
  injectionValues,
  JsonObject,
  networkPathIds,
  networkPeerKinds,
  networkVerdicts,
  notificationChannelKindValues,
  notificationChannelStatusValues,
  Nullable,
  portAllocationStatusValues,
  portProtocolValues,
  probeKinds,
  probeTcpResults,
  refusedPaths,
  repoAuthValues,
  Resources as ResourcesSchema,
  runKindValues,
  runStatusValues,
  SandboxEgressDomain as SandboxEgressDomainSchema,
  sandboxEgressModeValues,
  SandboxLimits as SandboxLimitsSchema,
  sandboxNetworkValues,
  SandboxSize as SandboxSizeSchema,
  sandboxSnapshotStatusValues,
  sandboxSourceStateValues,
  sandboxStatusReasonValues,
  sandboxStatusValues,
  Schedule as ScheduleSchema,
  serviceKindValues,
  serviceStatusReasonValues,
  serviceStatusValues,
  stagedChangeSourceValues,
  stagedChangeStatusValues,
  staleReasonCodeValues,
  stationArchValues,
  StationCapabilities as StationCapabilitiesSchema,
  stationOsValues,
  stationStatusValues,
  strategyValues,
  StringEnum,
  tokenKindValues,
  tokenLevelValues,
  variableKindValues,
  variableScopeValues,
  versionSkewValues,
  volumeOwnerValues,
  volumeSnapshotSourceValues,
  volumeSnapshotStatusValues,
  volumeSnapshotTriggerValues,
  volumeStatusValues,
} from '@stationly/protocol'

import { explanationVerdicts, hopNames, hopStatuses } from '../net/explain-values.ts'
import { networkFindingValues } from '../net/findings.ts'
import { pathIdValues, pathVerdictValues } from '../net/paths.ts'

type Selectable<P extends TProperties, K extends keyof P> = TObject<{
  [X in keyof P]: X extends K ? P[X] : TOptional<P[X]>
}>

export const selectable = <P extends TProperties, const K extends keyof P & string>(
  title: string,
  properties: P,
  summary: readonly K[],
): Selectable<P, K> =>
  Type.Object(
    Object.fromEntries(
      Object.entries(properties).map(([key, schema]) => [
        key,
        (summary as readonly string[]).includes(key) ? schema : Type.Optional(schema),
      ]),
    ),
    {
      title,
      additionalProperties: false,
    },
  ) as unknown as Selectable<P, K>

const Definition = Symbol('definition')

export type Ref<T extends TSchema> = TUnsafe<Static<T>> & { readonly [Definition]: T }

const definitions: Record<string, TSchema> = {}

export const component = <T extends TSchema>(name: string, schema: T): Ref<T> => {
  if (name in definitions) throw new Error(`OpenAPI component ${name} is registered twice`)
  definitions[name] = {
    ...schema,
  }
  return Object.assign(Type.Ref(`#/components/schemas/${name}`), {
    [Definition]: schema,
  })
}

export const definitionOf = <T extends TSchema>(schema: T | Ref<T>): T =>
  Definition in schema ? schema[Definition] : schema

export const models = () =>
  new Elysia({
    name: 'stationly.models',
    normalize: false,
  }).model(definitions as unknown as Record<string, ReturnType<typeof t.Unknown>>)

export const extend = <S extends TObject, P extends TProperties>(
  schema: S | Ref<S>,
  properties: P,
) =>
  Type.Object<Omit<S['properties'], keyof P> & P>(
    {
      ...definitionOf(schema).properties,
      ...properties,
    },
    {
      additionalProperties: false,
    },
  )

type Literals<T extends readonly string[]> = { -readonly [K in keyof T]: TLiteral<T[K] & string> }

export const NullableEnum = <const T extends readonly string[]>(values: T) =>
  Type.Union([...values.map((value) => Type.Literal(value)), Type.Null()]) as unknown as TUnion<
    [...Literals<T>, TNull]
  >

const Str = Type.String()
const Time = Type.String()
const NStr = Nullable(Type.String())
const NTime = Nullable(Type.String())
const Int = Type.Integer()
const NInt = Nullable(Type.Integer())
const Bool = Type.Boolean()

const stamps = {
  id: Str,
  created_at: Time,
  updated_at: Time,
}

export const Actor = component('Actor', ActorSchema)

export const Diagnosis = component('Diagnosis', DiagnosisSchema)

const HealthCheck = component('HealthCheck', HealthCheckSchema)

const Schedule = component('Schedule', ScheduleSchema)

const Resources = component('Resources', ResourcesSchema)

const StationCapabilities = component('StationCapabilities', StationCapabilitiesSchema)

const BaseImage = component('BaseImage', BaseImageSchema)

export const Warning = component(
  'Warning',
  Type.Object(
    {
      code: Str,
      explanation: Str,
      details: Type.Optional(JsonObject),
    },
    {
      title: 'Warning',
      additionalProperties: false,
    },
  ),
)

export const Warnings = Type.Array(Warning)

export const ErrorEnvelope = component(
  'ErrorEnvelope',
  Type.Object(
    {
      error: Type.Composite([
        ErrorBody,
        Type.Object({
          request_id: Str,
        }),
      ]),
    },
    {
      title: 'ErrorEnvelope',
    },
  ),
)

const errorStatuses = [
  ...new Set(errorCatalog.flatMap((e) => (e.http === null ? [] : [e.http as number]))),
].sort((a, b) => a - b)

type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429 | 500 | 503 | 507

const documentedErrors = errorCatalog.filter((e) => e.http !== null)

export const ErrorCode = component(
  'ErrorCode',
  StringEnum(
    documentedErrors.map((e) => e.code),
    {
      description: documentedErrors.map((e) => `${e.code} ${e.http}`).join(', '),
    },
  ),
)

export const errorResponses = Object.fromEntries(
  errorStatuses.map((status) => [status, ErrorEnvelope]),
) as Record<ErrorStatus, typeof ErrorEnvelope>

type ElysiaTyped<S> = S extends TSchema ? ReturnType<typeof t.Unsafe<Static<S>>> : never

type Replies<R> = { [K in keyof R]: ElysiaTyped<R[K]> }

export const replies = <R extends Partial<Record<number, TSchema>>>(success: R) =>
  ({
    ...errorResponses,
    ...success,
  }) as unknown as Replies<typeof errorResponses & R>

export const Page = <T extends TSchema>(item: T) =>
  Type.Object(
    {
      items: Type.Array(item),
      next_cursor: NStr,
    },
    {
      additionalProperties: false,
    },
  )

export const Deleted = Type.Object(
  {
    deleted: Type.Literal(true),
  },
  {
    additionalProperties: false,
  },
)

export const DeletedRetaining = Type.Object(
  {
    deleted: Type.Literal(true),
    volumes_retained_until: NTime,
  },
  {
    additionalProperties: false,
  },
)

export const Scope = component(
  'Scope',
  Type.Object(
    {
      project_id: Str,
      environment_id: Str,
      level: StringEnum(tokenLevelValues),
    },
    {
      title: 'Scope',
    },
  ),
)

export const ServiceStatus = component(
  'ServiceStatus',
  StringEnum(serviceStatusValues, {
    title: 'ServiceStatus',
  }),
)

export const StaleReason = component(
  'StaleReason',
  Type.Object(
    {
      code: StringEnum(staleReasonCodeValues),
      explanation: Str,
      keys: Type.Array(Str),
    },
    {
      title: 'StaleReason',
      additionalProperties: false,
    },
  ),
)

export const DeploymentStatus = component(
  'DeploymentStatus',
  StringEnum(deploymentStatusValues, {
    title: 'DeploymentStatus',
  }),
)

const failureOf = <K extends keyof (typeof DiagnosisSchema)['properties']>(
  required: readonly K[],
) =>
  Type.Object({
    ...Type.Partial(DiagnosisSchema).properties,
    ...Type.Pick(DiagnosisSchema, required).properties,
  })

export const Change = component(
  'Change',
  Type.Object(
    {
      op: StringEnum(['add', 'update', 'remove']),
      entity: Str,
      id: Type.Optional(Str),
      ref: Type.Optional(Str),
      parent: Type.Optional(NStr),
      path: Type.Optional(Str),
      before: Type.Unknown(),
      after: Type.Unknown(),
    },
    {
      title: 'Change',
    },
  ),
)

export const DeploymentStep = component(
  'DeploymentStep',
  Type.Object(
    {
      id: Str,
      step: StringEnum(deploymentStepNameValues),
      status: StringEnum(deploymentStepStatusValues),
      attempt: Int,
      detail: JsonObject,
      started_at: NTime,
      finished_at: NTime,
    },
    {
      title: 'DeploymentStep',
      additionalProperties: false,
    },
  ),
)

export const BuildSummary = component(
  'BuildSummary',
  Type.Object(
    {
      id: Str,
      deployment_id: Str,
      builder: StringEnum(builderValues),
      status: StringEnum(buildStatusValues),
      duration_s: NInt,
      source: JsonObject,
      failure: Nullable(Diagnosis),
    },
    {
      title: 'BuildSummary',
      additionalProperties: false,
    },
  ),
)

export const EnvSnapshotEntry = component(
  'EnvSnapshotEntry',
  Type.Object(
    {
      key: Str,
      variable_id: Str,
      sealed: Bool,
      values: Type.Array(
        Type.Object({
          secret_value_id: Str,
          version: Int,
        }),
      ),
    },
    {
      title: 'EnvSnapshotEntry',
      additionalProperties: false,
    },
  ),
)

export const BaseImageRecord = component(
  'BaseImageRecord',
  Type.Object(
    {
      ...BaseImageSchema.properties,
      check: StringEnum(baseImageCheckValues),
      checked_at: Type.Optional(NTime),
      latest_digest: Type.Optional(NStr),
    },
    {
      title: 'BaseImageRecord',
    },
  ),
)

export const Deployment = component(
  'Deployment',
  selectable(
    'Deployment',
    {
      ...stamps,
      service_id: Str,
      number: Int,
      status: DeploymentStatus,
      trigger: Type.Object({
        type: StringEnum(deploymentTriggerValues),
        source_sha: NStr,
        actor: Type.Optional(Actor),
        rollback_of: Type.Optional(NStr),
      }),
      image_ref: NStr,
      image_pruned_at: NTime,
      build_id: NStr,
      strategy: StringEnum(strategyValues),
      cancel_reason: NullableEnum(cancelReasonValues),
      started_at: NTime,
      finished_at: NTime,
      failure: Nullable(component('DeploymentFailure', failureOf(['code', 'summary']))),
      steps: Type.Array(DeploymentStep),
      build: Nullable(BuildSummary),
      env_snapshot: Type.Array(EnvSnapshotEntry),
      config_snapshot: JsonObject,
      base_images: Type.Array(BaseImageRecord),
    },
    [
      'id',
      'service_id',
      'number',
      'status',
      'trigger',
      'image_ref',
      'strategy',
      'cancel_reason',
      'started_at',
      'finished_at',
    ],
  ),
)

export const Certificate = component(
  'Certificate',
  Type.Object(
    {
      status: Str,
      expires_at: NStr,
      resolver: Type.Optional(Str),
      not_before: Type.Optional(NStr),
    },
    {
      title: 'Certificate',
    },
  ),
)

export const DnsInstruction = component(
  'DnsInstruction',
  Type.Object(
    {
      type: Str,
      name: Str,
      value: NStr,
      note: Str,
    },
    {
      title: 'DnsInstruction',
      additionalProperties: false,
    },
  ),
)

export const Domain = component(
  'Domain',
  selectable(
    'Domain',
    {
      ...stamps,
      service_port_id: Str,
      hostname: Str,
      kind: StringEnum(domainKindValues),
      ingress: StringEnum(ingressValues),
      status: StringEnum(domainStatusValues),
      certificate: Certificate,
      last_checked_at: NTime,
      dns_instructions: Type.Array(DnsInstruction),
      error: Nullable(Diagnosis),
    },
    ['id', 'service_port_id', 'hostname', 'kind', 'ingress', 'status', 'certificate'],
  ),
)

export const PortAllocation = component(
  'PortAllocation',
  selectable(
    'PortAllocation',
    {
      ...stamps,
      service_port_id: Str,
      station_id: Str,
      host_port: Int,
      status: StringEnum(portAllocationStatusValues),
      address: NStr,
    },
    ['id', 'service_port_id', 'station_id', 'host_port', 'status', 'address'],
  ),
)

export const ServicePort = component(
  'ServicePort',
  selectable(
    'ServicePort',
    {
      ...stamps,
      service_id: Str,
      port: Int,
      protocol: StringEnum(portProtocolValues),
      grpc: Bool,
      domains: Type.Array(Domain),
      port_allocations: Type.Array(PortAllocation),
    },
    ['id', 'service_id', 'port', 'protocol', 'grpc'],
  ),
)

export const BackupTargetShape = Type.Union([
  Type.Object(
    {
      type: Type.Literal('path'),
      path: Type.String({
        minLength: 1,
      }),
    },
    {
      additionalProperties: false,
    },
  ),
  Type.Object(
    {
      type: Type.Literal('s3'),
      endpoint: Type.String({
        minLength: 1,
      }),
      bucket: Type.String({
        minLength: 1,
      }),
      prefix: Type.String(),
      credentials_variable: Type.String({
        minLength: 1,
      }),
    },
    {
      additionalProperties: false,
    },
  ),
])

export const VolumeSnapshot = component(
  'VolumeSnapshot',
  Type.Object(
    {
      id: Str,
      volume_id: Str,
      station_id: NStr,
      taken_at: Time,
      finished_at: NTime,
      location: Str,
      objects: Nullable(
        Type.Object({
          archive: Str,
          metadata: Str,
        }),
      ),
      target: Nullable(BackupTargetShape),
      size_bytes: Int,
      archive_bytes: NInt,
      sha256: NStr,
      consistent: Nullable(Bool),
      source: StringEnum(volumeSnapshotSourceValues),
      trigger: StringEnum(volumeSnapshotTriggerValues),
      status: StringEnum(volumeSnapshotStatusValues),
      failure: Nullable(JsonObject),
    },
    {
      title: 'VolumeSnapshot',
      additionalProperties: false,
    },
  ),
)

export const Volume = component(
  'Volume',
  selectable(
    'Volume',
    {
      ...stamps,
      owner: StringEnum(volumeOwnerValues),
      service_id: NStr,
      station_id: Str,
      mount_path: Str,
      docker_name: Str,
      size_bytes: Int,
      status: StringEnum(volumeStatusValues),
      retain_until: NTime,
      backups: Type.Array(VolumeSnapshot),
    },
    [
      'id',
      'owner',
      'service_id',
      'station_id',
      'mount_path',
      'size_bytes',
      'status',
      'retain_until',
    ],
  ),
)

export const SecretValue = component(
  'SecretValue',
  selectable(
    'SecretValue',
    {
      id: Str,
      variable_id: Str,
      environment_id: NStr,
      version: Int,
      bytes: NInt,
      created_by: Actor,
      created_at: Time,
      revoked_at: NTime,
      needs_reentry: Bool,
      pinned_by: Int,
    },
    [
      'id',
      'variable_id',
      'environment_id',
      'version',
      'bytes',
      'created_by',
      'created_at',
      'revoked_at',
      'needs_reentry',
      'pinned_by',
    ],
  ),
)

export const VariableKind = component(
  'VariableKind',
  StringEnum(variableKindValues, {
    title: 'VariableKind',
  }),
)

export const Variable = component(
  'Variable',
  selectable(
    'Variable',
    {
      ...stamps,
      scope: StringEnum(variableScopeValues),
      project_id: NStr,
      service_id: NStr,
      sandbox_id: NStr,
      key: Str,
      kind: VariableKind,
      reference: NStr,
      injection: StringEnum(injectionValues),
      build: Bool,
      head_version: NInt,
      bytes: NInt,
      sealed: Bool,
      value: Type.Null(),
      environments: Type.Array(Str),
      versions: Type.Array(SecretValue),
    },
    ['id', 'scope', 'key', 'kind', 'reference', 'injection', 'build', 'head_version', 'bytes'],
  ),
)

const repoSource = {
  repo: Str,
  branch: Str,
  path: Type.Optional(Str),
  auth: NullableEnum(repoAuthValues),
}

export const ServiceSource = component(
  'ServiceSource',
  Type.Union(
    [
      Type.Object({
        type: Type.Literal('image'),
        ref: Str,
        digest: Str,
      }),
      Type.Object({
        type: Type.Literal('dockerfile'),
        ...repoSource,
        dockerfile: Type.Optional(Str),
      }),
      Type.Object({
        type: Type.Literal('railpack'),
        ...repoSource,
      }),
      Type.Object({
        type: Type.Literal('local'),
        path: Type.Optional(Str),
        dockerfile: Type.Optional(Str),
      }),
      Type.Object({
        type: Type.Literal('template'),
        template_version_id: Str,
      }),
    ],
    {
      title: 'ServiceSource',
    },
  ),
)

export const Export = component(
  'Export',
  Type.Object(
    {
      key: Str,
      value: Str,
    },
    {
      title: 'Export',
      additionalProperties: false,
    },
  ),
)

export const Service = component(
  'Service',
  selectable(
    'Service',
    {
      ...stamps,
      environment_id: Str,
      name: Str,
      kind: StringEnum(serviceKindValues),
      station_id: Str,
      source: ServiceSource,
      command: Nullable(Type.Array(Str)),
      build_args: Nullable(Type.Record(Str, Str)),
      limits: Type.Object({
        cpu_millis: Int,
        memory_bytes: Int,
      }),
      health: Nullable(HealthCheck),
      strategy: StringEnum(strategyValues),
      multi_writer_safe: Bool,
      drain_timeout_s: Int,
      readonly_rootfs: Bool,
      secrets_owner: Nullable(
        Type.Object({
          uid: Int,
          gid: Int,
        }),
      ),
      best_effort: Bool,
      pre_deploy: Nullable(Type.Array(Str)),
      schedule: Nullable(Schedule),
      current_deployment_id: NStr,
      status: ServiceStatus,
      status_reason: NullableEnum(serviceStatusReasonValues),
      desired_state: StringEnum(desiredStateValues),
      stale: Bool,
      stale_reasons: Type.Array(StaleReason),
      ports: Type.Array(ServicePort),
      volumes: Type.Array(Volume),
      domains: Type.Array(Domain),
      port_allocations: Type.Array(PortAllocation),
      current_deployment: Nullable(Deployment),
      variables: Type.Array(Variable),
      exports: Type.Array(Export),
    },
    [
      'id',
      'environment_id',
      'name',
      'kind',
      'status',
      'status_reason',
      'desired_state',
      'station_id',
      'source',
      'current_deployment_id',
      'stale',
      'stale_reasons',
    ],
  ),
)

export const Edge = component(
  'Edge',
  Type.Object(
    {
      from_service: Str,
      to_service: Str,
      keys: Type.Array(Str),
    },
    {
      title: 'Edge',
      additionalProperties: false,
    },
  ),
)

export const PullRequest = component(
  'PullRequest',
  Type.Object(
    {
      repo: Str,
      number: Int,
      head_sha: Str,
      fork: Bool,
    },
    {
      title: 'PullRequest',
    },
  ),
)

export const Environment = component(
  'Environment',
  selectable(
    'Environment',
    {
      ...stamps,
      project_id: Str,
      name: Str,
      protected: Bool,
      ephemeral: Bool,
      source_environment_id: NStr,
      pull_request: Nullable(PullRequest),
      ttl_seconds: NInt,
      service_count: Int,
      pending_staged_changes: Int,
      services: Type.Array(Service),
      edges: Type.Array(Edge),
    },
    [
      'id',
      'project_id',
      'name',
      'protected',
      'ephemeral',
      'ttl_seconds',
      'pull_request',
      'service_count',
      'pending_staged_changes',
    ],
  ),
)

export const StatusCounts = component(
  'StatusCounts',
  Type.Object(
    Object.fromEntries(serviceStatusValues.map((s) => [s, Int])) as Record<
      (typeof serviceStatusValues)[number],
      typeof Int
    >,
    {
      title: 'StatusCounts',
      additionalProperties: false,
    },
  ),
)

export const Project = component(
  'Project',
  selectable(
    'Project',
    {
      ...stamps,
      name: Str,
      shared: Bool,
      manifest_path: NStr,
      default_environment_id: Str,
      build_cache_bytes: Int,
      workshop_uid_base: Int,
      image_retention_count: Int,
      base_image_auto_rebuild: Bool,
      pr_environments: Type.Object({
        enabled: Bool,
        source_environment_id: NStr,
      }),
      environment_count: Int,
      service_count: Int,
      status_counts: StatusCounts,
      environments: Type.Array(Environment),
      variables: Type.Array(Variable),
    },
    ['id', 'name', 'default_environment_id', 'environment_count', 'service_count', 'status_counts'],
  ),
)

export const StagedChange = component(
  'StagedChange',
  selectable(
    'StagedChange',
    {
      ...stamps,
      environment_id: NStr,
      status: StringEnum(stagedChangeStatusValues),
      source: StringEnum(stagedChangeSourceValues),
      actor: Actor,
      accepted_by: Nullable(Actor),
      summary: Type.Object(
        {
          add: Int,
          update: Int,
          remove: Int,
          deployments: Int,
        },
        {
          additionalProperties: false,
        },
      ),
      changes: Type.Array(Change),
      refs: Type.Record(Str, Str),
      deployments: Type.Array(Str),
    },
    ['id', 'environment_id', 'status', 'source', 'actor', 'created_at', 'summary'],
  ),
)

export const DeploymentCreated = component(
  'DeploymentCreated',
  extend(Deployment, {
    warnings: Warnings,
  }),
)

export const Staged = component(
  'Staged',
  extend(StagedChange, {
    changes: Type.Array(Change),
    refs: Type.Record(Str, Str),
    deployments: Type.Array(Str),
  }),
)

export const Token = component(
  'Token',
  selectable(
    'Token',
    {
      ...stamps,
      name: Str,
      kind: StringEnum(tokenKindValues),
      scopes: Type.Array(Scope),
      expires_at: Time,
      last_used_at: NTime,
      client_id: NStr,
      station_id: NStr,
      used_at: NTime,
    },
    ['id', 'name', 'kind', 'scopes', 'expires_at', 'last_used_at', 'client_id'],
  ),
)

export const Component = component(
  'Component',
  Type.Object(
    {
      name: StringEnum(componentNameValues),
      station_id: NStr,
      version: Str,
      digest: NStr,
      lockfile_version: Str,
      lockfile_digest: NStr,
      status: StringEnum(componentStatusValues),
    },
    {
      title: 'Component',
      additionalProperties: false,
    },
  ),
)

export const Station = component(
  'Station',
  selectable(
    'Station',
    {
      ...stamps,
      name: Str,
      status: StringEnum(stationStatusValues),
      draining: Bool,
      os: NullableEnum(stationOsValues),
      arch: NullableEnum(stationArchValues),
      version_skew: StringEnum(versionSkewValues),
      last_seen_at: NTime,
      concurrency_cap: Int,
      resources: Nullable(Resources),
      intermittent: Bool,
      public_address: NStr,
      sandbox_subnet: NStr,
      sandbox_limits: component('SandboxLimits', SandboxLimitsSchema),
      sandbox_memory: Type.Object({
        limit: Nullable(Int),
        used: Int,
        free: Nullable(Int),
      }),
      registry_address: NStr,
      hosts_dispatch: Bool,
      generation: Int,
      revoked_at: NTime,
      capabilities: Nullable(StationCapabilities),
      routes: Type.Unknown(),
      generation_failure: Nullable(
        Type.Object({
          generation: Int,
          ack: NullableEnum(appliedStatusValues),
          failure: Nullable(ErrorBody),
        }),
      ),
      components: Type.Array(Component),
    },
    [
      'id',
      'name',
      'status',
      'draining',
      'os',
      'arch',
      'version_skew',
      'last_seen_at',
      'concurrency_cap',
      'resources',
    ],
  ),
)

export const Attestation = component(
  'Attestation',
  Type.Object(
    {
      id: Str,
      kind: StringEnum(attestationKindValues),
      platform: Str,
      digest: NStr,
      predicate_ref: Str,
      base_images: Type.Array(BaseImage),
    },
    {
      title: 'Attestation',
      additionalProperties: false,
    },
  ),
)

export const Build = component(
  'Build',
  selectable(
    'Build',
    {
      ...stamps,
      deployment_id: Str,
      project_id: Str,
      builder: StringEnum(builderValues),
      status: StringEnum(buildStatusValues),
      duration_s: NInt,
      source: Type.Object({
        sha: NStr,
      }),
      image_ref: NStr,
      index_digest: NStr,
      railpack_version: NStr,
      log_ref: Str,
      failure: Nullable(component('BuildFailure', failureOf(['code']))),
      detail: JsonObject,
      attestations: Type.Array(Attestation),
    },
    ['id', 'deployment_id', 'builder', 'status', 'duration_s', 'source'],
  ),
)

export const SandboxRunOutput = component(
  'SandboxRunOutput',
  Type.Object(
    {
      untrusted: Type.Object(
        {
          source: Type.Literal('sandbox exec output'),
          text: Str,
        },
        {
          additionalProperties: false,
        },
      ),
      truncated: Bool,
      cursor: NStr,
    },
    {
      title: 'SandboxRunOutput',
      additionalProperties: false,
    },
  ),
)

export const Run = component(
  'Run',
  selectable(
    'Run',
    {
      ...stamps,
      service_id: NStr,
      sandbox_id: NStr,
      deployment_id: NStr,
      kind: StringEnum(runKindValues),
      command: Type.Array(Str),
      status: StringEnum(runStatusValues),
      exit_code: NInt,
      tty: Bool,
      log_ref: Str,
      started_at: NTime,
      finished_at: NTime,
      failure: Nullable(Diagnosis),
      output: SandboxRunOutput,
    },
    [
      'id',
      'service_id',
      'sandbox_id',
      'deployment_id',
      'kind',
      'command',
      'status',
      'exit_code',
      'started_at',
      'finished_at',
    ],
  ),
)

export const Delivery = component(
  'Delivery',
  Type.Object(
    {
      status: StringEnum(['pending', 'delivered', 'failed', 'skipped']),
      attempts: Int,
      last_error: NStr,
      delivered_at: NTime,
      next_at: NTime,
    },
    {
      title: 'Delivery',
    },
  ),
)

export const EntityTarget = component(
  'EntityTarget',
  Type.Object(
    {
      entity: Str,
      id: Str,
    },
    {
      title: 'EntityTarget',
    },
  ),
)

export const Event = component(
  'Event',
  selectable(
    'Event',
    {
      id: Str,
      type: Str,
      subject: EntityTarget,
      payload: JsonObject,
      created_at: Time,
      delivered: Type.Record(Str, Delivery),
    },
    ['id', 'type', 'subject', 'payload', 'created_at'],
  ),
)

export const NotificationChannel = component(
  'NotificationChannel',
  selectable(
    'NotificationChannel',
    {
      ...stamps,
      kind: StringEnum(notificationChannelKindValues),
      filter: JsonObject,
      status: StringEnum(notificationChannelStatusValues),
      failing_since: NTime,
      config: JsonObject,
    },
    ['id', 'kind', 'filter', 'status', 'failing_since'],
  ),
)

export const AuditEvent = component(
  'AuditEvent',
  selectable(
    'AuditEvent',
    {
      id: Str,
      created_at: Time,
      actor: Actor,
      action: Str,
      target: EntityTarget,
      request_id: Str,
      before: Nullable(JsonObject),
      after: Nullable(JsonObject),
      purpose: NStr,
      idempotency_key: NStr,
    },
    ['id', 'created_at', 'actor', 'action', 'target', 'request_id'],
  ),
)

const SwitchDeployment = Type.Object(
  {
    id: Str,
    number: Int,
    address: NStr,
  },
  {
    additionalProperties: false,
  },
)

const ObjectResult = NullableEnum(['ok', 'pending', 'failed', 'blocked'])

export const NetworkFinding = component(
  'NetworkFinding',
  Type.Object(
    {
      code: StringEnum(networkFindingValues),
      explanation: Str,
      details: Type.Optional(JsonObject),
    },
    {
      title: 'NetworkFinding',
      additionalProperties: false,
    },
  ),
)

export const NetworkMap = component(
  'NetworkMap',
  Type.Object(
    {
      environment: Type.Object(
        {
          id: Str,
          name: Str,
          project_id: Str,
        },
        {
          additionalProperties: false,
        },
      ),
      computed_at: Time,
      virtual_prefix: Str,
      subnets: Type.Array(
        Type.Object(
          {
            station: Type.Object(
              {
                id: Str,
                name: Str,
              },
              {
                additionalProperties: false,
              },
            ),
            subnet: Str,
            gateway: Str,
            resolver: Str,
            bridge: Type.Optional(Str),
            observed_at: NTime,
            stale: Bool,
          },
          {
            additionalProperties: false,
          },
        ),
      ),
      services: Type.Array(
        Type.Object(
          {
            id: Str,
            name: Str,
            kind: StringEnum(serviceKindValues),
            status: ServiceStatus,
            station_id: Str,
            dns: Str,
            virtual_ip: NStr,
            ports: Type.Array(
              Type.Object(
                {
                  port: Int,
                  protocol: StringEnum(portProtocolValues),
                  grpc: Bool,
                },
                {
                  additionalProperties: false,
                },
              ),
            ),
            switch: Type.Object(
              {
                state: StringEnum(['serving', 'no_target', 'pending', 'mismatch']),
                deployment: Nullable(SwitchDeployment),
                draining: Nullable(
                  Type.Object(
                    {
                      id: Str,
                      number: Int,
                      address: NStr,
                      since: NTime,
                    },
                    {
                      additionalProperties: false,
                    },
                  ),
                ),
              },
              {
                additionalProperties: false,
              },
            ),
            domains: Type.Array(
              Type.Object(
                {
                  id: Str,
                  service_port_id: Str,
                  hostname: Str,
                  kind: StringEnum(domainKindValues),
                  ingress: StringEnum(ingressValues),
                  status: StringEnum(domainStatusValues),
                  certificate: Type.Object(
                    {
                      status: Str,
                      expires_at: NStr,
                    },
                    {
                      additionalProperties: false,
                    },
                  ),
                  port: Int,
                  route: Type.Object(
                    {
                      entrypoint: StringEnum(['websecure', 'web']),
                      target: NStr,
                      result: ObjectResult,
                    },
                    {
                      additionalProperties: false,
                    },
                  ),
                },
                {
                  additionalProperties: false,
                },
              ),
            ),
            exposures: Type.Array(
              Type.Object(
                {
                  id: Str,
                  service_port_id: Str,
                  station_id: Str,
                  host_port: Int,
                  status: StringEnum(portAllocationStatusValues),
                  address: NStr,
                  public: NStr,
                  port: Int,
                  result: ObjectResult,
                },
                {
                  additionalProperties: false,
                },
              ),
            ),
          },
          {
            additionalProperties: false,
          },
        ),
      ),
      sandboxes: Type.Array(
        Type.Object(
          {
            id: Str,
            name: Str,
            status: StringEnum(sandboxStatusValues),
            station_id: Str,
            address: NStr,
            egress: Type.Object(
              {
                mode: StringEnum(sandboxEgressModeValues),
                domains: Type.Array(
                  Type.Object(
                    {
                      domain: Str,
                      wildcard: Bool,
                      ports: Type.Array(Int),
                    },
                    {
                      additionalProperties: false,
                    },
                  ),
                ),
              },
              {
                additionalProperties: false,
              },
            ),
          },
          {
            additionalProperties: false,
          },
        ),
      ),
      edges: Type.Array(
        Type.Object(
          {
            from: Str,
            to: Str,
            kind: Type.Literal('reference'),
            keys: Type.Array(Str),
          },
          {
            additionalProperties: false,
          },
        ),
      ),
      inbound: Type.Object(
        {
          web_ports: StringEnum(['open', 'closed']),
          public_address: NStr,
          entries: Type.Array(
            Type.Union([
              Type.Object(
                {
                  kind: Type.Literal('domain'),
                  hostname: Str,
                  service: Str,
                  port: Int,
                },
                {
                  additionalProperties: false,
                },
              ),
              Type.Object(
                {
                  kind: Type.Literal('tcp'),
                  public: NStr,
                  service: Str,
                  port: Int,
                },
                {
                  additionalProperties: false,
                },
              ),
            ]),
          ),
        },
        {
          additionalProperties: false,
        },
      ),
      paths: Type.Array(
        Type.Object(
          {
            path: StringEnum(pathIdValues),
            from: StringEnum(['every service', 'internet', 'a sandbox']),
            to: Str,
            verdict: StringEnum(pathVerdictValues),
            rule: Type.Optional(Str),
          },
          {
            additionalProperties: false,
          },
        ),
      ),
      warnings: Type.Array(NetworkFinding),
    },
    {
      title: 'NetworkMap',
      additionalProperties: false,
    },
  ),
)

export const NetworkConnections = component(
  'NetworkConnections',
  Type.Object(
    {
      service: Type.Object(
        {
          id: Str,
          name: Str,
        },
        {
          additionalProperties: false,
        },
      ),
      deployment_id: NStr,
      at: Time,
      conntrack: Type.Object(
        {
          entries: NInt,
          truncated: Bool,
          stale: Bool,
          lossy: Bool,
          accounting: Bool,
          timestamps: Bool,
        },
        {
          additionalProperties: false,
        },
      ),
      connections: Type.Array(
        Type.Object(
          {
            direction: StringEnum(['in', 'out']),
            peer: Type.Object(
              {
                kind: StringEnum(networkPeerKinds),
                service: Type.Optional(Str),
                service_id: Type.Optional(Str),
                sandbox: Type.Optional(Str),
                sandbox_id: Type.Optional(Str),
                deployment_id: Type.Optional(NStr),
                address: Type.Optional(Str),
              },
              {
                additionalProperties: false,
              },
            ),
            port: Int,
            protocol: StringEnum(['tcp', 'udp']),
            flows: Int,
            established: Int,
            bytes_out: NInt,
            bytes_in: NInt,
            bps_out: NInt,
            bps_in: NInt,
            counters_age_s: NInt,
            oldest_s: NInt,
          },
          {
            additionalProperties: false,
          },
        ),
      ),
      refused: Type.Array(
        Type.Object(
          {
            path: StringEnum(refusedPaths),
            address: Str,
            port: Int,
            protocol: StringEnum(['tcp', 'udp', 'icmp', 'other']),
            count: Int,
            expires_in_s: Int,
          },
          {
            additionalProperties: false,
          },
        ),
      ),
      refused_truncated: Bool,
      untrusted: Type.Object(
        {
          source: Type.Literal('resolver answers'),
          names: Type.Record(Str, Str),
        },
        {
          additionalProperties: false,
        },
      ),
    },
    {
      title: 'NetworkConnections',
      additionalProperties: false,
    },
  ),
)

const NetworkFix = Type.Object(
  {
    code: Str,
    text: Str,
    action: Type.Optional(
      Type.Object(
        {
          tool: Str,
          input: JsonObject,
        },
        {
          additionalProperties: false,
        },
      ),
    ),
  },
  {
    additionalProperties: false,
  },
)

export const NetworkExplanation = component(
  'NetworkExplanation',
  Type.Object(
    {
      entity: Type.Object(
        {
          type: Type.Literal('path'),
          from: Str,
          to: Str,
        },
        {
          additionalProperties: false,
        },
      ),
      verdict: StringEnum(explanationVerdicts),
      phase: Nullable(StringEnum(hopNames)),
      code: Nullable(StringEnum(networkFindingValues)),
      summary: Str,
      details: Type.Optional(JsonObject),
      hops: Type.Array(
        Type.Object(
          {
            hop: StringEnum(hopNames),
            status: StringEnum(hopStatuses),
            code: Type.Optional(StringEnum(networkFindingValues)),
            detail: JsonObject,
          },
          {
            additionalProperties: false,
          },
        ),
      ),
      fixes: Type.Array(NetworkFix),
      not_checked: Type.Array(Str),
      observed_at: NTime,
    },
    {
      title: 'NetworkExplanation',
      additionalProperties: false,
    },
  ),
)

const probeShape = {
  kind: StringEnum(probeKinds),
  to: Str,
  port: NInt,
  dns: Type.Optional(
    Type.Object(
      {
        rcode: Str,
        answers: Type.Array(Str),
        ms: Type.Number(),
      },
      {
        additionalProperties: false,
      },
    ),
  ),
  tcp: Type.Optional(
    Type.Object(
      {
        address: NStr,
        result: StringEnum(probeTcpResults),
        ms: Type.Number(),
      },
      {
        additionalProperties: false,
      },
    ),
  ),
  verdict: Type.Optional(
    Type.Object(
      {
        verdict: StringEnum(networkVerdicts),
        path: StringEnum(networkPathIds),
      },
      {
        additionalProperties: false,
      },
    ),
  ),
  at: Time,
}

export const NetworkProbe = component(
  'NetworkProbe',
  Type.Object(
    {
      service: Str,
      ...probeShape,
    },
    {
      title: 'NetworkProbe',
      additionalProperties: false,
    },
  ),
)

export const SandboxNetworkProbe = component(
  'SandboxNetworkProbe',
  Type.Object(
    {
      sandbox: Str,
      ...probeShape,
    },
    {
      title: 'SandboxNetworkProbe',
      additionalProperties: false,
    },
  ),
)

export const DnsLog = component(
  'DnsLog',
  Type.Object(
    {
      untrusted: Type.Object(
        {
          source: Type.Literal('resolver log'),
          entries: Type.Array(
            Type.Object(
              {
                at: Time,
                deployment_id: NStr,
                name: Str,
                type: Str,
                rcode: Str,
                answers: Type.Array(Str),
                upstream: Bool,
                ms: Type.Number(),
                probe: Bool,
                refused: Type.Optional(NStr),
              },
              {
                additionalProperties: false,
              },
            ),
          ),
        },
        {
          additionalProperties: false,
        },
      ),
    },
    {
      title: 'DnsLog',
      additionalProperties: false,
    },
  ),
)

export const SandboxSize = component('SandboxSize', SandboxSizeSchema)

export const SandboxStatus = component(
  'SandboxStatus',
  StringEnum(sandboxStatusValues, {
    title: 'SandboxStatus',
  }),
)

export const SandboxImage = component(
  'SandboxImage',
  Type.Object(
    {
      ref: NStr,
      digest: Str,
    },
    {
      title: 'SandboxImage',
      additionalProperties: false,
    },
  ),
)

const SandboxEgressView = Type.Object(
  {
    mode: StringEnum(sandboxEgressModeValues),
    domains: Type.Optional(Type.Array(component('SandboxEgressDomain', SandboxEgressDomainSchema))),
  },
  {
    additionalProperties: false,
  },
)

const SandboxForkedFrom = Type.Object(
  {
    sandbox_id: NStr,
    snapshot_id: NStr,
  },
  {
    additionalProperties: false,
  },
)

export const SandboxSnapshot = component(
  'SandboxSnapshot',
  selectable(
    'SandboxSnapshot',
    {
      ...stamps,
      sandbox_id: Str,
      environment_id: Str,
      station_id: Str,
      name: NStr,
      status: StringEnum(sandboxSnapshotStatusValues),
      source_state: StringEnum(sandboxSourceStateValues),
      taken_at: NTime,
      exclusive_bytes: Int,
      referenced_bytes: Int,
      image: SandboxImage,
      size: SandboxSize,
      failure: Nullable(Diagnosis),
    },
    [
      'id',
      'sandbox_id',
      'environment_id',
      'station_id',
      'name',
      'status',
      'source_state',
      'taken_at',
      'exclusive_bytes',
      'referenced_bytes',
    ],
  ),
)

export const SandboxMetricSample = component(
  'SandboxMetricSample',
  Type.Object(
    {
      sandbox_id: Str,
      container_id: Str,
      at: Time,
      cpu_pct: Type.Number(),
      memory_bytes: Int,
      memory_limit_bytes: Int,
      net_rx_bps: Int,
      net_tx_bps: Int,
      blk_read_bps: Int,
      blk_write_bps: Int,
      disk_used_bytes: Type.Optional(Int),
      disk_limit_bytes: Type.Optional(Int),
    },
    {
      title: 'SandboxMetricSample',
      additionalProperties: false,
    },
  ),
)

export const Sandbox = component(
  'Sandbox',
  selectable(
    'Sandbox',
    {
      ...stamps,
      environment_id: Str,
      station_id: Str,
      name: Str,
      status: SandboxStatus,
      status_reason: NullableEnum(sandboxStatusReasonValues),
      desired_state: StringEnum(desiredStateValues),
      image: SandboxImage,
      size: SandboxSize,
      network: StringEnum(sandboxNetworkValues),
      docker: Bool,
      egress: SandboxEgressView,
      ttl_s: Int,
      stop_at: NTime,
      delete_at: NTime,
      address: NStr,
      disk_used_bytes: Int,
      forked_from: Nullable(SandboxForkedFrom),
      command: Nullable(Type.Array(Str)),
      exit_code: NInt,
      failure: Nullable(Diagnosis),
      started_at: NTime,
      stopped_at: NTime,
      snapshots: Type.Array(SandboxSnapshot),
      runs: Type.Array(Run),
      metrics: Nullable(SandboxMetricSample),
      variables: Type.Array(JsonObject),
    },
    [
      'id',
      'environment_id',
      'station_id',
      'name',
      'status',
      'status_reason',
      'desired_state',
      'image',
      'size',
      'network',
      'docker',
      'egress',
      'ttl_s',
      'stop_at',
      'delete_at',
      'address',
      'disk_used_bytes',
      'forked_from',
      'created_at',
    ],
  ),
)

export const SandboxCreated = component(
  'SandboxCreated',
  extend(Sandbox, {
    warnings: Warnings,
  }),
)

export const SandboxDeleted = component(
  'SandboxDeleted',
  Type.Object(
    {
      deleted: Type.Literal(true),
      snapshots_kept: Int,
    },
    {
      title: 'SandboxDeleted',
      additionalProperties: false,
    },
  ),
)

export const SandboxSnapshotCreated = component(
  'SandboxSnapshotCreated',
  extend(SandboxSnapshot, {
    warnings: Warnings,
  }),
)

export const SandboxConnections = component(
  'SandboxConnections',
  Type.Object<TProperties>(
    {
      sandbox: Type.Object(
        {
          id: Str,
          name: Str,
        },
        {
          additionalProperties: false,
        },
      ),
      ...Object.fromEntries(
        Object.entries(definitionOf(NetworkConnections).properties).filter(
          ([key]) => key !== 'service' && key !== 'deployment_id',
        ),
      ),
    },
    {
      title: 'SandboxConnections',
      additionalProperties: false,
    },
  ),
)

export const StorageGrown = component(
  'StorageGrown',
  Type.Object(
    {
      filesystem_bytes: Int,
      filesystem_free_bytes: Int,
    },
    {
      title: 'StorageGrown',
      additionalProperties: false,
    },
  ),
)

export const SandboxExec = component(
  'SandboxExec',
  extend(Run, {
    attach_url: Type.Optional(Str),
  }),
)

export const SandboxShell = component(
  'SandboxShell',
  extend(Run, {
    tty: Bool,
    attach_url: Str,
  }),
)

export const SandboxVariablesOutcome = component(
  'SandboxVariablesOutcome',
  Type.Object(
    {
      variables: Type.Array(Variable),
    },
    {
      title: 'SandboxVariablesOutcome',
      additionalProperties: false,
    },
  ),
)

export const SandboxSnapshotDeleted = component(
  'SandboxSnapshotDeleted',
  Type.Object(
    {
      deleted: Type.Literal(true),
    },
    {
      title: 'SandboxSnapshotDeleted',
      additionalProperties: false,
    },
  ),
)
