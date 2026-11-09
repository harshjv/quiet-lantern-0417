import { Type, type SchemaOptions, type TLiteral, type TSchema, type TUnion } from '@sinclair/typebox'

const crockfordUlid = '[0-9A-HJKMNP-TV-Z]{26}'

export const idPrefixes = {
  station: 'stn',
  project: 'prj',
  environment: 'env',
  service: 'svc',
  service_port: 'prt',
  volume: 'vol',
  domain: 'dom',
  port_allocation: 'pal',
  deployment: 'dep',
  deployment_step: 'stp',
  build: 'bld',
  run: 'run',
  variable: 'var',
  secret_value: 'sec',
  grant: 'grt',
  attachment: 'att',
  staged_change: 'chg',
  template: 'tpl',
  template_version: 'tpv',
  firewall_policy: 'fwp',
  firewall_rule: 'fwr',
  flow_rollup: 'flw',
  ipam_allocation: 'ipa',
  virtual_ip: 'vip',
  attestation: 'atn',
  vex_statement: 'vex',
  component: 'cmp',
  advisory: 'adv',
  token: 'tok',
  audit_event: 'aud',
  event: 'evt',
  notification_channel: 'ntf',
  agent_hook: 'hok',
  setting: 'set',
  volume_snapshot: 'snp',
  station_generation: 'gen',
  station_outbox: 'obx',
  blob: 'blb',
  drift: 'drf',
  data_key: 'dk',
  master_key_wrap: 'mkw',
  github_app: 'gha',
  github_installation: 'ghi',
  instance: 'ins',
  platform_release: 'rel',
  platform_upgrade: 'pup',
  message: 'msg',
  sandbox: 'sbx',
  sandbox_snapshot: 'sbs'
} as const

export type IdEntity = keyof typeof idPrefixes

export const idPattern = (entity: IdEntity) => `^${idPrefixes[entity]}_${crockfordUlid}$`

export const Id = (entity: IdEntity) => Type.String({ pattern: idPattern(entity) })

export const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()])

type Literals<T extends readonly string[]> = { -readonly [K in keyof T]: TLiteral<T[K] & string> }

export const StringEnum = <const T extends readonly string[]>(values: T, options?: SchemaOptions): TUnion<Literals<T>> =>
  Type.Union(values.map(value => Type.Literal(value)), options) as unknown as TUnion<Literals<T>>

export const Timestamp = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d{1,9})?Z$' })

export const Digest = Type.String({ pattern: '^sha256:[0-9a-f]{64}$' })

export const Sha256Hex = Type.String({ pattern: '^[0-9a-f]{64}$' })

export const Base64Url = Type.String({ pattern: '^[A-Za-z0-9_-]+$' })

export const Base64UrlBytes32 = Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' })

export const Base64UrlBytes64 = Type.String({ pattern: '^[A-Za-z0-9_-]{86}$' })

export const UnixMillis = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })

export const Count = Type.Integer({ minimum: 0 })

export const Seconds = Type.Integer({ minimum: 0 })

export const Bytes = Type.Integer({ minimum: 0 })

export const Port = Type.Integer({ minimum: 1, maximum: 65535 })

export const Json = Type.Unknown()

export const JsonObject = Type.Record(Type.String(), Type.Unknown())

export const IdMap = <T extends TSchema>(value: T) => Type.Record(Type.String(), value)
