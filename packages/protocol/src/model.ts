import { Type } from '@sinclair/typebox'

import {
  Bytes,
  Count,
  Id,
  Json,
  JsonObject,
  Nullable,
  Port,
  Seconds,
  StringEnum,
  Timestamp,
} from './primitives.ts'

export const stationOsValues = ['linux', 'wsl2'] as const

export const StationOs = StringEnum(stationOsValues, {
  title: 'StationOs',
})

export const stationArchValues = ['amd64', 'arm64'] as const

export const StationArch = StringEnum(stationArchValues, {
  title: 'StationArch',
})

export const versionSkewValues = ['ok', 'behind', 'ahead', 'unsupported'] as const

export const VersionSkew = StringEnum(versionSkewValues, {
  title: 'VersionSkew',
})

export const serviceKindValues = ['web', 'worker', 'cron', 'one_off'] as const

export const ServiceKind = StringEnum(serviceKindValues, {
  title: 'ServiceKind',
})

export const desiredStateValues = ['running', 'stopped'] as const

export const DesiredState = StringEnum(desiredStateValues, {
  title: 'DesiredState',
})

export const strategyValues = ['overlap', 'replace'] as const

export const Strategy = StringEnum(strategyValues, {
  title: 'Strategy',
})

export const portProtocolValues = ['http', 'tcp'] as const

export const PortProtocol = StringEnum(portProtocolValues, {
  title: 'PortProtocol',
})

export const injectionValues = ['env', 'file'] as const

export const Injection = StringEnum(injectionValues, {
  title: 'Injection',
})

export const cancelReasonValues = ['user', 'superseded', 'station_offline'] as const

export const CancelReason = StringEnum(cancelReasonValues, {
  title: 'CancelReason',
})

export const deploymentStepNameValues = [
  'pull',
  'pre_deploy',
  'namespace',
  'baseline',
  'guard',
  'service',
  'health',
  'cutover',
  'drain',
  'cleanup',
] as const

export const DeploymentStepName = StringEnum(deploymentStepNameValues, {
  title: 'DeploymentStepName',
})

export const deploymentStepStatusValues = [
  'pending',
  'running',
  'done',
  'failed',
  'skipped',
] as const

export const DeploymentStepStatus = StringEnum(deploymentStepStatusValues, {
  title: 'DeploymentStepStatus',
})

export const deploymentOutcomeValues = ['active', 'failed', 'cancelled'] as const

export const DeploymentOutcome = StringEnum(deploymentOutcomeValues, {
  title: 'DeploymentOutcome',
})

export const builderValues = ['dockerfile', 'railpack', 'image'] as const

export const Builder = StringEnum(builderValues, {
  title: 'Builder',
})

export const buildStatusValues = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const

export const BuildStatus = StringEnum(buildStatusValues, {
  title: 'BuildStatus',
})

export const runKindValues = ['pre_deploy', 'cron', 'one_off', 'shell', 'hook', 'exec'] as const

export const RunKind = StringEnum(runKindValues, {
  title: 'RunKind',
})

export const runStatusValues = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
] as const

export const RunStatus = StringEnum(runStatusValues, {
  title: 'RunStatus',
})

export const attestationKindValues = ['sbom', 'provenance'] as const

export const AttestationKind = StringEnum(attestationKindValues, {
  title: 'AttestationKind',
})

export const componentNameValues = [
  'stationd',
  'dispatch',
  'gateway',
  'cloudflared',
  'buildkit',
  'depot',
  'litestream',
  'guard_image',
  'coupler_image',
  'railpack_frontend',
  'syft_scanner',
  'grype',
  'syft',
  'grype_db',
  'presets',
  'sandbox_toolchain',
  'runsc',
  'docker_engine',
] as const

export const ComponentName = StringEnum(componentNameValues, {
  title: 'ComponentName',
})

export const componentStatusValues = ['ok', 'drift', 'upgrading', 'failed'] as const

export const ComponentStatus = StringEnum(componentStatusValues, {
  title: 'ComponentStatus',
})

export const firewallModeValues = ['learn', 'enforce'] as const

export const FirewallMode = StringEnum(firewallModeValues, {
  title: 'FirewallMode',
})

export const flowVerdictValues = ['allowed', 'blocked', 'learned'] as const

export const FlowVerdict = StringEnum(flowVerdictValues, {
  title: 'FlowVerdict',
})

export const ingressValues = ['direct', 'tunnel'] as const

export const Ingress = StringEnum(ingressValues, {
  title: 'Ingress',
})

export const scheduleConcurrencyValues = ['skip', 'allow'] as const

export const volumeOwnerValues = ['service', 'station'] as const

export const doctorStatusValues = ['ok', 'warn', 'fail'] as const

export const actorTypeValues = ['user', 'token', 'oauth_client', 'station', 'system'] as const

export const ActorType = StringEnum(actorTypeValues, {
  title: 'ActorType',
})

export const Actor = Type.Object(
  {
    type: ActorType,
    id: Nullable(Type.String()),
    client: Nullable(Type.String()),
  },
  {
    title: 'Actor',
  },
)

export const EntityRef = Type.Object(
  {
    entity: Type.String(),
    id: Type.String(),
  },
  {
    title: 'EntityRef',
  },
)

export const ErrorBody = Type.Object(
  {
    code: Type.String({
      pattern: '^[A-Z][A-Z0-9_]*$',
    }),
    explanation: Type.String(),
    fix: Type.String(),
    details: Type.Optional(JsonObject),
  },
  {
    title: 'ErrorBody',
  },
)

export const Untrusted = Type.Object(
  {
    source: Type.String(),
    text: Type.String(),
  },
  {
    title: 'Untrusted',
  },
)

export const ListeningSocket = Type.Object(
  {
    address: Type.String(),
    port: Type.Integer({
      minimum: 0,
      maximum: 65535,
    }),
    protocol: StringEnum(['tcp', 'udp'], {
      title: 'NetworkProtocol',
    }),
  },
  {
    title: 'ListeningSocket',
  },
)

export const diagnosisPhaseValues = [
  'preflight',
  'build',
  'pre_deploy',
  'start',
  'health',
  'cutover',
  'recovery',
  'run',
  'route',
  'certificate',
  'unpack',
  'disk',
  'network',
] as const

export const DiagnosisPhase = StringEnum(diagnosisPhaseValues, {
  title: 'DiagnosisPhase',
})

export const Diagnosis = Type.Object(
  {
    entity: Type.Optional(
      Type.Object({
        type: StringEnum(['deployment', 'build', 'run', 'sandbox']),
        id: Type.String(),
      }),
    ),
    phase: DiagnosisPhase,
    code: Type.String({
      pattern: '^[A-Z][A-Z0-9_]*$',
    }),
    summary: Type.String(),
    exit_code: Type.Optional(Nullable(Type.Integer())),
    oom_killed: Type.Optional(Type.Boolean()),
    health: Type.Optional(
      Type.Object({
        type: Type.String(),
        path: Type.Optional(Type.String()),
        port: Type.Optional(Port),
        result: Type.String(),
        attempts: Count,
      }),
    ),
    logs: Type.Optional(
      Type.Object({
        source: Type.String(),
        untrusted: Untrusted,
        truncated: Type.Boolean(),
        cursor: Nullable(Type.String()),
      }),
    ),
    network: Type.Optional(
      Type.Object({
        listening: Type.Array(ListeningSocket),
      }),
    ),
    guard: Type.Optional(
      Type.Object({
        blocked: Type.Array(
          Type.Object({
            destination: Type.String(),
            port: Port,
            count: Count,
          }),
        ),
      }),
    ),
    resources: Type.Optional(
      Type.Object({
        memory_limit_bytes: Bytes,
        memory_peak_bytes: Bytes,
      }),
    ),
    diff_from_last_good: Type.Optional(
      Type.Object({
        deployment_id: Id('deployment'),
        source: Type.Optional(
          Type.Object({
            from_sha: Type.String(),
            to_sha: Type.String(),
            files_changed: Count,
          }),
        ),
        variables: Type.Optional(
          Type.Array(
            Type.Object({
              key: Type.String(),
              from_version: Count,
              to_version: Count,
            }),
          ),
        ),
        config: Type.Optional(
          Type.Array(
            Type.Object({
              path: Type.String(),
              from: Json,
              to: Json,
            }),
          ),
        ),
        base_images: Type.Optional(
          Type.Array(
            Type.Object({
              ref: Type.String(),
              from: Type.String(),
              to: Type.String(),
            }),
          ),
        ),
      }),
    ),
    fixes: Type.Optional(
      Type.Array(
        Type.Object({
          code: Type.String(),
          text: Type.String(),
          action: Type.Optional(
            Type.Object({
              tool: Type.String(),
              input: JsonObject,
            }),
          ),
        }),
      ),
    ),
    events: Type.Optional(
      Type.Array(
        Type.Object({
          at: Timestamp,
          step: DeploymentStepName,
          status: DeploymentStepStatus,
        }),
      ),
    ),
    details: Type.Optional(JsonObject),
  },
  {
    title: 'Diagnosis',
  },
)

export const Resources = Type.Object(
  {
    cpu_millis: Count,
    memory_bytes: Bytes,
    disk_bytes: Bytes,
    disk_free_bytes: Bytes,
    sandbox_disk_bytes: Type.Optional(Bytes),
    sandbox_disk_free_bytes: Type.Optional(Bytes),
  },
  {
    title: 'Resources',
  },
)

export const StationCapabilities = Type.Object(
  {
    gpus: Type.Optional(
      Type.Array(
        Type.Object({
          vendor: Type.String(),
          model: Type.String(),
          vram_bytes: Bytes,
          index: Count,
        }),
      ),
    ),
    gpu_mode: Type.Optional(StringEnum(['all', 'indexed'])),
    pinned_memory_limited: Type.Optional(Type.Boolean()),
    uvm: Type.Optional(Type.Boolean()),
    cdi: Type.Optional(Type.Boolean()),
    kernel: Type.String(),
    wsl_kernel: Type.Optional(Nullable(Type.String())),
    windows_build: Type.Optional(Nullable(Type.String())),
    docker_version: Type.String(),
    stationd_version: Type.String(),
    sandboxes: Type.Optional(
      Nullable(
        Type.Object(
          {
            runsc_version: Type.String(),
            platform: Type.Literal('systrap'),
            filesystem_backing: StringEnum(['device', 'loop_file'], {
              title: 'SandboxFilesystemBacking',
            }),
            filesystem_bytes: Bytes,
            filesystem_free_bytes: Bytes,
            filesystem_max_bytes: Bytes,
          },
          {
            title: 'SandboxCapability',
          },
        ),
      ),
    ),
  },
  {
    title: 'StationCapabilities',
  },
)

export const StationRoutes = Type.Unknown({
  title: 'StationRoutes',
})

export const Limits = Type.Object(
  {
    cpu_millis: Count,
    memory_bytes: Bytes,
  },
  {
    title: 'Limits',
  },
)

const healthTiming = {
  interval_s: Seconds,
  timeout_s: Seconds,
  startup_timeout_s: Seconds,
  passes: Count,
  failures: Count,
}

export const HealthCheck = Type.Union(
  [
    Type.Object({
      type: Type.Literal('http'),
      path: Type.String(),
      port: Port,
      host: Type.Optional(Type.String()),
      ...healthTiming,
    }),
    Type.Object({
      type: Type.Literal('tcp'),
      port: Port,
      ...healthTiming,
    }),
    Type.Object({
      type: Type.Literal('image'),
    }),
    Type.Object({
      type: Type.Literal('alive'),
      seconds: Seconds,
    }),
  ],
  {
    title: 'HealthCheck',
  },
)

export const Schedule = Type.Object(
  {
    cron: Type.String(),
    timezone: Type.String(),
    concurrency: StringEnum(scheduleConcurrencyValues, {
      title: 'ScheduleConcurrency',
    }),
  },
  {
    title: 'Schedule',
  },
)

export const healthStateValues = ['passing', 'failing', 'failed', 'none'] as const

export const HealthState = StringEnum(healthStateValues, {
  title: 'HealthState',
})

export const ServiceHealth = Type.Object(
  {
    state: HealthState,
    consecutive: Count,
    last_check: Nullable(Timestamp),
  },
  {
    title: 'ServiceHealth',
  },
)

export const statusHintValues = ['running', 'stopped', 'restarting', 'asleep'] as const

export const StatusHint = StringEnum(statusHintValues, {
  title: 'StatusHint',
})

export const appliedStatusValues = ['applied', 'partial', 'rejected'] as const

export const AppliedStatus = StringEnum(appliedStatusValues, {
  title: 'AppliedStatus',
})

export const AppliedGeneration = Type.Object(
  {
    number: Count,
    hash: Nullable(Type.String()),
    status: Nullable(AppliedStatus),
  },
  {
    title: 'AppliedGeneration',
  },
)

export const BlobGrant = Type.Object(
  {
    blob_id: Id('blob'),
    size: Bytes,
    sha256: Type.String({
      pattern: '^[0-9a-f]{64}$',
    }),
    token: Type.String(),
    expires_at: Timestamp,
  },
  {
    title: 'BlobGrant',
  },
)

export const BaseImage = Type.Object(
  {
    ref: Type.String(),
    digest: Type.String(),
  },
  {
    title: 'BaseImage',
  },
)

export const RunRow = Type.Object(
  {
    id: Id('run'),
    service_id: Id('service'),
    deployment_id: Nullable(Id('deployment')),
    kind: RunKind,
    command: Type.Array(Type.String()),
    status: RunStatus,
    exit_code: Nullable(Type.Integer()),
    failure: Nullable(Diagnosis),
    log_ref: Type.String(),
    started_at: Nullable(Timestamp),
    finished_at: Nullable(Timestamp),
  },
  {
    title: 'RunRow',
  },
)

export const FlowRollupRow = Type.Object(
  {
    service_id: Id('service'),
    deployment_id: Id('deployment'),
    minute: Timestamp,
    destination: Type.Union([
      Type.Object({
        domain: Type.String(),
      }),
      Type.Object({
        ip: Type.String(),
      }),
      Type.Object({
        service_id: Id('service'),
      }),
    ]),
    port: Port,
    protocol: Type.String(),
    verdict: FlowVerdict,
    connections: Count,
    bytes_out: Bytes,
    bytes_in: Bytes,
  },
  {
    title: 'FlowRollupRow',
  },
)

export const sandboxNetworkValues = ['isolated', 'environment'] as const

export const SandboxNetwork = StringEnum(sandboxNetworkValues, {
  title: 'SandboxNetwork',
})

export const sandboxStatusValues = [
  'creating',
  'starting',
  'running',
  'stopping',
  'stopped',
  'failed',
  'deleting',
] as const

export const sandboxReportStatusValues = [
  'creating',
  'starting',
  'running',
  'stopping',
  'stopped',
  'failed',
  'deleted',
] as const

export const SandboxReportStatus = StringEnum(sandboxReportStatusValues, {
  title: 'SandboxReportStatus',
})

export const sandboxStatusReasonValues = [
  'user',
  'ttl',
  'exited',
  'oom',
  'created_stopped',
  'station_restart',
] as const

export const SandboxStatusReason = StringEnum(sandboxStatusReasonValues, {
  title: 'SandboxStatusReason',
})

export const sandboxSnapshotStatusValues = ['creating', 'ready', 'failed', 'deleting'] as const

export const sandboxSourceStateValues = ['running', 'stopped'] as const

export const sandboxEgressModeValues = ['open', 'allowlist'] as const

export const sandboxLimitsDefaults = {
  max_sandboxes: 100,
  max_running: 20,
  memory_bytes: null,
  min_free_bytes: null,
} as const

export const sandboxTtl = {
  min: 60,
  max: 2592000,
  default: 3600,
} as const

export const sandboxEgressLimits = {
  domains: 256,
  ports: 8,
} as const

export const SandboxSize = Type.Object(
  {
    cpu_millis: Type.Integer({
      minimum: 1,
    }),
    memory_bytes: Type.Integer({
      minimum: 1,
    }),
    disk_bytes: Type.Integer({
      minimum: 1,
    }),
  },
  {
    title: 'SandboxSize',
  },
)

export const SandboxEgressDomain = Type.Object(
  {
    domain: Type.String(),
    wildcard: Type.Boolean(),
    ports: Type.Array(Port),
  },
  {
    title: 'SandboxEgressDomain',
  },
)

export const SandboxEgress = Type.Object(
  {
    mode: StringEnum(sandboxEgressModeValues, {
      title: 'SandboxEgressMode',
    }),
    domains: Type.Array(SandboxEgressDomain),
  },
  {
    title: 'SandboxEgress',
  },
)

export const SandboxLimits = Type.Object(
  {
    max_sandboxes: Count,
    max_running: Count,
    memory_bytes: Nullable(Bytes),
    min_free_bytes: Nullable(Bytes),
  },
  {
    title: 'SandboxLimits',
  },
)
