import { Type, type Static } from '@sinclair/typebox'
import {
  CancelReason,
  DesiredState,
  FirewallMode,
  HealthCheck,
  Ingress,
  Injection,
  Limits,
  PortProtocol,
  SandboxEgress,
  SandboxNetwork,
  SandboxSize,
  Schedule,
  ServiceKind,
  Strategy
} from './model.ts'
import { Bytes, Count, Digest, Id, IdMap, Json, Nullable, Port, Seconds, StringEnum, Timestamp } from './primitives.ts'

export const StationSettings = Type.Object(
  {
    'ipam.pool': Type.String(),
    'ipam.virtual_prefix': Type.String(),
    'exposure.port_range': Type.String(),
    'disk.warning_pct': Count,
    'disk.critical_pct': Count,
    'logs.retention.runtime_days': Type.Optional(Count),
    'logs.retention.build_days': Type.Optional(Count),
    'logs.retention.run_days': Type.Optional(Count),
    'logs.retention.system_days': Type.Optional(Count),
    'logs.retention.runtime_bytes_per_service': Type.Optional(Bytes),
    'workshop.idle_timeout_s': Seconds,
    'workshop.max_builds_per_project': Count,
    'registry.gc_schedule': Type.String(),
    'acme.email': Type.String(),
    'platform.lockfile': Type.Optional(Json),
    'platform.allow_unsigned': Type.Boolean(),
    'gaming.quiet_period_s': Type.Optional(Seconds),
    'gateway.rate_per_source': Count
  },
  { title: 'StationSettings' }
)

export const Subnet = Type.Object(
  {
    subnet: Type.String(),
    gateway: Type.String()
  },
  { title: 'Subnet' }
)

export const DesiredStation = Type.Object(
  {
    settings: StationSettings,
    registry: Type.Object(
      {
        address: Type.String(),
        subnet: Type.String(),
        token_issuer: Type.Literal('stationd'),
        pull_scope: Type.Literal('station'),
        key_ref: Type.String()
      },
      { title: 'StationRegistry' }
    ),
    networks: Type.Object(
      {
        system: Subnet,
        ingress: Subnet
      },
      { title: 'StationNetworks' }
    ),
    inbound: Type.Object(
      {
        mode: Ingress,
        web_ports: StringEnum(['open', 'closed'], { title: 'WebPorts' }),
        setup_port_until: Nullable(Timestamp)
      },
      { title: 'StationInbound' }
    ),
    public_address: Nullable(Type.String()),
    concurrency_cap: Count,
    intermittent: Type.Optional(Type.Boolean()),
    sleep_schedule: Type.Optional(Nullable(Json)),
    hosts_dispatch: Type.Boolean(),
    sandbox_network: Type.Optional(
      Nullable(
        Type.Object(
          {
            bridge_name: Type.Literal('stationly-sandbox'),
            subnet: Type.String(),
            gateway: Type.String()
          },
          { title: 'SandboxNetworkDesired' }
        )
      )
    )
  },
  { title: 'DesiredStation' }
)

export const ComponentPin = Type.Object(
  {
    version: Type.String(),
    digest: Nullable(Digest)
  },
  { title: 'ComponentPin' }
)

export const DnsRecord = Type.Object(
  {
    name: Type.String(),
    virtual_ip: Type.String(),
    kind: StringEnum(['service', 'alias'], { title: 'DnsRecordKind' }),
    target_service_id: Id('service')
  },
  { title: 'DnsRecord' }
)

export const EnvironmentVirtualIp = Type.Object(
  {
    id: Id('virtual_ip'),
    address: Type.String(),
    service_id: Id('service')
  },
  { title: 'EnvironmentVirtualIp' }
)

export const DesiredAttachment = Type.Object(
  {
    id: Id('attachment'),
    alias: Type.String(),
    shared_service_id: Id('service'),
    virtual_ip: Type.String(),
    address_on_bridge: Type.String()
  },
  { title: 'DesiredAttachment' }
)

export const DesiredEnvironment = Type.Object(
  {
    hash: Digest,
    project_id: Id('project'),
    name: Type.String(),
    ipam_allocation_id: Id('ipam_allocation'),
    network: Type.Object(
      {
        bridge_name: Type.String(),
        subnet: Type.String(),
        gateway: Type.String(),
        gateway_mode: StringEnum(['nat', 'routed'], { title: 'GatewayMode' })
      },
      { title: 'EnvironmentNetwork' }
    ),
    dns: Type.Array(DnsRecord),
    virtual_ips: Type.Array(EnvironmentVirtualIp),
    attachments: Type.Optional(Type.Array(DesiredAttachment))
  },
  { title: 'DesiredEnvironment' }
)

export const EnvRef = Type.Union(
  [
    Type.Object({ secret_value_id: Id('secret_value'), version: Count }),
    Type.Object({ export: Type.Object({ service_id: Id('service'), key: Type.String() }, { title: 'ExportTarget' }) })
  ],
  { title: 'EnvRef' }
)

export const EnvEntry = Type.Object(
  {
    key: Type.String(),
    injection: Injection,
    refs: Type.Array(EnvRef),
    value: Type.Optional(Type.String()),
    platform: Type.Boolean()
  },
  { title: 'EnvEntry' }
)

export const ContainerSpec = Type.Object(
  {
    image_ref: Type.String({ pattern: '^[^@]+@sha256:[0-9a-f]{64}$' }),
    command: Nullable(Type.Array(Type.String())),
    limits: Limits,
    health: Nullable(HealthCheck),
    ports: Type.Array(
      Type.Object(
        {
          id: Id('service_port'),
          port: Port,
          protocol: PortProtocol,
          grpc: Type.Boolean()
        },
        { title: 'ContainerPort' }
      )
    ),
    volumes: Type.Array(Type.Object({ volume_id: Id('volume'), mount_path: Type.String() }, { title: 'VolumeMount' })),
    readonly_rootfs: Type.Boolean(),
    secrets_owner: Nullable(Type.Object({ uid: Type.Integer({ minimum: 0 }), gid: Type.Integer({ minimum: 0 }) }, { title: 'SecretsOwner' })),
    drain_timeout_s: Seconds,
    strategy: Nullable(Strategy),
    pre_deploy: Nullable(Type.Array(Type.String())),
    schedule: Nullable(Schedule),
    gpu: Type.Optional(Nullable(Type.Object({ count: Count }, { title: 'GpuRequest' }))),
    env: Type.Array(EnvEntry),
    env_digest: Digest
  },
  { title: 'ContainerSpec' }
)

export const DesiredService = Type.Object(
  {
    hash: Digest,
    environment_id: Id('environment'),
    project_id: Id('project'),
    name: Type.String(),
    kind: ServiceKind,
    desired_state: DesiredState,
    virtual_ip: Type.String(),
    current: Nullable(
      Type.Object(
        {
          deployment_id: Id('deployment'),
          number: Count,
          spec: ContainerSpec
        },
        { title: 'CurrentDeployment' }
      )
    ),
    reach: Type.Array(Id('virtual_ip')),
    firewall: Type.Optional(
      Type.Object(
        {
          policy_id: Id('firewall_policy'),
          generation: Count,
          mode: FirewallMode,
          learn_until: Nullable(Timestamp)
        },
        { title: 'ServiceFirewall' }
      )
    )
  },
  { title: 'DesiredService' }
)

export const DesiredDeployment = Type.Object(
  {
    hash: Digest,
    service_id: Id('service'),
    number: Count,
    target: ContainerSpec,
    from_deployment_id: Nullable(Id('deployment')),
    strategy: Strategy,
    budget: Type.Object(
      {
        pull_s: Seconds,
        start_s: Seconds,
        health_s: Seconds,
        drain_s: Seconds,
        total_s: Seconds
      },
      { title: 'DeploymentBudget' }
    ),
    supersedes: Nullable(Id('deployment')),
    cancel: Nullable(Type.Object({ reason: CancelReason }, { title: 'DeploymentCancel' }))
  },
  { title: 'DesiredDeployment' }
)

export const DesiredVolume = Type.Object(
  {
    hash: Digest,
    owner: StringEnum(['service', 'station'], { title: 'VolumeOwner' }),
    service_id: Nullable(Id('service')),
    docker_name: Type.String(),
    status: StringEnum(['active', 'retained', 'destroy'], { title: 'DesiredVolumeStatus' }),
    retain_until: Nullable(Timestamp)
  },
  { title: 'DesiredVolume' }
)

export const RouteTarget = Type.Union(
  [
    Type.Object({ service_id: Id('service'), virtual_ip: Type.String(), port: Port }),
    Type.Object({ system: Type.Literal('dispatch'), virtual_ip: Type.String(), port: Port })
  ],
  { title: 'RouteTarget' }
)

export const Route = Type.Object(
  {
    hash: Digest,
    hostname: Type.String(),
    ingress: Ingress,
    target: RouteTarget,
    tls: Nullable(Type.Object({ resolver: StringEnum(['letsencrypt', 'letsencrypt-shortlived'], { title: 'CertResolver' }) }, { title: 'RouteTls' })),
    redirect_http: Type.Boolean()
  },
  { title: 'Route' }
)

export const DesiredGateway = Type.Object(
  {
    hash: Digest,
    acme: Type.Object(
      {
        email: Type.String(),
        ca_server: Nullable(Type.String())
      },
      { title: 'GatewayAcme' }
    ),
    routes: IdMap(Route)
  },
  { title: 'DesiredGateway' }
)

export const DesiredPortAllocation = Type.Object(
  {
    hash: Digest,
    service_port_id: Id('service_port'),
    service_id: Id('service'),
    host_port: Port,
    protocol: Type.Literal('tcp'),
    virtual_ip: Type.String(),
    container_port: Port
  },
  { title: 'DesiredPortAllocation' }
)

export const DesiredWorkshop = Type.Object(
  {
    hash: Digest,
    cache: Type.Object(
      {
        reserved_bytes: Bytes,
        max_used_bytes: Bytes,
        min_free_bytes: Bytes
      },
      { title: 'WorkshopCache' }
    ),
    max_builds: Count,
    idle_timeout_s: Seconds,
    uid_base: Type.Integer({ minimum: 65536 }),
    image_retention_count: Count,
    registry_scope: Type.String(),
    mirrors: Type.Array(StringEnum(['ghcr.io', 'docker.io'], { title: 'RegistryMirror' })),
    build_policy: Type.Optional(Type.Object({ policy_id: Id('firewall_policy'), generation: Count }, { title: 'WorkshopBuildPolicy' }))
  },
  { title: 'DesiredWorkshop' }
)

export const SystemTarget = Type.Object(
  {
    hash: Digest,
    component: Type.String(),
    virtual_ip: Type.String(),
    port: Port
  },
  { title: 'SystemTarget' }
)

export const DesiredSandbox = Type.Object(
  {
    hash: Digest,
    environment_id: Id('environment'),
    project_id: Id('project'),
    name: Type.String(),
    status: StringEnum(['active', 'destroy'], { title: 'DesiredSandboxStatus' }),
    desired_state: DesiredState,
    stop_at: Nullable(Timestamp),
    image: Type.Object(
      {
        ref: Nullable(Type.String()),
        digest: Digest,
        image_ref: Type.String({ pattern: '^[^@]+@sha256:[0-9a-f]{64}$' })
      },
      { title: 'DesiredSandboxImage' }
    ),
    command: Nullable(Type.Array(Type.String())),
    size: SandboxSize,
    docker: Type.Boolean(),
    env_digest: Digest,
    network: SandboxNetwork,
    egress: SandboxEgress,
    disk: Type.Object(
      {
        from: Nullable(
          Type.Union([Type.Object({ snapshot_id: Id('sandbox_snapshot') }), Type.Object({ sandbox_id: Id('sandbox') })], { title: 'SandboxDiskSource' })
        )
      },
      { title: 'SandboxDisk' }
    ),
    reach: Type.Array(Id('virtual_ip'))
  },
  { title: 'DesiredSandbox' }
)

export const DesiredSandboxSnapshot = Type.Object(
  {
    hash: Digest,
    sandbox_id: Id('sandbox'),
    status: StringEnum(['active', 'destroy'], { title: 'DesiredSandboxSnapshotStatus' })
  },
  { title: 'DesiredSandboxSnapshot' }
)

export const Generation = Type.Object(
  {
    schema: Type.Literal(1),
    instance_id: Id('instance'),
    station_id: Id('station'),
    number: Count,
    previous: Nullable(Count),
    hash: Digest,
    issued_at: Timestamp,
    resolution: Nullable(
      Type.Object(
        {
          drift_id: Id('drift'),
          mode: Type.Literal('force')
        },
        { title: 'DriftResolution' }
      )
    ),
    station: DesiredStation,
    components: IdMap(ComponentPin),
    environments: IdMap(DesiredEnvironment),
    services: IdMap(DesiredService),
    deployments: IdMap(DesiredDeployment),
    volumes: IdMap(DesiredVolume),
    gateway: DesiredGateway,
    port_allocations: IdMap(DesiredPortAllocation),
    workshops: IdMap(DesiredWorkshop),
    system_targets: IdMap(SystemTarget),
    sandboxes: Type.Optional(IdMap(DesiredSandbox)),
    sandbox_snapshots: Type.Optional(IdMap(DesiredSandboxSnapshot))
  },
  { title: 'Generation' }
)

export type Generation = Static<typeof Generation>
