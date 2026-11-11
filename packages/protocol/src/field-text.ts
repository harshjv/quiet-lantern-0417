export const serviceFieldText = {
  kind: 'Immutable after creation',
  command: 'Overrides the image CMD',
  build_args: 'Non-secret Dockerfile build arguments',
  ports: 'At least one for web, none for other kinds',
  health: 'The Signal health check',
  limits: 'Resource limits',
  schedule: 'The Timetable for a cron service',
  strategy: 'replace when volumes is non-empty, else overlap; not for cron and one_off',
  multi_writer_safe: 'Allows overlap with a volume',
  drain_timeout_s: 'Seconds to drain the old container',
  readonly_rootfs: 'Mount the root filesystem read-only',
  secrets_owner: 'Owner of file-injected secrets; the image user by default',
  pre_deploy: 'A command run once before green starts',
} as const

export const portFieldText = {
  port: 'The container port, unique per service',
  protocol: 'http is routed by the Gateway, tcp only by exposure',
  grpc: 'The http port speaks gRPC',
} as const

export const domainFieldText = {
  generated: 'A generated hostname; exactly one of generated and hostname',
  hostname: 'A hostname under a configured zone, or any name for direct ingress',
  ingress: 'direct in 1a; tunnel from 1b',
} as const

export const volumeFieldText = {
  mount_path: 'Absolute, unique per service, not /run/secrets',
} as const

export const variablePatchText = {
  set: 'Variables to set: key, kind (literal, reference or sealed), and value or reference',
  unset: 'Keys to remove',
  allow_unresolved: 'Accept a reference whose target does not exist yet (default false)',
} as const
