import type { Static } from '@sinclair/typebox'
import { sql } from 'drizzle-orm'
import {
  blob as blobColumn,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

import {
  appliedStatusValues,
  attestationKindValues,
  baseImageCheckValues,
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
  doctorStatusValues,
  domainKindValues,
  domainStatusValues,
  firewallModeValues,
  flowVerdictValues,
  githubRepositorySelectionValues,
  grantSourceValues,
  ingressValues,
  injectionValues,
  notificationChannelKindValues,
  notificationChannelStatusValues,
  platformUpgradeStatusValues,
  portAllocationStatusValues,
  portProtocolValues,
  releaseChannelValues,
  repoAuthValues,
  runKindValues,
  runStatusValues,
  sandboxNetworkValues,
  sandboxSnapshotStatusValues,
  sandboxSourceStateValues,
  sandboxStatusReasonValues,
  sandboxStatusValues,
  serviceKindValues,
  serviceStatusReasonValues,
  serviceStatusValues,
  signatureStateValues,
  stagedChangeSourceValues,
  stagedChangeStatusValues,
  staleReasonCodeValues,
  stationArchValues,
  stationOsValues,
  stationStatusValues,
  strategyValues,
  tokenKindValues,
  variableKindValues,
  variableScopeValues,
  versionSkewValues,
  volumeOwnerValues,
  volumeSnapshotSourceValues,
  volumeSnapshotStatusValues,
  volumeSnapshotTriggerValues,
  volumeStatusValues,
  type Actor,
  type Diagnosis,
  type ErrorBody,
  type Generation,
  type IdEntity,
  type ReleaseManifestDoc,
  type Resources,
  type SandboxEgress,
  type SandboxLimits,
  type SandboxSize,
  type StationCapabilities,
} from '@stationly/protocol'

import { newId } from './ids.ts'

type ActorValue = Static<typeof Actor>
type DiagnosisValue = Static<typeof Diagnosis>
type ErrorBodyValue = Static<typeof ErrorBody>
export type StaleReasonValue = {
  code: (typeof staleReasonCodeValues)[number]
  explanation: string
  keys: string[]
}
type EntityTarget = { entity: string; id: string }
export type BaseImageRecord = {
  ref: string
  digest: string
  check: (typeof baseImageCheckValues)[number]
  checked_at?: string | null
  latest_digest?: string | null
}
type JsonObject = Record<string, unknown>

const timestamp = (name: string) =>
  integer(name, {
    mode: 'timestamp_ms',
  })
const bool = (name: string) =>
  integer(name, {
    mode: 'boolean',
  })
const json = <T>(name: string) =>
  text(name, {
    mode: 'json',
  }).$type<T>()
const bytes = (name: string) =>
  blobColumn(name, {
    mode: 'buffer',
  })

const entity = (kind: IdEntity) => ({
  id: text('id')
    .primaryKey()
    .$defaultFn(() => newId(kind)),
  created_at: timestamp('created_at')
    .notNull()
    .$defaultFn(() => new Date()),
  updated_at: timestamp('updated_at')
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date()),
})

export const station = sqliteTable(
  'station',
  {
    ...entity('station'),
    name: text('name').notNull(),
    public_key: text('public_key'),
    endpoint: text('endpoint'),
    relay: bool('relay').notNull().default(false),
    os: text('os', {
      enum: stationOsValues,
    }),
    arch: text('arch', {
      enum: stationArchValues,
    }),
    capabilities: json<Static<typeof StationCapabilities>>('capabilities'),
    intermittent: bool('intermittent').notNull().default(false),
    routes: json<unknown>('routes'),
    resources: json<Static<typeof Resources>>('resources'),
    status: text('status', {
      enum: stationStatusValues,
    })
      .notNull()
      .default('enrolling'),
    draining: bool('draining').notNull().default(false),
    generation: integer('generation').notNull().default(0),
    last_seen_at: timestamp('last_seen_at'),
    version_skew: text('version_skew', {
      enum: versionSkewValues,
    })
      .notNull()
      .default('ok'),
    concurrency_cap: integer('concurrency_cap').notNull().default(2),
    tracks_address: text('tracks_address'),
    registry_subnet: text('registry_subnet'),
    registry_address: text('registry_address'),
    hosts_dispatch: bool('hosts_dispatch').notNull().default(false),
    generation_hash: text('generation_hash'),
    sandbox_subnet: text('sandbox_subnet'),
    sandbox_limits: json<Static<typeof SandboxLimits>>('sandbox_limits').notNull().default({
      max_sandboxes: 100,
      max_running: 20,
      memory_bytes: null,
      min_free_bytes: null,
    }),
    cloudflare_tunnel_id: text('cloudflare_tunnel_id'),
    public_address: text('public_address'),
    identity_key: text('identity_key'),
    sleep_schedule: json<unknown>('sleep_schedule'),
    revoked_at: timestamp('revoked_at'),
  },
  (table) => [uniqueIndex('station_name_unique').on(table.name)],
)

export const project = sqliteTable(
  'project',
  {
    ...entity('project'),
    name: text('name').notNull(),
    shared: bool('shared').notNull().default(false),
    manifest_path: text('manifest_path'),
    default_environment_id: text('default_environment_id').notNull(),
    build_policy_id: text('build_policy_id'),
    build_cache_bytes: integer('build_cache_bytes')
      .notNull()
      .default(10 * 1024 * 1024 * 1024),
    workshop_uid_base: integer('workshop_uid_base').notNull(),
    image_retention_count: integer('image_retention_count').notNull().default(5),
    base_image_auto_rebuild: bool('base_image_auto_rebuild').notNull().default(false),
    pr_environments: json<{ enabled: boolean; source_environment_id: string | null }>(
      'pr_environments',
    ).notNull(),
  },
  (table) => [
    uniqueIndex('project_name_unique').on(table.name),
    uniqueIndex('project_workshop_uid_base_unique').on(table.workshop_uid_base),
  ],
)

export const environment = sqliteTable(
  'environment',
  {
    ...entity('environment'),
    project_id: text('project_id')
      .notNull()
      .references(() => project.id),
    name: text('name').notNull(),
    protected: bool('protected').notNull().default(false),
    ephemeral: bool('ephemeral').notNull().default(false),
    source_environment_id: text('source_environment_id'),
    pull_request: json<{ repo: string; number: number; head_sha: string; fork: boolean }>(
      'pull_request',
    ),
    ttl_seconds: integer('ttl_seconds'),
  },
  (table) => [uniqueIndex('environment_project_name_unique').on(table.project_id, table.name)],
)

export const service = sqliteTable(
  'service',
  {
    ...entity('service'),
    environment_id: text('environment_id')
      .notNull()
      .references(() => environment.id),
    name: text('name').notNull(),
    kind: text('kind', {
      enum: serviceKindValues,
    }).notNull(),
    station_id: text('station_id')
      .notNull()
      .references(() => station.id),
    source: json<JsonObject>('source').notNull(),
    stale: bool('stale').notNull().default(false),
    stale_reasons: json<StaleReasonValue[]>('stale_reasons').notNull().default([]),
    command: json<string[]>('command'),
    build_args: json<Record<string, string>>('build_args'),
    limits: json<{ cpu_millis: number; memory_bytes: number }>('limits').notNull(),
    health: json<JsonObject>('health'),
    strategy: text('strategy', {
      enum: strategyValues,
    }).notNull(),
    multi_writer_safe: bool('multi_writer_safe').notNull().default(false),
    drain_timeout_s: integer('drain_timeout_s').notNull().default(30),
    readonly_rootfs: bool('readonly_rootfs').notNull().default(false),
    secrets_owner: json<{ uid: number; gid: number }>('secrets_owner'),
    best_effort: bool('best_effort').notNull().default(false),
    pre_deploy: json<string[]>('pre_deploy'),
    schedule: json<{ cron: string; timezone: string; concurrency: 'skip' | 'allow' }>('schedule'),
    firewall_policy_id: text('firewall_policy_id'),
    firewall_mode: text('firewall_mode', {
      enum: firewallModeValues,
    })
      .notNull()
      .default('learn'),
    learn_until: timestamp('learn_until'),
    gpu: json<{ count: number }>('gpu'),
    exports: json<string[]>('exports').notNull(),
    current_deployment_id: text('current_deployment_id'),
    status: text('status', {
      enum: serviceStatusValues,
    })
      .notNull()
      .default('amber'),
    status_reason: text('status_reason', {
      enum: serviceStatusReasonValues,
    }),
    desired_state: text('desired_state', {
      enum: desiredStateValues,
    })
      .notNull()
      .default('running'),
  },
  (table) => [uniqueIndex('service_environment_name_unique').on(table.environment_id, table.name)],
)

export type SandboxFailure = DiagnosisValue

export const sandbox = sqliteTable(
  'sandbox',
  {
    ...entity('sandbox'),
    environment_id: text('environment_id').notNull(),
    project_id: text('project_id').notNull(),
    station_id: text('station_id')
      .notNull()
      .references(() => station.id),
    name: text('name').notNull(),
    image: json<{ ref: string | null; digest: string }>('image').notNull(),
    command: json<string[]>('command'),
    size: json<Static<typeof SandboxSize>>('size').notNull(),
    network: text('network', {
      enum: sandboxNetworkValues,
    })
      .notNull()
      .default('isolated'),
    docker: bool('docker').notNull().default(false),
    egress: json<Static<typeof SandboxEgress>>('egress').notNull(),
    ttl_s: integer('ttl_s').notNull(),
    desired_state: text('desired_state', {
      enum: desiredStateValues,
    }).notNull(),
    stop_at: timestamp('stop_at'),
    status: text('status', {
      enum: sandboxStatusValues,
    }).notNull(),
    status_reason: text('status_reason', {
      enum: sandboxStatusReasonValues,
    }),
    exit_code: integer('exit_code'),
    failure: json<SandboxFailure>('failure'),
    forked_from: json<{ sandbox_id: string | null; snapshot_id: string | null }>('forked_from'),
    disk_from: json<{ snapshot_id: string } | { sandbox_id: string }>('disk_from'),
    address: text('address'),
    disk_used_bytes: integer('disk_used_bytes').notNull().default(0),
    started_at: timestamp('started_at'),
    stopped_at: timestamp('stopped_at'),
    expiring_notified_at: timestamp('expiring_notified_at'),
    deletion: json<{
      actor: ActorValue
      reason: 'user' | 'retention' | 'environment'
      requested_at: string
    }>('deletion'),
    created_by: json<ActorValue>('created_by').notNull(),
  },
  (table) => [
    uniqueIndex('sandbox_environment_name_unique').on(table.environment_id, table.name),
    index('sandbox_station').on(table.station_id),
  ],
)

export type SandboxSnapshotSettings = {
  network: (typeof sandboxNetworkValues)[number]
  docker: boolean
  egress: Static<typeof SandboxEgress>
  command: string[] | null
  ttl_s: number
}

export const sandbox_snapshot = sqliteTable(
  'sandbox_snapshot',
  {
    ...entity('sandbox_snapshot'),
    sandbox_id: text('sandbox_id').notNull(),
    environment_id: text('environment_id').notNull(),
    project_id: text('project_id').notNull(),
    station_id: text('station_id')
      .notNull()
      .references(() => station.id),
    name: text('name'),
    image: json<{ ref: string | null; digest: string }>('image').notNull(),
    size: json<Static<typeof SandboxSize>>('size').notNull(),
    settings: json<SandboxSnapshotSettings>('settings')
      .notNull()
      .default({
        network: 'isolated',
        docker: false,
        egress: {
          mode: 'open',
          domains: [],
        },
        command: null,
        ttl_s: 3600,
      }),
    source_state: text('source_state', {
      enum: sandboxSourceStateValues,
    }).notNull(),
    status: text('status', {
      enum: sandboxSnapshotStatusValues,
    }).notNull(),
    taken_at: timestamp('taken_at'),
    exclusive_bytes: integer('exclusive_bytes').notNull().default(0),
    referenced_bytes: integer('referenced_bytes').notNull().default(0),
    failure: json<DiagnosisValue>('failure'),
    created_by: json<ActorValue>('created_by').notNull(),
  },
  (table) => [
    uniqueIndex('sandbox_snapshot_environment_name_unique')
      .on(table.environment_id, table.name)
      .where(sql`name is not null`),
  ],
)

export const service_port = sqliteTable(
  'service_port',
  {
    ...entity('service_port'),
    service_id: text('service_id')
      .notNull()
      .references(() => service.id),
    port: integer('port').notNull(),
    protocol: text('protocol', {
      enum: portProtocolValues,
    }).notNull(),
    grpc: bool('grpc').notNull().default(false),
  },
  (table) => [uniqueIndex('service_port_service_port_unique').on(table.service_id, table.port)],
)

export const volume = sqliteTable('volume', {
  ...entity('volume'),
  owner: text('owner', {
    enum: volumeOwnerValues,
  }).notNull(),
  service_id: text('service_id').references(() => service.id),
  project_id: text('project_id').references(() => project.id),
  mount_path: text('mount_path').notNull(),
  station_id: text('station_id')
    .notNull()
    .references(() => station.id),
  docker_name: text('docker_name').notNull(),
  size_bytes: integer('size_bytes').notNull().default(0),
  status: text('status', {
    enum: volumeStatusValues,
  })
    .notNull()
    .default('active'),
  retain_until: timestamp('retain_until'),
})

export const domain = sqliteTable(
  'domain',
  {
    ...entity('domain'),
    service_port_id: text('service_port_id')
      .notNull()
      .references(() => service_port.id),
    hostname: text('hostname').notNull(),
    kind: text('kind', {
      enum: domainKindValues,
    }).notNull(),
    ingress: text('ingress', {
      enum: ingressValues,
    }).notNull(),
    cloudflare: json<{ zone_id: string; record_id: string }>('cloudflare'),
    certificate: json<{
      resolver: string
      status: string
      not_before: string | null
      expires_at: string | null
    }>('certificate'),
    status: text('status', {
      enum: domainStatusValues,
    })
      .notNull()
      .default('pending'),
    last_checked_at: timestamp('last_checked_at'),
    error: json<DiagnosisValue>('error'),
  },
  (table) => [uniqueIndex('domain_hostname_unique').on(table.hostname)],
)

export const port_allocation = sqliteTable(
  'port_allocation',
  {
    ...entity('port_allocation'),
    service_port_id: text('service_port_id')
      .notNull()
      .references(() => service_port.id),
    station_id: text('station_id')
      .notNull()
      .references(() => station.id),
    host_port: integer('host_port').notNull(),
    status: text('status', {
      enum: portAllocationStatusValues,
    })
      .notNull()
      .default('active'),
  },
  (table) => [
    uniqueIndex('port_allocation_station_host_port_active_unique')
      .on(table.station_id, table.host_port)
      .where(sql`status = 'active'`),
  ],
)

export const deployment = sqliteTable(
  'deployment',
  {
    ...entity('deployment'),
    service_id: text('service_id').notNull(),
    number: integer('number').notNull(),
    trigger: json<{
      type: (typeof deploymentTriggerValues)[number]
      actor: ActorValue
      source_sha: string | null
      rollback_of: string | null
    }>('trigger').notNull(),
    image_ref: text('image_ref'),
    build_id: text('build_id'),
    env_snapshot: json<JsonObject>('env_snapshot').notNull(),
    config_snapshot: json<JsonObject>('config_snapshot').notNull(),
    strategy: text('strategy', {
      enum: strategyValues,
    }).notNull(),
    status: text('status', {
      enum: deploymentStatusValues,
    })
      .notNull()
      .default('queued'),
    failure: json<DiagnosisValue>('failure'),
    cancel_reason: text('cancel_reason', {
      enum: cancelReasonValues,
    }),
    started_at: timestamp('started_at'),
    finished_at: timestamp('finished_at'),
    base_images: json<BaseImageRecord[]>('base_images').notNull(),
    image_pruned_at: timestamp('image_pruned_at'),
  },
  (table) => [uniqueIndex('deployment_service_number_unique').on(table.service_id, table.number)],
)

export const deployment_step = sqliteTable(
  'deployment_step',
  {
    ...entity('deployment_step'),
    deployment_id: text('deployment_id')
      .notNull()
      .references(() => deployment.id),
    step: text('step', {
      enum: deploymentStepNameValues,
    }).notNull(),
    status: text('status', {
      enum: deploymentStepStatusValues,
    }).notNull(),
    attempt: integer('attempt').notNull(),
    detail: json<JsonObject>('detail').notNull(),
    started_at: timestamp('started_at'),
    finished_at: timestamp('finished_at'),
  },
  (table) => [
    uniqueIndex('deployment_step_deployment_step_attempt_unique').on(
      table.deployment_id,
      table.step,
      table.attempt,
    ),
  ],
)

export const build = sqliteTable('build', {
  ...entity('build'),
  deployment_id: text('deployment_id')
    .notNull()
    .references(() => deployment.id),
  project_id: text('project_id').notNull(),
  source: json<JsonObject>('source').notNull(),
  builder: text('builder', {
    enum: builderValues,
  }).notNull(),
  image_ref: text('image_ref'),
  index_digest: text('index_digest'),
  cache_key: text('cache_key').notNull(),
  detail: json<JsonObject>('detail').notNull(),
  railpack_version: text('railpack_version'),
  status: text('status', {
    enum: buildStatusValues,
  })
    .notNull()
    .default('queued'),
  log_ref: text('log_ref').notNull(),
  duration_s: integer('duration_s'),
  failure: json<DiagnosisValue>('failure'),
})

export type RunExec = {
  cwd: string | null
  user: string | null
  timeout_s: number | null
  stdin: string | null
  env_keys: string[]
  attach: boolean
}

export const run = sqliteTable('run', {
  ...entity('run'),
  service_id: text('service_id'),
  sandbox_id: text('sandbox_id'),
  exec: json<RunExec>('exec'),
  deployment_id: text('deployment_id').references(() => deployment.id),
  kind: text('kind', {
    enum: runKindValues,
  }).notNull(),
  command: json<string[]>('command').notNull(),
  status: text('status', {
    enum: runStatusValues,
  })
    .notNull()
    .default('queued'),
  exit_code: integer('exit_code'),
  failure: json<DiagnosisValue>('failure'),
  log_ref: text('log_ref').notNull(),
  started_at: timestamp('started_at'),
  finished_at: timestamp('finished_at'),
  tty: bool('tty').notNull().default(false),
  actor: json<ActorValue>('actor'),
})

export const variable = sqliteTable(
  'variable',
  {
    ...entity('variable'),
    scope: text('scope', {
      enum: variableScopeValues,
    }).notNull(),
    project_id: text('project_id').references(() => project.id),
    service_id: text('service_id').references(() => service.id),
    sandbox_id: text('sandbox_id').references(() => sandbox.id),
    key: text('key').notNull(),
    kind: text('kind', {
      enum: variableKindValues,
    }).notNull(),
    reference: text('reference'),
    injection: text('injection', {
      enum: injectionValues,
    })
      .notNull()
      .default('env'),
    build: bool('build').notNull().default(false),
    current_value_id: text('current_value_id'),
  },
  (table) => [
    uniqueIndex('variable_global_key_unique')
      .on(table.key)
      .where(sql`scope = 'global'`),
    uniqueIndex('variable_project_key_unique')
      .on(table.project_id, table.key)
      .where(sql`scope = 'project'`),
    uniqueIndex('variable_service_key_unique')
      .on(table.service_id, table.key)
      .where(sql`scope = 'service'`),
    uniqueIndex('variable_sandbox_key_unique')
      .on(table.sandbox_id, table.key)
      .where(sql`scope = 'sandbox'`),
  ],
)

export const data_key = sqliteTable('data_key', {
  ...entity('data_key'),
  wrapped: bytes('wrapped').notNull(),
  wrapped_next: bytes('wrapped_next'),
})

export const master_key_wrap = sqliteTable(
  'master_key_wrap',
  {
    ...entity('master_key_wrap'),
    user_id: text('user_id').notNull(),
    kdf: json<{
      algorithm: 'argon2id'
      memory: number
      passes: number
      parallelism: number
      salt: string
    }>('kdf').notNull(),
    wrapped: bytes('wrapped').notNull(),
    wrapped_next: bytes('wrapped_next'),
  },
  (table) => [uniqueIndex('master_key_wrap_user_unique').on(table.user_id)],
)

export const secret_value = sqliteTable(
  'secret_value',
  {
    ...entity('secret_value'),
    variable_id: text('variable_id')
      .notNull()
      .references(() => variable.id),
    environment_id: text('environment_id').references(() => environment.id),
    version: integer('version').notNull(),
    ciphertext: bytes('ciphertext').notNull(),
    data_key_id: text('data_key_id')
      .notNull()
      .references(() => data_key.id),
    created_by: json<ActorValue>('created_by').notNull(),
    revoked_at: timestamp('revoked_at'),
    needs_reentry: bool('needs_reentry').notNull().default(false),
  },
  (table) => [
    uniqueIndex('secret_value_default_version_unique')
      .on(table.variable_id, table.version)
      .where(sql`environment_id is null`),
    uniqueIndex('secret_value_environment_version_unique')
      .on(table.variable_id, table.environment_id, table.version)
      .where(sql`environment_id is not null`),
  ],
)

export const grant = sqliteTable('grant', {
  ...entity('grant'),
  variable_id: text('variable_id')
    .notNull()
    .references(() => variable.id),
  project_id: text('project_id')
    .notNull()
    .references(() => project.id),
  alias: text('alias'),
  source: text('source', {
    enum: grantSourceValues,
  }).notNull(),
  attachment_id: text('attachment_id').references(() => attachment.id),
})

export const attachment = sqliteTable(
  'attachment',
  {
    ...entity('attachment'),
    environment_id: text('environment_id')
      .notNull()
      .references(() => environment.id),
    shared_service_id: text('shared_service_id')
      .notNull()
      .references(() => service.id),
    alias: text('alias').notNull(),
    status: text('status', {
      enum: ['pending', 'attached', 'failed', 'detaching'],
    })
      .notNull()
      .default('pending'),
    exports: json<JsonObject>('exports').notNull(),
    hook_run_id: text('hook_run_id').references(() => run.id),
    error: json<DiagnosisValue>('error'),
  },
  (table) => [
    uniqueIndex('attachment_environment_alias_unique').on(table.environment_id, table.alias),
  ],
)

export const staged_change = sqliteTable('staged_change', {
  ...entity('staged_change'),
  environment_id: text('environment_id'),
  actor: json<ActorValue>('actor').notNull(),
  changes: json<JsonObject[]>('changes').notNull(),
  refs: json<Record<string, string>>('refs').notNull(),
  source: text('source', {
    enum: stagedChangeSourceValues,
  }).notNull(),
  status: text('status', {
    enum: stagedChangeStatusValues,
  }).notNull(),
  accepted_by: json<ActorValue>('accepted_by'),
  deployments: json<string[]>('deployments').notNull(),
})

export const template = sqliteTable(
  'template',
  {
    ...entity('template'),
    name: text('name').notNull(),
    source: text('source', {
      enum: ['builtin', 'user', 'catalog'],
    }).notNull(),
  },
  (table) => [uniqueIndex('template_name_unique').on(table.name)],
)

export const template_version = sqliteTable(
  'template_version',
  {
    ...entity('template_version'),
    template_id: text('template_id')
      .notNull()
      .references(() => template.id),
    version: text('version').notNull(),
    spec: json<JsonObject>('spec').notNull(),
    hooks_image: text('hooks_image'),
  },
  (table) => [
    uniqueIndex('template_version_template_version_unique').on(table.template_id, table.version),
  ],
)

export const firewall_policy = sqliteTable('firewall_policy', {
  ...entity('firewall_policy'),
  owner: json<{ type: 'service' | 'project' | 'system'; id: string | null }>('owner').notNull(),
  kind: text('kind', {
    enum: ['runtime', 'build', 'system'],
  }).notNull(),
  editable: bool('editable').notNull().default(true),
  includes: json<string[]>('includes').notNull(),
  generation: integer('generation').notNull().default(0),
  acknowledged_generation: integer('acknowledged_generation').notNull().default(0),
})

export const firewall_rule = sqliteTable('firewall_rule', {
  ...entity('firewall_rule'),
  policy_id: text('policy_id')
    .notNull()
    .references(() => firewall_policy.id),
  match: json<JsonObject>('match').notNull(),
  ports: json<{ port: number; protocol: string }[]>('ports').notNull(),
  source: text('source', {
    enum: ['manual', 'learned', 'derived', 'preset'],
  }).notNull(),
  derived_from: json<JsonObject>('derived_from'),
})

export const flow_rollup = sqliteTable('flow_rollup', {
  ...entity('flow_rollup'),
  service_id: text('service_id').notNull(),
  deployment_id: text('deployment_id')
    .notNull()
    .references(() => deployment.id),
  minute: timestamp('minute').notNull(),
  destination: json<{ domain: string } | { ip: string } | { service_id: string }>(
    'destination',
  ).notNull(),
  port: integer('port').notNull(),
  protocol: text('protocol').notNull(),
  verdict: text('verdict', {
    enum: flowVerdictValues,
  }).notNull(),
  connections: integer('connections').notNull(),
  bytes_out: integer('bytes_out').notNull(),
  bytes_in: integer('bytes_in').notNull(),
})

export const ipam_allocation = sqliteTable(
  'ipam_allocation',
  {
    ...entity('ipam_allocation'),
    environment_id: text('environment_id')
      .notNull()
      .references(() => environment.id),
    station_id: text('station_id')
      .notNull()
      .references(() => station.id),
    subnet: text('subnet').notNull(),
    gateway: text('gateway').notNull(),
    docker_network_id: text('docker_network_id'),
  },
  (table) => [
    uniqueIndex('ipam_allocation_environment_station_unique').on(
      table.environment_id,
      table.station_id,
    ),
    uniqueIndex('ipam_allocation_station_subnet_unique').on(table.station_id, table.subnet),
  ],
)

export const virtual_ip = sqliteTable(
  'virtual_ip',
  {
    ...entity('virtual_ip'),
    service_id: text('service_id').references(() => service.id),
    component: text('component'),
    environment_id: text('environment_id')
      .notNull()
      .references(() => environment.id),
    address: text('address').notNull(),
  },
  (table) => [uniqueIndex('virtual_ip_address_unique').on(table.address)],
)

export const component = sqliteTable(
  'component',
  {
    ...entity('component'),
    station_id: text('station_id').references(() => station.id),
    name: text('name', {
      enum: componentNameValues,
    }).notNull(),
    container_id: text('container_id'),
    version: text('version').notNull(),
    digest: text('digest'),
    since: timestamp('since').notNull(),
    lockfile_version: text('lockfile_version').notNull(),
    lockfile_digest: text('lockfile_digest'),
    status: text('status', {
      enum: componentStatusValues,
    })
      .notNull()
      .default('ok'),
    signature: text('signature', {
      enum: signatureStateValues,
    })
      .notNull()
      .default('pending'),
    failure: json<ErrorBodyValue>('failure'),
  },
  (table) => [
    uniqueIndex('component_instance_name_unique')
      .on(table.name)
      .where(sql`station_id is null`),
    uniqueIndex('component_station_name_unique')
      .on(table.station_id, table.name)
      .where(sql`station_id is not null`),
  ],
)

export const attestation = sqliteTable(
  'attestation',
  {
    ...entity('attestation'),
    build_id: text('build_id').references(() => build.id),
    component_id: text('component_id').references(() => component.id),
    kind: text('kind', {
      enum: attestationKindValues,
    }).notNull(),
    generator_version: text('generator_version'),
    platform: text('platform').notNull(),
    digest: text('digest'),
    predicate_ref: text('predicate_ref').notNull(),
    base_images: json<{ ref: string; digest: string }[]>('base_images').notNull(),
  },
  () => [
    check('attestation_exactly_one_subject', sql`(build_id is null) <> (component_id is null)`),
  ],
)

export type StoredBackupTarget =
  | { type: 'path'; path: string }
  | { type: 's3'; endpoint: string; bucket: string; prefix: string; credentials_variable: string }

export const volume_snapshot = sqliteTable('volume_snapshot', {
  ...entity('volume_snapshot'),
  volume_id: text('volume_id')
    .notNull()
    .references(() => volume.id),
  taken_at: timestamp('taken_at').notNull(),
  location: text('location').notNull(),
  size_bytes: integer('size_bytes').notNull().default(0),
  source: text('source', {
    enum: volumeSnapshotSourceValues,
  }).notNull(),
  status: text('status', {
    enum: volumeSnapshotStatusValues,
  })
    .notNull()
    .default('running'),
  station_id: text('station_id').references(() => station.id),
  trigger: text('trigger', {
    enum: volumeSnapshotTriggerValues,
  })
    .notNull()
    .default('manual'),
  target: json<StoredBackupTarget>('target'),
  objects: json<{ archive: string; metadata: string }>('objects'),
  sha256: text('sha256'),
  archive_bytes: integer('archive_bytes'),
  consistent: bool('consistent'),
  finished_at: timestamp('finished_at'),
  failure: json<Record<string, unknown>>('failure'),
})

export const advisory = sqliteTable(
  'advisory',
  {
    ...entity('advisory'),
    source_id: text('source_id').notNull(),
    aliases: json<string[]>('aliases').notNull(),
    severity: json<unknown>('severity').notNull(),
    summary: text('summary').notNull(),
    affected: json<JsonObject[]>('affected').notNull(),
    status: text('status', {
      enum: ['open', 'accepted', 'fixed'],
    })
      .notNull()
      .default('open'),
    first_seen_at: timestamp('first_seen_at').notNull(),
  },
  (table) => [uniqueIndex('advisory_source_id_unique').on(table.source_id)],
)

export const vex_statement = sqliteTable('vex_statement', {
  ...entity('vex_statement'),
  project_id: text('project_id').references(() => project.id),
  advisory_id: text('advisory_id')
    .notNull()
    .references(() => advisory.id),
  product: text('product').notNull(),
  subcomponent: text('subcomponent').notNull(),
  status: text('status', {
    enum: ['not_affected', 'affected', 'fixed', 'under_investigation'],
  }).notNull(),
  justification: text('justification'),
  actor: json<ActorValue>('actor').notNull(),
})

export const token = sqliteTable(
  'token',
  {
    ...entity('token'),
    user_id: text('user_id').notNull(),
    name: text('name').notNull(),
    kind: text('kind', {
      enum: tokenKindValues,
    }).notNull(),
    scopes:
      json<{ project_id: string; environment_id: string; level: 'read' | 'deploy' | 'admin' }[]>(
        'scopes',
      ).notNull(),
    expires_at: timestamp('expires_at').notNull(),
    last_used_at: timestamp('last_used_at'),
    client_id: text('client_id'),
    api_key_id: text('api_key_id'),
    secret_sha256: text('secret_sha256'),
    station_id: text('station_id').references(() => station.id),
    used_at: timestamp('used_at'),
  },
  (table) => [
    uniqueIndex('token_api_key_unique').on(table.api_key_id),
    uniqueIndex('token_secret_sha256_unique').on(table.secret_sha256),
  ],
)

export const idempotency_record = sqliteTable(
  'idempotency_record',
  {
    actor: text('actor').notNull(),
    key: text('key').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    request_sha256: text('request_sha256').notNull(),
    status: integer('status'),
    response: json<unknown>('response'),
    created_at: timestamp('created_at').notNull(),
    expires_at: timestamp('expires_at').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.actor, table.key],
    }),
    index('idempotency_record_expires_at').on(table.expires_at),
  ],
)

export const staged_value = sqliteTable('staged_value', {
  id: text('id').primaryKey(),
  staged_change_id: text('staged_change_id')
    .notNull()
    .references(() => staged_change.id),
  ciphertext: bytes('ciphertext').notNull(),
  data_key_id: text('data_key_id')
    .notNull()
    .references(() => data_key.id),
  created_at: timestamp('created_at')
    .notNull()
    .$defaultFn(() => new Date()),
})

export const audit_event = sqliteTable('audit_event', {
  ...entity('audit_event'),
  actor: json<ActorValue>('actor').notNull(),
  action: text('action').notNull(),
  target: json<EntityTarget>('target').notNull(),
  request_id: text('request_id').notNull(),
  idempotency_key: text('idempotency_key'),
  purpose: text('purpose'),
  before: json<JsonObject>('before'),
  after: json<JsonObject>('after'),
})

export type Delivery = {
  status: 'pending' | 'delivered' | 'failed' | 'skipped'
  attempts: number
  last_error: string | null
  delivered_at: string | null
  next_at: string | null
}

export const event = sqliteTable(
  'event',
  {
    ...entity('event'),
    type: text('type').notNull(),
    subject: json<EntityTarget & JsonObject>('subject').notNull(),
    payload: json<JsonObject>('payload').notNull(),
    delivered: json<Record<string, Delivery>>('delivered').notNull(),
  },
  (table) => [index('event_created_at').on(table.created_at)],
)

export const notification_channel = sqliteTable('notification_channel', {
  ...entity('notification_channel'),
  kind: text('kind', {
    enum: notificationChannelKindValues,
  }).notNull(),
  config: json<JsonObject>('config').notNull(),
  filter: json<JsonObject>('filter').notNull(),
  status: text('status', {
    enum: notificationChannelStatusValues,
  })
    .notNull()
    .default('active'),
  failing_since: timestamp('failing_since'),
})

export const agent_hook = sqliteTable('agent_hook', {
  ...entity('agent_hook'),
  runtime: text('runtime', {
    enum: ['claude_code', 'webhook'],
  }).notNull(),
  config: json<{ url: string; secret: string; skill: string | null }>('config').notNull(),
  filter: json<JsonObject>('filter').notNull(),
  token_id: text('token_id')
    .notNull()
    .references(() => token.id),
  status: text('status', {
    enum: ['active', 'disabled'],
  })
    .notNull()
    .default('active'),
  disabled_at: timestamp('disabled_at'),
})

export const setting = sqliteTable(
  'setting',
  {
    ...entity('setting'),
    key: text('key').notNull(),
    value: json<unknown>('value').notNull(),
    updated_by: json<ActorValue>('updated_by').notNull(),
  },
  (table) => [uniqueIndex('setting_key_unique').on(table.key)],
)

export const station_generation = sqliteTable(
  'station_generation',
  {
    ...entity('station_generation'),
    station_id: text('station_id')
      .notNull()
      .references(() => station.id),
    generation: integer('generation').notNull(),
    document: json<Generation>('document').notNull(),
    hash: text('hash').notNull(),
    ack: text('ack', {
      enum: appliedStatusValues,
    }),
    failure: json<ErrorBodyValue>('failure'),
  },
  (table) => [
    uniqueIndex('station_generation_station_generation_unique').on(
      table.station_id,
      table.generation,
    ),
  ],
)

export const station_outbox = sqliteTable(
  'station_outbox',
  {
    ...entity('station_outbox'),
    station_id: text('station_id')
      .notNull()
      .references(() => station.id),
    epoch: text('epoch').notNull(),
    committed_seq: integer('committed_seq').notNull().default(0),
  },
  (table) => [uniqueIndex('station_outbox_station_epoch_unique').on(table.station_id, table.epoch)],
)

export const drift = sqliteTable('drift', {
  ...entity('drift'),
  station_id: text('station_id')
    .notNull()
    .references(() => station.id),
  object: json<string>('object').notNull(),
  observed: json<unknown>('observed'),
  desired: json<unknown>('desired'),
  status: text('status', {
    enum: ['open', 'resolved'],
  })
    .notNull()
    .default('open'),
})

export const platform_release = sqliteTable(
  'platform_release',
  {
    ...entity('platform_release'),
    release: text('release').notNull(),
    channel: text('channel', {
      enum: releaseChannelValues,
    }).notNull(),
    manifest: json<ReleaseManifestDoc>('manifest').notNull(),
    manifest_raw: text('manifest_raw').notNull(),
    manifest_digest: text('manifest_digest').notNull(),
    bundle: text('bundle').notNull(),
    source: text('source').notNull(),
    verified_by: text('verified_by'),
  },
  (table) => [uniqueIndex('platform_release_digest_unique').on(table.manifest_digest)],
)

export type UpgradePin = { version: string; digest: string | null }

export type UpgradeStep = {
  component: string
  station_id: string | null
  from: UpgradePin
  to: UpgradePin
  status: 'pending' | 'running' | 'done' | 'failed' | 'reverting' | 'reverted' | 'revert_failed'
  started_at: string | null
  finished_at: string | null
  failure: ErrorBodyValue | null
  detail: JsonObject | null
}

export const platform_upgrade = sqliteTable(
  'platform_upgrade',
  {
    ...entity('platform_upgrade'),
    staged_change_id: text('staged_change_id'),
    station_id: text('station_id').references(() => station.id),
    release_from: text('release_from').notNull(),
    release_to: text('release_to').notNull(),
    lockfile_before: json<JsonObject>('lockfile_before').notNull(),
    lockfile_after: json<JsonObject>('lockfile_after').notNull(),
    steps: json<UpgradeStep[]>('steps').notNull(),
    status: text('status', {
      enum: platformUpgradeStatusValues,
    }).notNull(),
    failure: json<ErrorBodyValue>('failure'),
    actor: json<ActorValue>('actor').notNull(),
    backup: text('backup'),
    finished_at: timestamp('finished_at'),
  },
  (table) => [index('platform_upgrade_status').on(table.status)],
)

export const blob = sqliteTable('blob', {
  ...entity('blob'),
  kind: text('kind', {
    enum: ['grype_db', 'vex', 'push_tarball', 'generation', 'sigstore'],
  }).notNull(),
  size_bytes: integer('size_bytes').notNull(),
  sha256: text('sha256').notNull(),
  expires_at: timestamp('expires_at').notNull(),
  service_id: text('service_id'),
  grant_sha256: text('grant_sha256'),
  grant_station_id: text('grant_station_id'),
  grant_expires_at: timestamp('grant_expires_at'),
})

export const github_app = sqliteTable(
  'github_app',
  {
    ...entity('github_app'),
    app_id: integer('app_id').notNull(),
    slug: text('slug').notNull(),
    client_id: text('client_id').notNull(),
    owner: text('owner').notNull(),
    webhooks: bool('webhooks').notNull(),
    private_key: bytes('private_key').notNull(),
    client_secret: bytes('client_secret').notNull(),
    webhook_secret: bytes('webhook_secret'),
    data_key_id: text('data_key_id').references(() => data_key.id),
  },
  (table) => [
    uniqueIndex('github_app_owner_unique').on(table.owner),
    uniqueIndex('github_app_app_id_unique').on(table.app_id),
  ],
)

export const github_installation = sqliteTable(
  'github_installation',
  {
    ...entity('github_installation'),
    github_app_id: text('github_app_id')
      .notNull()
      .references(() => github_app.id),
    installation_id: integer('installation_id').notNull(),
    account: text('account').notNull(),
    repository_selection: text('repository_selection', {
      enum: githubRepositorySelectionValues,
    }).notNull(),
    suspended_at: timestamp('suspended_at'),
  },
  (table) => [uniqueIndex('github_installation_installation_id_unique').on(table.installation_id)],
)

export const github_connect_state = sqliteTable('github_connect_state', {
  state_sha256: text('state_sha256').primaryKey(),
  user_id: text('user_id').notNull(),
  org: text('org'),
  webhooks: bool('webhooks').notNull(),
  dashboard_origin: text('dashboard_origin').notNull(),
  expires_at: timestamp('expires_at').notNull(),
  used_at: timestamp('used_at'),
})

export const github_delivery = sqliteTable(
  'github_delivery',
  {
    guid: text('guid').primaryKey(),
    github_app_id: text('github_app_id')
      .notNull()
      .references(() => github_app.id),
    event: text('event').notNull(),
    action: text('action'),
    payload: text('payload').notNull(),
    status: text('status', {
      enum: ['queued', 'processed', 'ignored', 'failed'],
    }).notNull(),
    detail: json<JsonObject>('detail'),
    redelivery: bool('redelivery').notNull().default(false),
    received_at: timestamp('received_at')
      .notNull()
      .$defaultFn(() => new Date()),
    processed_at: timestamp('processed_at'),
  },
  (table) => [index('github_delivery_status').on(table.status)],
)

export const source_poll = sqliteTable(
  'source_poll',
  {
    repo: text('repo').notNull(),
    branch: text('branch').notNull(),
    auth: text('auth', {
      enum: repoAuthValues,
    }).notNull(),
    sha: text('sha'),
    etag: text('etag'),
    interval_s: integer('interval_s'),
    checked_at: timestamp('checked_at'),
    changed_at: timestamp('changed_at'),
    last_error: text('last_error'),
  },
  (table) => [
    primaryKey({
      columns: [table.repo, table.branch],
    }),
  ],
)

export const doctor_check = sqliteTable(
  'doctor_check',
  {
    name: text('name').notNull(),
    station: text('station').notNull(),
    status: text('status', {
      enum: doctorStatusValues,
    }).notNull(),
    code: text('code'),
    changed_at: timestamp('changed_at').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.name, table.station],
    }),
  ],
)

export const github_status = sqliteTable(
  'github_status',
  {
    id: integer('id').primaryKey({
      autoIncrement: true,
    }),
    repo: text('repo').notNull(),
    sha: text('sha').notNull(),
    context: text('context').notNull(),
    state: text('state', {
      enum: ['pending', 'success', 'failure', 'error'],
    }).notNull(),
    description: text('description').notNull(),
    target_url: text('target_url'),
    attempts: integer('attempts').notNull().default(0),
    last_error: text('last_error'),
    created_at: timestamp('created_at')
      .notNull()
      .$defaultFn(() => new Date()),
    posted_at: timestamp('posted_at'),
  },
  (table) => [index('github_status_posted_at').on(table.posted_at)],
)

const msNow = sql`(cast(unixepoch('subsecond') * 1000 as integer))`

export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', {
    mode: 'boolean',
  })
    .default(false)
    .notNull(),
  image: text('image'),
  createdAt: integer('created_at', {
    mode: 'timestamp_ms',
  })
    .default(msNow)
    .notNull(),
  updatedAt: integer('updated_at', {
    mode: 'timestamp_ms',
  })
    .default(msNow)
    .$onUpdate(() => new Date())
    .notNull(),
  twoFactorEnabled: integer('two_factor_enabled', {
    mode: 'boolean',
  }).default(false),
  role: text('role'),
  banned: integer('banned', {
    mode: 'boolean',
  }).default(false),
  banReason: text('ban_reason'),
  banExpires: integer('ban_expires', {
    mode: 'timestamp_ms',
  }),
})

export const session = sqliteTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: integer('expires_at', {
      mode: 'timestamp_ms',
    }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: integer('created_at', {
      mode: 'timestamp_ms',
    })
      .default(msNow)
      .notNull(),
    updatedAt: integer('updated_at', {
      mode: 'timestamp_ms',
    })
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, {
        onDelete: 'cascade',
      }),
    impersonatedBy: text('impersonated_by'),
    popJkt: text('pop_jkt'),
  },
  (table) => [index('session_userId_idx').on(table.userId)],
)

export const account = sqliteTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, {
        onDelete: 'cascade',
      }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', {
      mode: 'timestamp_ms',
    }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', {
      mode: 'timestamp_ms',
    }),
    scope: text('scope'),
    password: text('password'),
    createdAt: integer('created_at', {
      mode: 'timestamp_ms',
    })
      .default(msNow)
      .notNull(),
    updatedAt: integer('updated_at', {
      mode: 'timestamp_ms',
    })
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('account_userId_idx').on(table.userId)],
)

export const verification = sqliteTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at', {
      mode: 'timestamp_ms',
    }).notNull(),
    createdAt: integer('created_at', {
      mode: 'timestamp_ms',
    })
      .default(msNow)
      .notNull(),
    updatedAt: integer('updated_at', {
      mode: 'timestamp_ms',
    })
      .default(msNow)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index('verification_identifier_idx').on(table.identifier)],
)

export const twoFactor = sqliteTable(
  'two_factor',
  {
    id: text('id').primaryKey(),
    secret: text('secret').notNull(),
    backupCodes: text('backup_codes').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, {
        onDelete: 'cascade',
      }),
    verified: integer('verified', {
      mode: 'boolean',
    }).default(true),
    failedVerificationCount: integer('failed_verification_count').default(0),
    lockedUntil: integer('locked_until', {
      mode: 'timestamp_ms',
    }),
  },
  (table) => [
    index('twoFactor_secret_idx').on(table.secret),
    index('twoFactor_userId_idx').on(table.userId),
  ],
)

export const passkey = sqliteTable(
  'passkey',
  {
    id: text('id').primaryKey(),
    name: text('name'),
    publicKey: text('public_key').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, {
        onDelete: 'cascade',
      }),
    credentialID: text('credential_id').notNull(),
    counter: integer('counter').notNull(),
    deviceType: text('device_type').notNull(),
    backedUp: integer('backed_up', {
      mode: 'boolean',
    }).notNull(),
    transports: text('transports'),
    createdAt: integer('created_at', {
      mode: 'timestamp_ms',
    }),
    aaguid: text('aaguid'),
  },
  (table) => [
    index('passkey_userId_idx').on(table.userId),
    index('passkey_credentialID_idx').on(table.credentialID),
  ],
)

export const apikey = sqliteTable(
  'apikey',
  {
    id: text('id').primaryKey(),
    configId: text('config_id').default('default').notNull(),
    name: text('name'),
    start: text('start'),
    referenceId: text('reference_id').notNull(),
    prefix: text('prefix'),
    key: text('key').notNull(),
    refillInterval: integer('refill_interval'),
    refillAmount: integer('refill_amount'),
    lastRefillAt: integer('last_refill_at', {
      mode: 'timestamp_ms',
    }),
    enabled: integer('enabled', {
      mode: 'boolean',
    }).default(true),
    rateLimitEnabled: integer('rate_limit_enabled', {
      mode: 'boolean',
    }).default(true),
    rateLimitTimeWindow: integer('rate_limit_time_window').default(60000),
    rateLimitMax: integer('rate_limit_max').default(600),
    requestCount: integer('request_count').default(0),
    remaining: integer('remaining'),
    lastRequest: integer('last_request', {
      mode: 'timestamp_ms',
    }),
    expiresAt: integer('expires_at', {
      mode: 'timestamp_ms',
    }),
    createdAt: integer('created_at', {
      mode: 'timestamp_ms',
    }).notNull(),
    updatedAt: integer('updated_at', {
      mode: 'timestamp_ms',
    }).notNull(),
    permissions: text('permissions'),
    metadata: text('metadata'),
  },
  (table) => [
    index('apikey_configId_idx').on(table.configId),
    index('apikey_referenceId_idx').on(table.referenceId),
    index('apikey_key_idx').on(table.key),
  ],
)

export const deviceCode = sqliteTable(
  'device_code',
  {
    id: text('id').primaryKey(),
    deviceCode: text('device_code').notNull(),
    userCode: text('user_code').notNull(),
    userId: text('user_id'),
    expiresAt: integer('expires_at', {
      mode: 'timestamp_ms',
    }).notNull(),
    status: text('status').notNull(),
    lastPolledAt: integer('last_polled_at', {
      mode: 'timestamp_ms',
    }),
    pollingInterval: integer('polling_interval'),
    clientId: text('client_id'),
    scope: text('scope'),
  },
  (table) => [
    uniqueIndex('deviceCode_deviceCode_uidx').on(table.deviceCode),
    uniqueIndex('deviceCode_userCode_uidx').on(table.userCode),
  ],
)

export const jwks = sqliteTable('jwks', {
  id: text('id').primaryKey(),
  publicKey: text('public_key').notNull(),
  privateKey: text('private_key').notNull(),
  createdAt: integer('created_at', {
    mode: 'timestamp_ms',
  }).notNull(),
  expiresAt: integer('expires_at', {
    mode: 'timestamp_ms',
  }),
  alg: text('alg'),
  crv: text('crv'),
})

export const oauthClient = sqliteTable(
  'oauth_client',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id').notNull().unique(),
    clientSecret: text('client_secret'),
    clientDiscoveryId: text('client_discovery_id'),
    disabled: integer('disabled', {
      mode: 'boolean',
    }).default(false),
    skipConsent: integer('skip_consent', {
      mode: 'boolean',
    }),
    enableEndSession: integer('enable_end_session', {
      mode: 'boolean',
    }),
    subjectType: text('subject_type'),
    scopes: text('scopes', {
      mode: 'json',
    }),
    clientCredentialsScopes: text('client_credentials_scopes', {
      mode: 'json',
    }).default([]),
    userId: text('user_id').references(() => user.id, {
      onDelete: 'cascade',
    }),
    createdAt: integer('created_at', {
      mode: 'timestamp_ms',
    }),
    updatedAt: integer('updated_at', {
      mode: 'timestamp_ms',
    }),
    name: text('name'),
    uri: text('uri'),
    icon: text('icon'),
    contacts: text('contacts', {
      mode: 'json',
    }),
    tos: text('tos'),
    policy: text('policy'),
    softwareId: text('software_id'),
    softwareVersion: text('software_version'),
    softwareStatement: text('software_statement'),
    redirectUris: text('redirect_uris', {
      mode: 'json',
    }).notNull(),
    postLogoutRedirectUris: text('post_logout_redirect_uris', {
      mode: 'json',
    }),
    backchannelLogoutUri: text('backchannel_logout_uri'),
    backchannelLogoutSessionRequired: integer('backchannel_logout_session_required', {
      mode: 'boolean',
    }),
    tokenEndpointAuthMethod: text('token_endpoint_auth_method'),
    applicationType: text('application_type'),
    jwks: text('jwks'),
    jwksUri: text('jwks_uri'),
    grantTypes: text('grant_types', {
      mode: 'json',
    }),
    responseTypes: text('response_types', {
      mode: 'json',
    }),
    requirePKCE: integer('require_pkce', {
      mode: 'boolean',
    }),
    dpopBoundAccessTokens: integer('dpop_bound_access_tokens', {
      mode: 'boolean',
    }).default(false),
    referenceId: text('reference_id'),
    metadata: text('metadata', {
      mode: 'json',
    }),
  },
  (table) => [index('oauthClient_userId_idx').on(table.userId)],
)

export const oauthResource = sqliteTable('oauth_resource', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull().unique(),
  name: text('name').notNull(),
  accessTokenTtl: integer('access_token_ttl'),
  refreshTokenTtl: integer('refresh_token_ttl'),
  signingAlgorithm: text('signing_algorithm'),
  signingKeyId: text('signing_key_id'),
  allowedScopes: text('allowed_scopes', {
    mode: 'json',
  }),
  customClaims: text('custom_claims', {
    mode: 'json',
  }),
  dpopBoundAccessTokensRequired: integer('dpop_bound_access_tokens_required', {
    mode: 'boolean',
  }).default(false),
  disabled: integer('disabled', {
    mode: 'boolean',
  }).default(false),
  createdAt: integer('created_at', {
    mode: 'timestamp_ms',
  }),
  updatedAt: integer('updated_at', {
    mode: 'timestamp_ms',
  }),
  policyVersion: integer('policy_version').default(1),
  metadata: text('metadata', {
    mode: 'json',
  }),
})

export const oauthClientResource = sqliteTable(
  'oauth_client_resource',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, {
        onDelete: 'cascade',
      }),
    resourceId: text('resource_id')
      .notNull()
      .references(() => oauthResource.identifier, {
        onDelete: 'cascade',
      }),
    metadata: text('metadata', {
      mode: 'json',
    }),
    createdAt: integer('created_at', {
      mode: 'timestamp_ms',
    }),
  },
  (table) => [
    uniqueIndex('oauthClientResource_clientId_resourceId_uidx').on(
      table.clientId,
      table.resourceId,
    ),
    index('oauthClientResource_clientId_idx').on(table.clientId),
    index('oauthClientResource_resourceId_idx').on(table.resourceId),
  ],
)

export const oauthRefreshToken = sqliteTable(
  'oauth_refresh_token',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, {
        onDelete: 'cascade',
      }),
    sessionId: text('session_id').references(() => session.id, {
      onDelete: 'set null',
    }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, {
        onDelete: 'cascade',
      }),
    referenceId: text('reference_id'),
    authorizationCodeId: text('authorization_code_id'),
    resources: text('resources', {
      mode: 'json',
    }),
    requestedUserInfoClaims: text('requested_user_info_claims', {
      mode: 'json',
    }),
    expiresAt: integer('expires_at', {
      mode: 'timestamp_ms',
    }).notNull(),
    createdAt: integer('created_at', {
      mode: 'timestamp_ms',
    }).notNull(),
    revoked: integer('revoked', {
      mode: 'timestamp_ms',
    }),
    rotatedAt: integer('rotated_at', {
      mode: 'timestamp_ms',
    }),
    rotationReplayResponse: text('rotation_replay_response'),
    rotationReplayExpiresAt: integer('rotation_replay_expires_at', {
      mode: 'timestamp_ms',
    }),
    authTime: integer('auth_time', {
      mode: 'timestamp_ms',
    }),
    confirmation: text('confirmation', {
      mode: 'json',
    }),
    scopes: text('scopes', {
      mode: 'json',
    }).notNull(),
  },
  (table) => [
    index('oauthRefreshToken_clientId_idx').on(table.clientId),
    index('oauthRefreshToken_sessionId_idx').on(table.sessionId),
    index('oauthRefreshToken_userId_idx').on(table.userId),
    index('oauthRefreshToken_authorizationCodeId_idx').on(table.authorizationCodeId),
  ],
)

export const oauthAccessToken = sqliteTable(
  'oauth_access_token',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, {
        onDelete: 'cascade',
      }),
    sessionId: text('session_id').references(() => session.id, {
      onDelete: 'set null',
    }),
    userId: text('user_id').references(() => user.id, {
      onDelete: 'cascade',
    }),
    referenceId: text('reference_id'),
    authorizationCodeId: text('authorization_code_id'),
    resources: text('resources', {
      mode: 'json',
    }),
    requestedUserInfoClaims: text('requested_user_info_claims', {
      mode: 'json',
    }),
    refreshId: text('refresh_id').references(() => oauthRefreshToken.id, {
      onDelete: 'cascade',
    }),
    expiresAt: integer('expires_at', {
      mode: 'timestamp_ms',
    }).notNull(),
    createdAt: integer('created_at', {
      mode: 'timestamp_ms',
    }).notNull(),
    revoked: integer('revoked', {
      mode: 'timestamp_ms',
    }),
    confirmation: text('confirmation', {
      mode: 'json',
    }),
    scopes: text('scopes', {
      mode: 'json',
    }).notNull(),
  },
  (table) => [
    index('oauthAccessToken_clientId_idx').on(table.clientId),
    index('oauthAccessToken_sessionId_idx').on(table.sessionId),
    index('oauthAccessToken_userId_idx').on(table.userId),
    index('oauthAccessToken_authorizationCodeId_idx').on(table.authorizationCodeId),
    index('oauthAccessToken_refreshId_idx').on(table.refreshId),
  ],
)

export const oauthConsent = sqliteTable(
  'oauth_consent',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id')
      .notNull()
      .references(() => oauthClient.clientId, {
        onDelete: 'cascade',
      }),
    userId: text('user_id').references(() => user.id, {
      onDelete: 'cascade',
    }),
    referenceId: text('reference_id'),
    resources: text('resources', {
      mode: 'json',
    }),
    requestedUserInfoClaims: text('requested_user_info_claims', {
      mode: 'json',
    }),
    scopes: text('scopes', {
      mode: 'json',
    }).notNull(),
    createdAt: integer('created_at', {
      mode: 'timestamp_ms',
    }).notNull(),
    updatedAt: integer('updated_at', {
      mode: 'timestamp_ms',
    }).notNull(),
  },
  (table) => [
    index('oauthConsent_clientId_idx').on(table.clientId),
    index('oauthConsent_userId_idx').on(table.userId),
  ],
)

export const oauthClientAssertion = sqliteTable('oauth_client_assertion', {
  id: text('id').primaryKey(),
  expiresAt: integer('expires_at', {
    mode: 'timestamp_ms',
  }).notNull(),
})
