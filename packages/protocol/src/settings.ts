import { Type, type Static, type TSchema } from '@sinclair/typebox'

import { ingressValues } from './model.ts'
import { networkLayout } from './network.ts'
import { StringEnum } from './primitives.ts'
import { Lockfile } from './release.ts'

const Str = Type.String({
  minLength: 1,
})
const Int = Type.Integer({
  minimum: 0,
})
const Pct = Type.Integer({
  minimum: 1,
  maximum: 100,
})
const Bool = Type.Boolean()

export const cidrPattern = '^\\d{1,3}(\\.\\d{1,3}){3}/\\d{1,2}$'

const Cidr = Type.String({
  pattern: cidrPattern,
})

type SettingOptions<T extends TSchema> = { default?: Static<T>; station?: true }

const define = <T extends TSchema, O extends SettingOptions<T> = {}>(schema: T, options?: O) =>
  ({
    schema,
    ...options,
  }) as { schema: T } & O

export const settings = {
  'instance.id': define(Str),
  'hostnames.dashboard': define(Str),
  'hostnames.api': define(Str),
  'access.team_domain': define(Str),
  'access.aud': define(Str),
  'exposure.port_range': define(
    Type.String({
      pattern: '^\\d{1,5}-\\d{1,5}$',
    }),
    {
      default: '30000-32767',
      station: true,
    },
  ),
  'disk.warning_pct': define(Pct, {
    default: 80,
    station: true,
  }),
  'disk.critical_pct': define(Pct, {
    default: 90,
    station: true,
  }),
  'oauth.dynamic_registration': define(Bool, {
    default: false,
  }),
  'ipam.pool': define(Cidr, {
    default: networkLayout.defaultPool,
    station: true,
  }),
  'ipam.virtual_prefix': define(Cidr, {
    default: networkLayout.defaultVirtualPrefix,
    station: true,
  }),
  'ingress.mode': define(StringEnum(ingressValues)),
  'cloudflare.zone_id': define(Str),
  'cloudflare.account_id': define(Str),
  'logs.retention.runtime_days': define(Int, {
    station: true,
  }),
  'logs.retention.build_days': define(Int, {
    station: true,
  }),
  'logs.retention.run_days': define(Int, {
    station: true,
  }),
  'logs.retention.system_days': define(Int, {
    station: true,
  }),
  'logs.retention.runtime_bytes_per_service': define(Int, {
    station: true,
  }),
  'github.poll_interval_s': define(Int, {
    default: 300,
  }),
  'workshop.idle_timeout_s': define(Int, {
    default: 3600,
    station: true,
  }),
  'workshop.max_builds_per_project': define(Int, {
    default: 1,
    station: true,
  }),
  'workshop.max_daemons_per_station': define(Int, {
    default: 4,
  }),
  'registry.gc_schedule': define(Str, {
    default: '0 3 * * *',
    station: true,
  }),
  'base_images.check_interval_s': define(Int, {
    default: 21600,
  }),
  'advisories.check_interval_s': define(Int),
  'disk.deploy_margin_bytes': define(Int),
  'gaming.quiet_period_s': define(Int),
  'platform.release_check': define(Bool, {
    default: false,
  }),
  'platform.protected': define(Bool, {
    default: false,
  }),
  'platform.lockfile': define(Lockfile, {
    station: true,
  }),
  'platform.allow_unsigned': define(Bool, {
    default: false,
    station: true,
  }),
  'advisories.pin_db': define(Bool),
  'guard.learn_window_s': define(Int, {
    default: 259200,
  }),
  'gateway.rate_per_source': define(
    Type.Integer({
      minimum: 0,
      maximum: 1000000,
    }),
    {
      default: 20,
      station: true,
    },
  ),
  'sandbox.stopped_retention_s': define(
    Type.Union([
      Type.Literal(0),
      Type.Integer({
        minimum: 86400,
      }),
    ]),
    {
      default: 604800,
    },
  ),
  'sandbox.agent_events_retention_s': define(
    Type.Integer({
      minimum: 3600,
    }),
    {
      default: 604800,
    },
  ),
  'sandbox.agent_events_output': define(Bool, {
    default: false,
  }),
  'volume_backup.target': define(
    Type.Union([
      Type.Object(
        {
          type: Type.Literal('s3'),
          endpoint: Str,
          bucket: Str,
          prefix: Type.String(),
          credentials_variable: Str,
        },
        {
          additionalProperties: false,
        },
      ),
      Type.Object(
        {
          type: Type.Literal('path'),
          path: Str,
        },
        {
          additionalProperties: false,
        },
      ),
    ]),
  ),
  'volume_backup.schedule': define(Str),
  'volume_backup.schedule_quiesce': define(Bool, {
    default: true,
  }),
  'volume_backup.keep': define(
    Type.Integer({
      minimum: 1,
      maximum: 1000,
    }),
    {
      default: 7,
    },
  ),
  'cloudflare.token_variable': define(Str),
  'acme.email': define(
    Type.String({
      pattern: '^[^@\\s]+@[^@\\s]+$',
    }),
    {
      station: true,
    },
  ),
  'acme.ca_server': define(Str),
  'auth.passkey_rp_id': define(Str),
  'domains.zone': define(Str),
  'acme.dns_provider': define(
    Type.Object(
      {
        provider: Str,
        token_variable: Str,
      },
      {
        additionalProperties: false,
      },
    ),
  ),
  'acme.fallback_ca': define(
    Type.Object(
      {
        ca_server: Str,
        eab_kid: Str,
        eab_hmac_variable: Str,
      },
      {
        additionalProperties: false,
      },
    ),
  ),
}

export type SettingKey = keyof typeof settings

export type SettingValue<K extends SettingKey> = Static<(typeof settings)[K]['schema']>

export type DefaultedSettingKey = {
  [K in SettingKey]: (typeof settings)[K] extends { default: unknown } ? K : never
}[SettingKey]

export type ResolvedSetting<K extends SettingKey> = K extends DefaultedSettingKey
  ? SettingValue<K>
  : SettingValue<K> | null

type Definition = { schema: TSchema; default?: unknown; station?: true }

export const settingKeys = Object.keys(settings) as SettingKey[]

export const isSettingKey = (key: string): key is SettingKey => key in settings

export const settingDefault = <K extends SettingKey>(key: K) =>
  ((settings[key] as Definition).default ?? null) as ResolvedSetting<K>

export const stationSettingKeys = settingKeys.filter((key) => (settings[key] as Definition).station)
