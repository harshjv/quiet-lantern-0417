import { Type, type Static } from '@sinclair/typebox'

import {
  AppliedGeneration,
  CancelReason,
  ComponentStatus,
  DeploymentOutcome,
  DeploymentStepName,
  DeploymentStepStatus,
  Diagnosis,
  ErrorBody,
  Resources,
  RunKind,
  RunStatus,
  SandboxReportStatus,
  SandboxStatusReason,
  ServiceHealth,
  StationCapabilities,
  StationRoutes,
  StatusHint,
} from './model.ts'
import {
  Bytes,
  Count,
  Id,
  IdMap,
  JsonObject,
  Nullable,
  StringEnum,
  Timestamp,
} from './primitives.ts'

export const ObjectResult = StringEnum(['ok', 'pending', 'failed', 'blocked'], {
  title: 'ObjectResult',
})

const appliedHash = Nullable(Type.String())

const outcome = {
  result: ObjectResult,
  failure: Type.Optional(ErrorBody),
  blocked_by: Type.Optional(Type.String()),
}

export const ObservedContainer = Type.Object(
  {
    role: Type.String(),
    deployment_id: Nullable(Id('deployment')),
    run_id: Nullable(Id('run')),
    container_id: Type.String(),
    address: Nullable(Type.String()),
    state: Type.String(),
    exit_code: Nullable(Type.Integer()),
    restarts: Count,
    started_at: Nullable(Timestamp),
  },
  {
    title: 'ObservedContainer',
  },
)

export const ObservedStation = Type.Object(
  {
    resources: Resources,
    routes: StationRoutes,
    capabilities: StationCapabilities,
    clock_skew_ms: Type.Integer(),
    docker_version: Type.String(),
    registry: Type.Object(
      {
        state: StringEnum(['serving', 'readonly', 'down'], {
          title: 'RegistryState',
        }),
      },
      {
        title: 'ObservedRegistry',
      },
    ),
  },
  {
    title: 'ObservedStation',
  },
)

export const ObservedComponent = Type.Object(
  {
    version: Type.String(),
    digest: Nullable(Type.String()),
    container_id: Nullable(Type.String()),
    status: ComponentStatus,
  },
  {
    title: 'ObservedComponent',
  },
)

export const ObservedEnvironment = Type.Object(
  {
    applied_hash: appliedHash,
    ...outcome,
    docker_network_id: Nullable(Type.String()),
    bridge_up: Type.Boolean(),
  },
  {
    title: 'ObservedEnvironment',
  },
)

export const ObservedService = Type.Object(
  {
    applied_hash: appliedHash,
    ...outcome,
    status_hint: StatusHint,
    health: ServiceHealth,
    containers: Type.Array(ObservedContainer),
    switch_address: Nullable(Type.String()),
  },
  {
    title: 'ObservedService',
  },
)

export const ObservedDeploymentStep = Type.Object(
  {
    step: DeploymentStepName,
    status: DeploymentStepStatus,
    attempt: Count,
    detail: JsonObject,
    started_at: Nullable(Timestamp),
    finished_at: Nullable(Timestamp),
  },
  {
    title: 'ObservedDeploymentStep',
  },
)

export const ObservedDeployment = Type.Object(
  {
    applied_hash: appliedHash,
    step: DeploymentStepName,
    step_status: DeploymentStepStatus,
    attempt: Count,
    started_at: Nullable(Timestamp),
    steps: Type.Array(ObservedDeploymentStep),
    outcome: Nullable(DeploymentOutcome),
    failure: Nullable(Diagnosis),
    cancel_reason: Nullable(CancelReason),
    finished_at: Nullable(Timestamp),
  },
  {
    title: 'ObservedDeployment',
  },
)

export const ObservedVolume = Type.Object(
  {
    applied_hash: appliedHash,
    ...outcome,
    size_bytes: Bytes,
    mounted_by: Type.Array(Type.String()),
  },
  {
    title: 'ObservedVolume',
  },
)

export const ObservedRun = Type.Object(
  {
    service_id: Id('service'),
    deployment_id: Nullable(Id('deployment')),
    kind: RunKind,
    command: Type.Array(Type.String()),
    status: RunStatus,
    exit_code: Nullable(Type.Integer()),
    failure: Nullable(Diagnosis),
    log_ref: Type.String(),
    scheduled_at: Nullable(Timestamp),
    started_at: Nullable(Timestamp),
    finished_at: Nullable(Timestamp),
  },
  {
    title: 'ObservedRun',
  },
)

export const ObservedRoute = Type.Object(
  {
    applied_hash: appliedHash,
    ...outcome,
    certificate: Nullable(
      Type.Object(
        {
          status: StringEnum(['pending', 'valid', 'expired', 'failed'], {
            title: 'CertificateStatus',
          }),
          not_before: Nullable(Timestamp),
          expires_at: Nullable(Timestamp),
          failure: Nullable(ErrorBody),
        },
        {
          title: 'ObservedCertificate',
        },
      ),
    ),
    probe: Nullable(
      Type.Object(
        {
          ok: Type.Boolean(),
          status_code: Nullable(Type.Integer()),
        },
        {
          title: 'ObservedRouteProbe',
        },
      ),
    ),
  },
  {
    title: 'ObservedRoute',
  },
)

export const ObservedGateway = Type.Object(
  {
    applied_hash: appliedHash,
    routes: IdMap(ObservedRoute),
  },
  {
    title: 'ObservedGateway',
  },
)

export const ObservedPortAllocation = Type.Object(
  {
    applied_hash: appliedHash,
    ...outcome,
  },
  {
    title: 'ObservedPortAllocation',
  },
)

export const ObservedWorkshop = Type.Object(
  {
    applied_hash: appliedHash,
    running: Type.Boolean(),
    cache_bytes: Bytes,
    builds_running: Count,
  },
  {
    title: 'ObservedWorkshop',
  },
)

export const ObservedSystemTarget = Type.Object(
  {
    applied_hash: appliedHash,
    ...outcome,
    address: Nullable(Type.String()),
  },
  {
    title: 'ObservedSystemTarget',
  },
)

export const ObservedSandbox = Type.Object(
  {
    applied_hash: appliedHash,
    ...outcome,
    status: SandboxReportStatus,
    reason: Nullable(SandboxStatusReason),
    started_at: Nullable(Timestamp),
    stop_at: Nullable(Timestamp),
    address: Nullable(Type.String()),
    disk: Type.Object(
      {
        referenced_bytes: Bytes,
        exclusive_bytes: Bytes,
        limit_bytes: Bytes,
      },
      {
        title: 'ObservedSandboxDisk',
      },
    ),
    runsc_version: Nullable(Type.String()),
  },
  {
    title: 'ObservedSandbox',
  },
)

export const ObservedSandboxSnapshot = Type.Object(
  {
    applied_hash: appliedHash,
    ...outcome,
    taken_at: Nullable(Timestamp),
    referenced_bytes: Bytes,
    exclusive_bytes: Bytes,
  },
  {
    title: 'ObservedSandboxSnapshot',
  },
)

export const ObservedSandboxBase = Type.Object(
  {
    state: StringEnum(['unpacking', 'ready', 'failed'], {
      title: 'SandboxBaseState',
    }),
    referenced_bytes: Bytes,
  },
  {
    title: 'ObservedSandboxBase',
  },
)

export const UnknownObject = Type.Object(
  {
    kind: StringEnum(['container', 'network', 'volume', 'sandbox_disk', 'sandbox_snapshot'], {
      title: 'UnknownObjectKind',
    }),
    id: Type.Optional(Type.String()),
    docker_id: Type.Optional(Type.String()),
    labels: Type.Optional(Type.Record(Type.String(), Type.String())),
  },
  {
    title: 'UnknownObject',
  },
)

const observedMaps = {
  components: IdMap(ObservedComponent),
  environments: IdMap(ObservedEnvironment),
  services: IdMap(ObservedService),
  deployments: IdMap(ObservedDeployment),
  volumes: IdMap(ObservedVolume),
  runs: IdMap(ObservedRun),
  gateway: ObservedGateway,
  port_allocations: IdMap(ObservedPortAllocation),
  workshops: IdMap(ObservedWorkshop),
  system_targets: IdMap(ObservedSystemTarget),
  sandboxes: Type.Optional(IdMap(ObservedSandbox)),
  sandbox_snapshots: Type.Optional(IdMap(ObservedSandboxSnapshot)),
  sandbox_bases: Type.Optional(IdMap(ObservedSandboxBase)),
}

export const Observed = Type.Object(
  {
    station_id: Id('station'),
    observed_at: Timestamp,
    applied: AppliedGeneration,
    station: ObservedStation,
    ...observedMaps,
    unknown: Type.Array(UnknownObject),
  },
  {
    title: 'Observed',
  },
)

export const ObservedUpdate = Type.Object(
  {
    observed_at: Timestamp,
    station: Type.Optional(ObservedStation),
    components: Type.Optional(observedMaps.components),
    environments: Type.Optional(observedMaps.environments),
    services: Type.Optional(observedMaps.services),
    deployments: Type.Optional(observedMaps.deployments),
    volumes: Type.Optional(observedMaps.volumes),
    runs: Type.Optional(observedMaps.runs),
    gateway: Type.Optional(observedMaps.gateway),
    port_allocations: Type.Optional(observedMaps.port_allocations),
    workshops: Type.Optional(observedMaps.workshops),
    system_targets: Type.Optional(observedMaps.system_targets),
    sandboxes: observedMaps.sandboxes,
    sandbox_snapshots: observedMaps.sandbox_snapshots,
    sandbox_bases: observedMaps.sandbox_bases,
  },
  {
    title: 'ObservedUpdateBody',
  },
)

export type Observed = Static<typeof Observed>
