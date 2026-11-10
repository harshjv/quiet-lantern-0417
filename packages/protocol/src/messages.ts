import { Type, type Static, type TSchema } from '@sinclair/typebox'

import { EnvRef, Generation } from './desired-state.ts'
import {
  Actor,
  AppliedGeneration,
  AppliedStatus,
  AttestationKind,
  BaseImage,
  BlobGrant,
  Builder,
  BuildStatus,
  CancelReason,
  ComponentStatus,
  DeploymentOutcome,
  DeploymentStepName,
  DeploymentStepStatus,
  Diagnosis,
  doctorStatusValues,
  EntityRef,
  ErrorBody,
  FlowRollupRow,
  Injection,
  ListeningSocket,
  Resources,
  RunKind,
  RunRow,
  RunStatus,
  SandboxReportStatus,
  SandboxStatusReason,
  ServiceHealth,
  StationArch,
  StationCapabilities,
  StationOs,
  StationRoutes,
  StatusHint,
  VersionSkew,
  volumeOwnerValues,
} from './model.ts'
import { Observed, ObservedUpdate } from './observed-state.ts'
import {
  Base64UrlBytes32,
  Base64UrlBytes64,
  Bytes,
  Count,
  Digest,
  Id,
  Json,
  JsonObject,
  Nullable,
  Port,
  Seconds,
  StringEnum,
  Timestamp,
  UnixMillis,
} from './primitives.ts'
import { PlatformVerifyBody, PlatformVerifyResultBody, SignatureState } from './release.ts'

export const subprotocol = 'stationly.station.v1'

export const protocolVersion = 1

export const stationConnectPath = '/v1/stations/connect'

export const capabilities = [
  'generation.v1',
  'secrets.v1',
  'logs.follow',
  'metrics.v1',
  'exec.tty',
  'forward.tcp',
  'registry.v1',
  'guard.v1',
  'scan.v1',
  'platform.v1',
  'doctor.v1',
  'volumes.v1',
  'network.v1',
  'tracks.v1',
  'gpu.v1',
  'sandbox.v1',
] as const

export type Capability = (typeof capabilities)[number]

export const closeCodes = {
  normal: 1000,
  goingAway: 1001,
  messageTooBig: 1009,
  authFailed: 4001,
  revoked: 4003,
  duplicateConnection: 4009,
} as const

export const limits = {
  textFrameBytes: 1024 * 1024,
  generationInlineBytes: 4 * 1024 * 1024,
  binaryPayloadBytes: 64 * 1024,
  binaryHeaderBytes: 5,
  readLimitBytes: 5 * 1024 * 1024,
  concurrentStreams: 64,
  pendingRequests: 256,
  outboxInFlight: 1000,
  streamWindowBytes: 256 * 1024,
  streamDataItemsBytes: 256 * 1024,
  registryDeleteItems: 500,
} as const

export const Envelope = Type.Object(
  {
    type: Type.String(),
    id: Id('message'),
    ref: Nullable(Id('message')),
    generation: Count,
    sent_at: Timestamp,
    body: Type.Unknown({
      goJSONSchema: {
        type: 'json.RawMessage',
        imports: ['encoding/json'],
      },
    }),
  },
  {
    title: 'Envelope',
  },
)

const CapabilityName = Type.String({
  pattern: '^[a-z][a-z0-9_.]*$',
})

const seq = Count

const ChallengeBody = Type.Object(
  {
    nonce: Base64UrlBytes32,
    dispatch_time: Timestamp,
  },
  {
    title: 'ChallengeBody',
  },
)

const HelloBody = Type.Object(
  {
    station_id: Id('station'),
    timestamp: UnixMillis,
    signature: Base64UrlBytes64,
    stationd_version: Type.String(),
    protocol: Count,
    capabilities: Type.Array(CapabilityName),
    applied: AppliedGeneration,
    outbox: Type.Object(
      {
        epoch: Id('station_outbox'),
        first_seq: Count,
        last_seq: Count,
      },
      {
        title: 'OutboxRange',
      },
    ),
    boot_id: Type.String(),
    started_at: Timestamp,
  },
  {
    title: 'HelloBody',
  },
)

const WelcomeBody = Type.Object(
  {
    session_id: Type.String(),
    protocol: Count,
    capabilities: Type.Array(CapabilityName),
    version_skew: VersionSkew,
    resume_from_seq: Nullable(Count),
    instance_id: Id('instance'),
    desired: Type.Object(
      {
        number: Count,
        hash: Nullable(Digest),
      },
      {
        title: 'DesiredGenerationRef',
      },
    ),
  },
  {
    title: 'WelcomeBody',
  },
)

const EnrollBody = Type.Object(
  {
    token: Type.String(),
    identity_key: Base64UrlBytes32,
    public_key: Base64UrlBytes32,
    timestamp: UnixMillis,
    signature: Base64UrlBytes64,
    os: StationOs,
    arch: StationArch,
    capabilities: StationCapabilities,
    routes: StationRoutes,
    resources: Resources,
    stationd_version: Type.String(),
    install: Type.Optional(
      Type.Object(
        {
          ipam_pool: Type.String(),
          registry_subnet: Type.String(),
          station_id: Type.Optional(Id('station')),
        },
        {
          title: 'EnrollInstall',
        },
      ),
    ),
  },
  {
    title: 'EnrollBody',
  },
)

const EnrolledBody = Type.Object(
  {
    station_id: Id('station'),
    instance_id: Id('instance'),
    registry_subnet: Type.String(),
    registry_address: Type.String(),
    settings: Type.Object(
      {
        'ipam.pool': Type.String(),
        'ipam.virtual_prefix': Type.String(),
      },
      {
        title: 'EnrolledSettings',
      },
    ),
  },
  {
    title: 'EnrolledBody',
  },
)

const HeartbeatBody = Type.Object(
  {
    applied: AppliedGeneration,
    resources: Resources,
    outbox: Type.Object(
      {
        last_seq: Count,
      },
      {
        title: 'HeartbeatOutbox',
      },
    ),
    services: Type.Record(
      Type.String(),
      Type.Object(
        {
          status_hint: StatusHint,
          health: ServiceHealth,
        },
        {
          title: 'ServiceHeartbeat',
        },
      ),
    ),
  },
  {
    title: 'HeartbeatBody',
  },
)

const GenerationAvailableBody = Type.Object(
  {
    number: Count,
    hash: Digest,
    blob: BlobGrant,
  },
  {
    title: 'GenerationAvailableBody',
  },
)

const GenerationAckBody = Type.Object(
  {
    number: Count,
    hash: Digest,
    status: AppliedStatus,
    results: Type.Array(
      Type.Object(
        {
          key: Type.String(),
          status: StringEnum(['failed', 'blocked'], {
            title: 'GenerationResultStatus',
          }),
          failure: Type.Optional(ErrorBody),
          blocked_by: Type.Optional(Type.String()),
        },
        {
          title: 'GenerationResult',
        },
      ),
    ),
    failure: Type.Optional(ErrorBody),
    duration_ms: Count,
  },
  {
    title: 'GenerationAckBody',
  },
)

const EmptyBody = Type.Object(
  {},
  {
    title: 'EmptyBody',
  },
)

const OutboxAckBody = Type.Object(
  {
    epoch: Id('station_outbox'),
    up_to_seq: Count,
  },
  {
    title: 'OutboxAckBody',
  },
)

const DeploymentStepBody = Type.Object(
  {
    seq,
    deployment_id: Id('deployment'),
    step: DeploymentStepName,
    status: DeploymentStepStatus,
    attempt: Count,
    detail: JsonObject,
    started_at: Nullable(Timestamp),
    finished_at: Nullable(Timestamp),
  },
  {
    title: 'DeploymentStepBody',
  },
)

const DeploymentFinishedBody = Type.Object(
  {
    seq,
    deployment_id: Id('deployment'),
    status: DeploymentOutcome,
    failure: Nullable(Diagnosis),
    cancel_reason: Nullable(CancelReason),
  },
  {
    title: 'DeploymentFinishedBody',
  },
)

const RunCreatedBody = Type.Object(
  {
    seq,
    run: RunRow,
  },
  {
    title: 'RunCreatedBody',
  },
)

const RunStatusBody = Type.Object(
  {
    seq,
    run_id: Id('run'),
    status: RunStatus,
    exit_code: Nullable(Type.Integer()),
    started_at: Nullable(Timestamp),
    finished_at: Nullable(Timestamp),
    failure: Nullable(Diagnosis),
  },
  {
    title: 'RunStatusBody',
  },
)

const BuildStatusBody = Type.Object(
  {
    seq,
    build_id: Id('build'),
    status: BuildStatus,
    detail: JsonObject,
  },
  {
    title: 'BuildStatusBody',
  },
)

const BuildResultBody = Type.Object(
  {
    seq,
    build_id: Id('build'),
    status: BuildStatus,
    image_ref: Nullable(Type.String()),
    index_digest: Nullable(Digest),
    duration_s: Seconds,
    railpack_version: Nullable(Type.String()),
    base_images: Type.Array(BaseImage),
    attestations: Type.Array(
      Type.Object(
        {
          kind: AttestationKind,
          platform: Type.String(),
          digest: Nullable(Digest),
          predicate_ref: Type.String(),
          base_images: Type.Array(BaseImage),
        },
        {
          title: 'BuildAttestation',
        },
      ),
    ),
    failure: Nullable(Diagnosis),
  },
  {
    title: 'BuildResultBody',
  },
)

const HealthResultBody = Type.Object(
  {
    seq,
    service_id: Id('service'),
    deployment_id: Id('deployment'),
    state: StringEnum(['passing', 'failing', 'failed'], {
      title: 'HealthResultState',
    }),
    consecutive: Count,
    last_check: Nullable(Timestamp),
  },
  {
    title: 'HealthResultBody',
  },
)

const ContainerExitedBody = Type.Object(
  {
    seq,
    container_id: Type.String(),
    role: Type.String(),
    service_id: Nullable(Id('service')),
    deployment_id: Nullable(Id('deployment')),
    exit_code: Type.Integer(),
    oom_killed: Type.Boolean(),
    restarts: Count,
  },
  {
    title: 'ContainerExitedBody',
  },
)

const DiskPressureBody = Type.Object(
  {
    seq,
    free_bytes: Bytes,
    threshold: StringEnum(['warning', 'critical'], {
      title: 'DiskThreshold',
    }),
    largest_consumers: Type.Array(Json),
  },
  {
    title: 'DiskPressureBody',
  },
)

const RegistryMaintenanceBody = Type.Object(
  {
    seq,
    state: StringEnum(['started', 'finished'], {
      title: 'RegistryMaintenanceState',
    }),
    deleted_blobs: Count,
    freed_bytes: Bytes,
    duration_s: Seconds,
  },
  {
    title: 'RegistryMaintenanceBody',
  },
)

const ComponentStatusBody = Type.Object(
  {
    seq,
    station_id: Nullable(Id('station')),
    name: Type.String(),
    container_id: Nullable(Type.String()),
    version: Type.String(),
    digest: Nullable(Type.String()),
    since: Timestamp,
    lockfile_version: Type.String(),
    status: ComponentStatus,
    signature: SignatureState,
    failure: Nullable(ErrorBody),
  },
  {
    title: 'ComponentStatusBody',
  },
)

const LogGapBody = Type.Object(
  {
    seq,
    selector: JsonObject,
    from: Timestamp,
    to: Timestamp,
  },
  {
    title: 'LogGapBody',
  },
)

const AuditRecordBody = Type.Object(
  {
    seq,
    action: Type.String(),
    target: EntityRef,
    actor: Actor,
    purpose: Nullable(Type.String()),
  },
  {
    title: 'AuditRecordBody',
  },
)

const GuardAckBody = Type.Object(
  {
    seq,
    service_id: Id('service'),
    policy_id: Id('firewall_policy'),
    generation: Count,
  },
  {
    title: 'GuardAckBody',
  },
)

const FlowRollupBody = Type.Object(
  {
    seq,
    rows: Type.Array(FlowRollupRow),
  },
  {
    title: 'FlowRollupBody',
  },
)

const OutboxGapBody = Type.Object(
  {
    seq,
    from_seq: Count,
    to_seq: Count,
    types: Type.Array(Type.String()),
  },
  {
    title: 'OutboxGapBody',
  },
)

const ScanResultBody = Type.Object(
  {
    seq,
    result: JsonObject,
  },
  {
    title: 'ScanResultBody',
  },
)

const SandboxStatusBody = Type.Object(
  {
    seq,
    sandbox_id: Id('sandbox'),
    status: SandboxReportStatus,
    reason: Nullable(SandboxStatusReason),
    exit_code: Nullable(Type.Integer()),
    oom_killed: Type.Boolean(),
    started_at: Nullable(Timestamp),
    stopped_at: Nullable(Timestamp),
    failure: Nullable(Diagnosis),
  },
  {
    title: 'SandboxStatusBody',
  },
)

const SandboxSnapshotStatusBody = Type.Object(
  {
    seq,
    snapshot_id: Id('sandbox_snapshot'),
    status: StringEnum(['ready', 'failed', 'deleted'], {
      title: 'SandboxSnapshotReportStatus',
    }),
    taken_at: Nullable(Timestamp),
    exclusive_bytes: Bytes,
    referenced_bytes: Bytes,
    failure: Nullable(Diagnosis),
  },
  {
    title: 'SandboxSnapshotStatusBody',
  },
)

const SandboxStorageGrowBody = Type.Object(
  {
    size_bytes: Bytes,
  },
  {
    title: 'SandboxStorageGrowBody',
  },
)

const SandboxStorageGrownBody = Type.Object(
  {
    status: StringEnum(['grown', 'failed'], {
      title: 'SandboxStorageGrowStatus',
    }),
    step: Nullable(
      StringEnum(['fallocate', 'loop', 'resize'], {
        title: 'SandboxStorageGrowStep',
      }),
    ),
    error: Nullable(Type.String()),
    filesystem_bytes: Bytes,
    filesystem_free_bytes: Bytes,
  },
  {
    title: 'SandboxStorageGrownBody',
  },
)

const BuildSource = Type.Union(
  [
    Type.Object({
      type: Type.Literal('git'),
      repo: Type.String(),
      url: Type.String(),
      sha: Type.String(),
      ref: Nullable(Type.String()),
      path: Type.String(),
      dockerfile: Nullable(Type.String()),
    }),
    Type.Object({
      type: Type.Literal('blob'),
      blob: BlobGrant,
      path: Type.String(),
      dockerfile: Nullable(Type.String()),
    }),
  ],
  {
    title: 'BuildSource',
  },
)

const BuildStartBody = Type.Object(
  {
    build_id: Id('build'),
    deployment_id: Id('deployment'),
    project_id: Id('project'),
    service_id: Id('service'),
    builder: Builder,
    source: BuildSource,
    railpack: Nullable(
      Type.Object(
        {
          install_cmd: Nullable(Type.String()),
          build_cmd: Nullable(Type.String()),
          start_cmd: Nullable(Type.String()),
        },
        {
          title: 'RailpackOverrides',
        },
      ),
    ),
    build_args: Nullable(Type.Record(Type.String(), Type.String())),
    build_secret_keys: Type.Array(Type.String()),
    cache_key: Type.String(),
    export_name: Type.String(),
    attest: Type.Object(
      {
        sbom: Type.Boolean(),
        provenance: Type.String(),
      },
      {
        title: 'BuildAttest',
      },
    ),
  },
  {
    title: 'BuildStartBody',
  },
)

const BuildRefBody = Type.Object(
  {
    build_id: Id('build'),
  },
  {
    title: 'BuildRefBody',
  },
)

export const sandboxStdinMaxBytes = 256 * 1024

const RunStartBody = Type.Object(
  {
    run_id: Id('run'),
    service_id: Nullable(Id('service')),
    deployment_id: Nullable(Id('deployment')),
    sandbox_id: Type.Optional(Id('sandbox')),
    kind: RunKind,
    command: Type.Array(Type.String()),
    tty: Type.Boolean(),
    attach: Type.Boolean(),
    rows: Nullable(Count),
    cols: Nullable(Count),
    actor: Actor,
    user: Type.Optional(Type.String()),
    cwd: Type.Optional(Type.String()),
    timeout_s: Type.Optional(Seconds),
    stdin: Type.Optional(
      Type.String({
        pattern: '^[A-Za-z0-9_-]*$',
        maxLength: Math.ceil((sandboxStdinMaxBytes * 4) / 3),
      }),
    ),
  },
  {
    title: 'RunStartBody',
  },
)

const RunAcceptedBody = Type.Object(
  {
    run_id: Id('run'),
    stream: Nullable(Count),
  },
  {
    title: 'RunAcceptedBody',
  },
)

const RunRefBody = Type.Object(
  {
    run_id: Id('run'),
  },
  {
    title: 'RunRefBody',
  },
)

const LogSelector = Type.Object(
  {
    source: StringEnum(['runtime', 'build', 'run', 'system', 'sandbox'], {
      title: 'LogSource',
    }),
    service_id: Type.Optional(Id('service')),
    sandbox_id: Type.Optional(Id('sandbox')),
    deployment_id: Type.Optional(Id('deployment')),
    build_id: Type.Optional(Id('build')),
    run_id: Type.Optional(Id('run')),
    component: Type.Optional(Type.String()),
    role: Type.Optional(
      StringEnum(['service', 'guard', 'coupler', 'init', 'runtime'], {
        title: 'LogRole',
      }),
    ),
    since: Type.Optional(Timestamp),
    until: Type.Optional(Timestamp),
    grep: Type.Optional(Type.String()),
    level: Type.Optional(Type.String()),
    tail: Type.Optional(Count),
    cursor: Type.Optional(Type.String()),
  },
  {
    title: 'LogSelector',
  },
)

const LogLine = Type.Object(
  {
    at: Timestamp,
    role: Nullable(Type.String()),
    stream: StringEnum(['stdout', 'stderr'], {
      title: 'LogStream',
    }),
    text: Type.String(),
    level: Nullable(Type.String()),
    cursor: Type.String(),
  },
  {
    title: 'LogLine',
  },
)

const LogsPageBody = Type.Object(
  {
    lines: Type.Array(LogLine),
    next_cursor: Nullable(Type.String()),
    truncated: Type.Boolean(),
  },
  {
    title: 'LogsPageBody',
  },
)

const MetricsSubscribeBody = Type.Object(
  {
    service_ids: Type.Optional(Type.Array(Id('service'))),
    sandbox_ids: Type.Optional(Type.Array(Id('sandbox'))),
  },
  {
    title: 'MetricsSubscribeBody',
  },
)

const MetricsSampleBody = Type.Object(
  {
    service_ids: Type.Optional(Type.Array(Id('service'))),
    sandbox_ids: Type.Optional(Type.Array(Id('sandbox'))),
  },
  {
    title: 'MetricsSampleBody',
  },
)

const MetricSample = Type.Object(
  {
    service_id: Type.Optional(Id('service')),
    sandbox_id: Type.Optional(Id('sandbox')),
    deployment_id: Type.Optional(Nullable(Id('deployment'))),
    container_id: Type.String(),
    at: Timestamp,
    cpu_pct: Type.Number({
      minimum: 0,
    }),
    memory_bytes: Bytes,
    memory_limit_bytes: Bytes,
    net_rx_bps: Bytes,
    net_tx_bps: Bytes,
    blk_read_bps: Bytes,
    blk_write_bps: Bytes,
    restarts: Nullable(Count),
    disk_used_bytes: Type.Optional(Bytes),
    disk_limit_bytes: Type.Optional(Bytes),
  },
  {
    title: 'MetricSample',
  },
)

const MetricsSampleResultBody = Type.Object(
  {
    samples: Type.Array(MetricSample),
  },
  {
    title: 'MetricsSampleResultBody',
  },
)

export const networkServiceIdsMax = 300

const NetworkServiceIds = Type.Array(Id('service'), {
  maxItems: networkServiceIdsMax,
})

const NetworkSandboxIds = Type.Array(Id('sandbox'), {
  maxItems: networkServiceIdsMax,
})

const NetworkSubscribeBody = Type.Object(
  {
    service_ids: Type.Optional(NetworkServiceIds),
    sandbox_ids: Type.Optional(NetworkSandboxIds),
  },
  {
    title: 'NetworkSubscribeBody',
  },
)

const NetworkSampleBody = Type.Object(
  {
    service_ids: Type.Optional(NetworkServiceIds),
    sandbox_ids: Type.Optional(NetworkSandboxIds),
  },
  {
    title: 'NetworkSampleBody',
  },
)

const PortNumber = Type.Integer({
  minimum: 0,
  maximum: 65535,
})

const NetworkProtocolEnum = StringEnum(['tcp', 'udp'], {
  title: 'NetworkProtocol',
})

export const networkPeerKinds = [
  'service',
  'sandbox',
  'resolver',
  'gateway',
  'station',
  'internet',
  'public',
  'address',
  'other',
] as const

const NetworkPeer = Type.Object(
  {
    kind: StringEnum(networkPeerKinds, {
      title: 'NetworkPeerKind',
    }),
    service_id: Type.Optional(Id('service')),
    sandbox_id: Type.Optional(Id('sandbox')),
    deployment_id: Type.Optional(Nullable(Id('deployment'))),
    address: Type.Optional(Type.String()),
  },
  {
    title: 'NetworkPeer',
  },
)

const NetworkConnection = Type.Object(
  {
    direction: StringEnum(['in', 'out'], {
      title: 'NetworkDirection',
    }),
    peer: NetworkPeer,
    port: PortNumber,
    protocol: NetworkProtocolEnum,
    flows: Count,
    established: Count,
    bytes_out: Nullable(Bytes),
    bytes_in: Nullable(Bytes),
    bps_out: Nullable(Bytes),
    bps_in: Nullable(Bytes),
    counters_age_s: Nullable(Seconds),
    oldest_s: Nullable(Seconds),
  },
  {
    title: 'NetworkConnection',
  },
)

export const refusedPaths = [
  'host_address',
  'other_environment',
  'cloud_metadata',
  'private_range',
  'no_switch_target',
  'sandbox_inbound',
  'domain_not_allowed',
] as const

const NetworkRefused = Type.Object(
  {
    path: StringEnum(refusedPaths, {
      title: 'RefusedPath',
    }),
    address: Type.String(),
    port: PortNumber,
    protocol: StringEnum(['tcp', 'udp', 'icmp', 'other'], {
      title: 'RefusedProtocol',
    }),
    count: Count,
    expires_in_s: Seconds,
  },
  {
    title: 'NetworkRefused',
  },
)

const NetworkConntrack = Type.Object(
  {
    entries: Nullable(Count),
    truncated: Type.Boolean(),
    stale: Type.Boolean(),
    lossy: Type.Boolean(),
    accounting: Type.Boolean(),
    timestamps: Type.Boolean(),
  },
  {
    title: 'NetworkConntrack',
  },
)

const NetworkSample = Type.Object(
  {
    service_id: Type.Optional(Id('service')),
    sandbox_id: Type.Optional(Id('sandbox')),
    deployment_id: Type.Optional(Nullable(Id('deployment'))),
    at: Timestamp,
    conntrack: NetworkConntrack,
    connections: Type.Array(NetworkConnection),
    refused: Type.Array(NetworkRefused),
    refused_truncated: Type.Boolean(),
    names: Type.Record(Type.String(), Type.String()),
  },
  {
    title: 'NetworkSample',
  },
)

const NetworkSampleResultBody = Type.Object(
  {
    samples: Type.Array(NetworkSample),
  },
  {
    title: 'NetworkSampleResultBody',
  },
)

export const networkInspectChecksMax = 16

export const networkCheckKinds = [
  'verdict',
  'switch',
  'host_switch',
  'listening',
  'container',
] as const

const NetworkCheckKind = StringEnum(networkCheckKinds, {
  title: 'NetworkCheckKind',
})

const NetworkCheck = Type.Object(
  {
    kind: NetworkCheckKind,
    service_id: Type.Optional(Id('service')),
    sandbox_id: Type.Optional(Id('sandbox')),
    address: Type.Optional(Type.String()),
    port: Type.Optional(PortNumber),
    protocol: Type.Optional(NetworkProtocolEnum),
    virtual_ip: Type.Optional(Type.String()),
    host_port: Type.Optional(PortNumber),
  },
  {
    title: 'NetworkCheck',
  },
)

const NetworkInspectBody = Type.Object(
  {
    checks: Type.Array(NetworkCheck, {
      minItems: 1,
      maxItems: networkInspectChecksMax,
    }),
  },
  {
    title: 'NetworkInspectBody',
  },
)

export const networkPathIds = [
  'same_environment',
  'resolver',
  'loopback',
  'host_address',
  'other_environment',
  'cloud_metadata',
  'private_range',
  'public_internet',
  'no_switch_target',
  'sandbox_inbound',
  'domain_not_allowed',
] as const

export const networkVerdicts = ['accept', 'drop', 'reject'] as const

const NetworkVerdictValue = StringEnum(networkVerdicts, {
  title: 'NetworkVerdictValue',
})

const NetworkPathId = StringEnum(networkPathIds, {
  title: 'NetworkPathId',
})

const NetworkVerdict = Type.Object(
  {
    verdict: NetworkVerdictValue,
    path: NetworkPathId,
    rule: Type.String(),
  },
  {
    title: 'NetworkVerdict',
  },
)

export const networkSocketsMax = 32

const NetworkCheckResult = Type.Object(
  {
    kind: NetworkCheckKind,
    error: Type.Optional(Type.String()),
    verdict: Type.Optional(NetworkVerdictValue),
    path: Type.Optional(NetworkPathId),
    rule: Type.Optional(Type.String()),
    address: Type.Optional(Nullable(Type.String())),
    rejected: Type.Optional(Type.Boolean()),
    port: Type.Optional(Nullable(PortNumber)),
    gateway_target: Type.Optional(Type.Boolean()),
    sockets: Type.Optional(
      Type.Array(ListeningSocket, {
        maxItems: networkSocketsMax,
      }),
    ),
    deployment_id: Type.Optional(Nullable(Id('deployment'))),
    state: Type.Optional(Type.String()),
    health: Type.Optional(Type.String()),
  },
  {
    title: 'NetworkCheckResult',
  },
)

const NetworkInspectResultBody = Type.Object(
  {
    results: Type.Array(NetworkCheckResult),
  },
  {
    title: 'NetworkInspectResultBody',
  },
)

export const probeKinds = ['tcp', 'dns'] as const

export const probeTimeout = {
  defaultS: 3,
  minS: 1,
  maxS: 10,
} as const

const ProbeKind = StringEnum(probeKinds, {
  title: 'ProbeKind',
})

const NetworkProbeBody = Type.Object(
  {
    service_id: Type.Optional(Id('service')),
    sandbox_id: Type.Optional(Id('sandbox')),
    kind: ProbeKind,
    to: Type.String({
      minLength: 1,
      maxLength: 253,
    }),
    port: Type.Optional(PortNumber),
    timeout_s: Type.Integer({
      minimum: probeTimeout.minS,
      maximum: probeTimeout.maxS,
    }),
  },
  {
    title: 'NetworkProbeBody',
  },
)

export const probeTcpResults = [
  'connected',
  'refused',
  'rejected',
  'timeout',
  'no_route',
  'no_answer',
] as const

const ProbeDns = Type.Object(
  {
    rcode: Type.String(),
    answers: Type.Array(Type.String()),
    ms: Type.Number({
      minimum: 0,
    }),
  },
  {
    title: 'ProbeDns',
  },
)

const ProbeTcp = Type.Object(
  {
    address: Nullable(Type.String()),
    result: StringEnum(probeTcpResults, {
      title: 'ProbeTcpResult',
    }),
    ms: Type.Number({
      minimum: 0,
    }),
  },
  {
    title: 'ProbeTcp',
  },
)

const NetworkProbeResultBody = Type.Object(
  {
    service_id: Type.Optional(Id('service')),
    sandbox_id: Type.Optional(Id('sandbox')),
    deployment_id: Type.Optional(Nullable(Id('deployment'))),
    kind: ProbeKind,
    to: Type.String(),
    port: Nullable(PortNumber),
    dns: Type.Optional(ProbeDns),
    tcp: Type.Optional(ProbeTcp),
    verdict: Type.Optional(NetworkVerdict),
    at: Timestamp,
  },
  {
    title: 'NetworkProbeResultBody',
  },
)

export const dnsLogTail = {
  default: 50,
  max: 200,
} as const

const DnsLogBody = Type.Object(
  {
    service_id: Type.Optional(Id('service')),
    sandbox_id: Type.Optional(Id('sandbox')),
    tail: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: dnsLogTail.max,
      }),
    ),
    name: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 253,
      }),
    ),
    rcode: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 16,
      }),
    ),
  },
  {
    title: 'DnsLogBody',
  },
)

const DnsLogEntry = Type.Object(
  {
    at: Timestamp,
    deployment_id: Nullable(Id('deployment')),
    name: Type.String(),
    type: Type.String(),
    rcode: Type.String(),
    answers: Type.Array(Type.String()),
    upstream: Type.Boolean(),
    ms: Type.Number({
      minimum: 0,
    }),
    probe: Type.Boolean(),
    refused: Type.Optional(
      Nullable(
        StringEnum(['domain_not_allowed', 'rebind'], {
          title: 'DnsRefusal',
        }),
      ),
    ),
  },
  {
    title: 'DnsLogEntry',
  },
)

const DnsLogResultBody = Type.Object(
  {
    entries: Type.Array(DnsLogEntry),
  },
  {
    title: 'DnsLogResultBody',
  },
)

const StreamNumber = Type.Integer({
  minimum: 1,
  maximum: 4294967295,
})

const ExecResizeBody = Type.Object(
  {
    stream: StreamNumber,
    rows: Count,
    cols: Count,
  },
  {
    title: 'ExecResizeBody',
  },
)

const StreamRefBody = Type.Object(
  {
    stream: StreamNumber,
  },
  {
    title: 'StreamRefBody',
  },
)

const ForwardOpenBody = Type.Object(
  {
    environment_id: Type.Optional(Id('environment')),
    service_id: Type.Optional(Id('service')),
    sandbox_id: Type.Optional(Id('sandbox')),
    port: Port,
  },
  {
    title: 'ForwardOpenBody',
  },
)

const StreamOpenedBody = Type.Object(
  {
    stream: StreamNumber,
    window: Bytes,
  },
  {
    title: 'StreamOpenedBody',
  },
)

const StreamDataBody = Type.Object(
  {
    stream: StreamNumber,
    items: Type.Array(Json),
  },
  {
    title: 'StreamDataBody',
  },
)

const StreamCreditBody = Type.Object(
  {
    stream: StreamNumber,
    bytes: Bytes,
  },
  {
    title: 'StreamCreditBody',
  },
)

const StreamEndBody = Type.Object(
  {
    stream: StreamNumber,
    reason: Type.String(),
    exit_code: Nullable(Type.Integer()),
  },
  {
    title: 'StreamEndBody',
  },
)

const SecretTarget = Type.Union(
  [
    Type.Object({
      deployment_id: Id('deployment'),
    }),
    Type.Object({
      run_id: Id('run'),
    }),
    Type.Object({
      build_id: Id('build'),
    }),
    Type.Object({
      component: Type.String(),
    }),
    Type.Object({
      snapshot_id: Id('volume_snapshot'),
    }),
    Type.Object({
      sandbox_id: Id('sandbox'),
    }),
  ],
  {
    title: 'SecretTarget',
  },
)

const Base64UrlOrEmpty = Type.String({
  pattern: '^[A-Za-z0-9_-]*$',
})

const SecretPurpose = StringEnum(
  ['deploy', 'redaction', 'run', 'build', 'component', 'backup', 'sandbox'],
  {
    title: 'SecretPurpose',
  },
)

const SecretsDeliverBody = Type.Object(
  {
    target: SecretTarget,
    env_digest: Digest,
    purpose: SecretPurpose,
    values: Type.Array(
      Type.Object(
        {
          key: Type.String(),
          injection: Injection,
          refs: Type.Array(EnvRef),
          value: Base64UrlOrEmpty,
        },
        {
          title: 'SecretValue',
        },
      ),
    ),
    redaction: Type.Array(
      Type.Object(
        {
          key: Type.String(),
          value: Base64UrlOrEmpty,
        },
        {
          title: 'SecretRedaction',
        },
      ),
    ),
  },
  {
    title: 'SecretsDeliverBody',
  },
)

const SecretsAckBody = Type.Object(
  {
    target: SecretTarget,
    env_digest: Digest,
  },
  {
    title: 'SecretsAckBody',
  },
)

const SecretsRequestBody = Type.Object(
  {
    target: SecretTarget,
    env_digest: Digest,
    purpose: SecretPurpose,
  },
  {
    title: 'SecretsRequestBody',
  },
)

const MasterKeyPrepareBody = Type.Object(
  {
    current_key: Type.String(),
    new_key: Type.String(),
  },
  {
    title: 'MasterKeyPrepareBody',
  },
)

const MasterKeyPreparedBody = Type.Object(
  {
    data_keys: Count,
  },
  {
    title: 'MasterKeyPreparedBody',
  },
)

const HostAdminBody = Type.Object(
  {
    op: Type.String(),
    params: JsonObject,
  },
  {
    title: 'HostAdminBody',
  },
)

const HostAdminResultBody = Type.Object(
  {
    result: JsonObject,
  },
  {
    title: 'HostAdminResultBody',
  },
)

const RegistryDeleteBody = Type.Object(
  {
    items: Type.Array(
      Type.Object(
        {
          repository: Type.String(),
          digest: Digest,
          reason: Type.String(),
        },
        {
          title: 'RegistryDeleteItem',
        },
      ),
      {
        maxItems: limits.registryDeleteItems,
      },
    ),
  },
  {
    title: 'RegistryDeleteBody',
  },
)

const RegistryDeleteResultBody = Type.Object(
  {
    items: Type.Array(
      Type.Object(
        {
          repository: Type.String(),
          digest: Digest,
          status: StringEnum(['deleted', 'absent', 'failed'], {
            title: 'RegistryDeleteStatus',
          }),
          error: Nullable(ErrorBody),
        },
        {
          title: 'RegistryDeleteResult',
        },
      ),
    ),
  },
  {
    title: 'RegistryDeleteResultBody',
  },
)

const RegistryGcBody = Type.Object(
  {
    reason: StringEnum(['schedule', 'disk_pressure'], {
      title: 'RegistryGcReason',
    }),
  },
  {
    title: 'RegistryGcBody',
  },
)

const ScanStartBody = Type.Object(
  {
    request: JsonObject,
  },
  {
    title: 'ScanStartBody',
  },
)

const DomainProbeBody = Type.Object(
  {
    domain_id: Id('domain'),
    hostname: Type.String(),
  },
  {
    title: 'DomainProbeBody',
  },
)

const DomainProbeResultBody = Type.Object(
  {
    domain_id: Id('domain'),
    ok: Type.Boolean(),
    status_code: Nullable(Type.Integer()),
    failure: Nullable(ErrorBody),
  },
  {
    title: 'DomainProbeResultBody',
  },
)

const BlobGrantRequestBody = Type.Object(
  {
    blob_id: Type.Optional(Id('blob')),
    upstream: Type.Optional(
      Type.Union(
        [
          Type.Object({
            tuf_path: Type.String(),
          }),
          Type.Object({
            signature_digest: Digest,
          }),
        ],
        {
          title: 'BlobUpstream',
        },
      ),
    ),
  },
  {
    title: 'BlobGrantRequestBody',
  },
)

const DoctorCheck = Type.Object(
  {
    name: Type.String(),
    status: StringEnum(doctorStatusValues, {
      title: 'DoctorStatus',
    }),
    code: Nullable(Type.String()),
    finding: Type.String(),
    fix: Nullable(Type.String()),
    detail: Type.Optional(JsonObject),
  },
  {
    title: 'DoctorCheck',
  },
)

const DoctorRunBody = Type.Object(
  {
    checks: Type.Optional(Type.Array(Type.String())),
  },
  {
    title: 'DoctorRunBody',
  },
)

const DoctorReportBody = Type.Object(
  {
    checked_at: Timestamp,
    checks: Type.Array(DoctorCheck),
  },
  {
    title: 'DoctorReportBody',
  },
)

const BackupTarget = Type.Object(
  {
    type: StringEnum(['path', 's3'], {
      title: 'BackupTargetType',
    }),
    path: Nullable(Type.String()),
    endpoint: Nullable(Type.String()),
    bucket: Nullable(Type.String()),
    prefix: Nullable(Type.String()),
  },
  {
    title: 'BackupTarget',
  },
)

const BackupObjects = Type.Object(
  {
    archive: Type.String(),
    metadata: Type.String(),
  },
  {
    title: 'BackupObjects',
  },
)

const VolumeBackupBody = Type.Object(
  {
    snapshot_id: Id('volume_snapshot'),
    volume_id: Id('volume'),
    docker_name: Type.String(),
    service_id: Nullable(Id('service')),
    environment_id: Nullable(Id('environment')),
    deployment_id: Nullable(Id('deployment')),
    image_ref: Nullable(Type.String()),
    mount_path: Type.String(),
    target: BackupTarget,
    name: Type.String({
      pattern: '^[A-Za-z0-9_.-]+$',
    }),
    quiesce: Type.Boolean(),
  },
  {
    title: 'VolumeBackupBody',
  },
)

const VolumeBackupAcceptedBody = Type.Object(
  {
    snapshot_id: Id('volume_snapshot'),
    objects: BackupObjects,
  },
  {
    title: 'VolumeBackupAcceptedBody',
  },
)

const VolumeBackupResultBody = Type.Object(
  {
    snapshot_id: Id('volume_snapshot'),
    volume_id: Id('volume'),
    status: StringEnum(['complete', 'failed'], {
      title: 'VolumeBackupStatus',
    }),
    objects: BackupObjects,
    size_bytes: Bytes,
    archive_bytes: Bytes,
    sha256: Nullable(Type.String()),
    consistent: Type.Boolean(),
    started_at: Timestamp,
    finished_at: Timestamp,
    failure: Nullable(ErrorBody),
  },
  {
    title: 'VolumeBackupResultBody',
  },
)

const VolumeRestoreBody = Type.Object(
  {
    snapshot_id: Id('volume_snapshot'),
    volume_id: Id('volume'),
    docker_name: Type.String(),
    owner: StringEnum(volumeOwnerValues, {
      title: 'VolumeOwner',
    }),
    target: BackupTarget,
    objects: BackupObjects,
    sha256: Type.String({
      pattern: '^[0-9a-f]{64}$',
    }),
  },
  {
    title: 'VolumeRestoreBody',
  },
)

const VolumeRestoreAcceptedBody = Type.Object(
  {
    volume_id: Id('volume'),
  },
  {
    title: 'VolumeRestoreAcceptedBody',
  },
)

const VolumeRestoreResultBody = Type.Object(
  {
    snapshot_id: Id('volume_snapshot'),
    volume_id: Id('volume'),
    status: StringEnum(['complete', 'failed'], {
      title: 'VolumeRestoreStatus',
    }),
    sha256: Nullable(Type.String()),
    size_bytes: Bytes,
    files: Count,
    tree_sha256: Nullable(Type.String()),
    started_at: Timestamp,
    finished_at: Timestamp,
    failure: Nullable(ErrorBody),
  },
  {
    title: 'VolumeRestoreResultBody',
  },
)

const VolumeBackupDeleteBody = Type.Object(
  {
    items: Type.Array(
      Type.Object(
        {
          snapshot_id: Id('volume_snapshot'),
          target: BackupTarget,
          objects: BackupObjects,
        },
        {
          title: 'VolumeBackupDeleteItem',
        },
      ),
      {
        maxItems: 1000,
      },
    ),
  },
  {
    title: 'VolumeBackupDeleteBody',
  },
)

const VolumeBackupDeleteResultBody = Type.Object(
  {
    items: Type.Array(
      Type.Object(
        {
          snapshot_id: Id('volume_snapshot'),
          status: StringEnum(['deleted', 'absent', 'failed'], {
            title: 'VolumeBackupDeleteStatus',
          }),
          error: Nullable(ErrorBody),
        },
        {
          title: 'VolumeBackupDeleteResult',
        },
      ),
    ),
  },
  {
    title: 'VolumeBackupDeleteResultBody',
  },
)

type Sender = 'dispatch' | 'station' | 'both'

type MessageDefinition = {
  from: Sender
  body: TSchema
  capability: Capability | null
  outboxed: boolean
}

const message = <Body extends TSchema>(
  from: Sender,
  body: Body,
  capability: Capability | null = null,
  outboxed = false,
) =>
  ({
    from,
    body,
    capability,
    outboxed,
  }) satisfies MessageDefinition

const outboxed = <Body extends TSchema>(body: Body, capability: Capability | null = null) =>
  message('station', body, capability, true)

export const messages = {
  challenge: message('dispatch', ChallengeBody),
  hello: message('station', HelloBody),
  welcome: message('dispatch', WelcomeBody),
  enroll: message('station', EnrollBody),
  enrolled: message('dispatch', EnrolledBody),
  heartbeat: message('station', HeartbeatBody),
  error: message('both', ErrorBody),

  generation: message('dispatch', Generation, 'generation.v1'),
  'generation.available': message('dispatch', GenerationAvailableBody, 'generation.v1'),
  'generation.ack': message('station', GenerationAckBody, 'generation.v1'),

  'observed.report': message('station', Observed),
  'observed.update': message('station', ObservedUpdate),
  'observed.request': message('dispatch', EmptyBody),

  'outbox.ack': message('dispatch', OutboxAckBody),
  'deployment.step': outboxed(DeploymentStepBody),
  'deployment.finished': outboxed(DeploymentFinishedBody),
  'run.created': outboxed(RunCreatedBody),
  'run.status': outboxed(RunStatusBody),
  'run.exited': outboxed(RunStatusBody),
  'build.status': outboxed(BuildStatusBody),
  'build.result': outboxed(BuildResultBody),
  'health.result': outboxed(HealthResultBody),
  'container.exited': outboxed(ContainerExitedBody),
  'disk.pressure': outboxed(DiskPressureBody),
  'registry.maintenance': outboxed(RegistryMaintenanceBody),
  'component.status': outboxed(ComponentStatusBody),
  'log.gap': outboxed(LogGapBody),
  'audit.record': outboxed(AuditRecordBody),
  'guard.ack': outboxed(GuardAckBody, 'guard.v1'),
  'flow.rollup': outboxed(FlowRollupBody, 'guard.v1'),
  'scan.result': outboxed(ScanResultBody, 'scan.v1'),
  'outbox.gap': outboxed(OutboxGapBody),
  'volume.backup.result': outboxed(VolumeBackupResultBody, 'volumes.v1'),
  'volume.restore.result': outboxed(VolumeRestoreResultBody, 'volumes.v1'),
  'sandbox.status': outboxed(SandboxStatusBody, 'sandbox.v1'),
  'sandbox.snapshot.status': outboxed(SandboxSnapshotStatusBody, 'sandbox.v1'),

  'build.start': message('dispatch', BuildStartBody),
  'build.accepted': message('station', BuildRefBody),
  'build.cancel': message('dispatch', BuildRefBody),
  'build.cancelled': message('station', BuildRefBody),
  'run.start': message('dispatch', RunStartBody),
  'run.accepted': message('station', RunAcceptedBody),
  'run.cancel': message('dispatch', RunRefBody),
  'run.cancelled': message('station', RunRefBody),
  'logs.query': message('dispatch', LogSelector),
  'logs.page': message('station', LogsPageBody),
  'logs.follow': message('dispatch', LogSelector, 'logs.follow'),
  'metrics.subscribe': message('dispatch', MetricsSubscribeBody, 'metrics.v1'),
  'metrics.sample': message('dispatch', MetricsSampleBody, 'metrics.v1'),
  'metrics.sample.result': message('station', MetricsSampleResultBody, 'metrics.v1'),
  'network.subscribe': message('dispatch', NetworkSubscribeBody, 'network.v1'),
  'network.sample': message('dispatch', NetworkSampleBody, 'network.v1'),
  'network.sample.result': message('station', NetworkSampleResultBody, 'network.v1'),
  'network.inspect': message('dispatch', NetworkInspectBody, 'network.v1'),
  'network.inspect.result': message('station', NetworkInspectResultBody, 'network.v1'),
  'network.probe': message('dispatch', NetworkProbeBody, 'network.v1'),
  'network.probe.result': message('station', NetworkProbeResultBody, 'network.v1'),
  'dns.log': message('dispatch', DnsLogBody, 'network.v1'),
  'dns.log.result': message('station', DnsLogResultBody, 'network.v1'),
  'exec.resize': message('dispatch', ExecResizeBody, 'exec.tty'),
  'exec.resized': message('station', StreamRefBody, 'exec.tty'),
  'forward.open': message('dispatch', ForwardOpenBody, 'forward.tcp'),
  'secrets.deliver': message('dispatch', SecretsDeliverBody, 'secrets.v1'),
  'secrets.ack': message('station', SecretsAckBody, 'secrets.v1'),
  'secrets.request': message('station', SecretsRequestBody, 'secrets.v1'),
  'master_key.prepare': message('station', MasterKeyPrepareBody),
  'master_key.prepared': message('dispatch', MasterKeyPreparedBody),
  'master_key.commit': message('station', EmptyBody),
  'master_key.committed': message('dispatch', EmptyBody),
  'master_key.abort': message('station', EmptyBody),
  'master_key.aborted': message('dispatch', EmptyBody),
  'host.admin': message('station', HostAdminBody),
  'host.admin.result': message('dispatch', HostAdminResultBody),
  'registry.delete': message('dispatch', RegistryDeleteBody, 'registry.v1'),
  'registry.delete.result': message('station', RegistryDeleteResultBody, 'registry.v1'),
  'registry.gc': message('dispatch', RegistryGcBody, 'registry.v1'),
  'registry.gc.accepted': message('station', EmptyBody, 'registry.v1'),
  'scan.start': message('dispatch', ScanStartBody, 'scan.v1'),
  'scan.accepted': message('station', EmptyBody, 'scan.v1'),
  'domain.probe': message('dispatch', DomainProbeBody),
  'domain.probe.result': message('station', DomainProbeResultBody),
  'platform.verify': message('dispatch', PlatformVerifyBody, 'platform.v1'),
  'platform.verify.result': message('station', PlatformVerifyResultBody, 'platform.v1'),
  'doctor.run': message('dispatch', DoctorRunBody, 'doctor.v1'),
  'doctor.report': message('station', DoctorReportBody, 'doctor.v1'),
  'volume.backup': message('dispatch', VolumeBackupBody, 'volumes.v1'),
  'volume.backup.accepted': message('station', VolumeBackupAcceptedBody, 'volumes.v1'),
  'volume.restore': message('dispatch', VolumeRestoreBody, 'volumes.v1'),
  'volume.restore.accepted': message('station', VolumeRestoreAcceptedBody, 'volumes.v1'),
  'volume.backup.delete': message('dispatch', VolumeBackupDeleteBody, 'volumes.v1'),
  'volume.backup.delete.result': message('station', VolumeBackupDeleteResultBody, 'volumes.v1'),
  'sandbox.storage.grow': message('dispatch', SandboxStorageGrowBody, 'sandbox.v1'),
  'sandbox.storage.grown': message('station', SandboxStorageGrownBody, 'sandbox.v1'),
  'blob.grant': message('station', BlobGrantRequestBody),
  'blob.granted': message('dispatch', BlobGrant),

  'stream.opened': message('both', StreamOpenedBody),
  'stream.data': message('both', StreamDataBody),
  'stream.credit': message('both', StreamCreditBody),
  'stream.end': message('both', StreamEndBody),
  'stream.cancel': message('both', StreamRefBody),
} as const

export type MessageType = keyof typeof messages

export type MessageBody<T extends MessageType> = Static<(typeof messages)[T]['body']>

export type Message<T extends MessageType> = Omit<Static<typeof Envelope>, 'type' | 'body'> & {
  type: T
  body: MessageBody<T>
}

export const coreMessageTypes = [
  'challenge',
  'hello',
  'enroll',
  'enrolled',
  'welcome',
  'heartbeat',
  'error',
  'outbox.ack',
  'observed.report',
  'blob.grant',
] as const satisfies readonly MessageType[]
