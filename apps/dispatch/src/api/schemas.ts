import { injectionValues, portProtocolValues, portRange, slugPattern, StringEnum, variableKeyPattern, variableKindValues } from '@stationly/protocol'
import type { Static, TSchema } from '@sinclair/typebox'
import { t } from 'elysia'

export const input = <S extends TSchema>(schema: S) => t.Unsafe<Static<S>>(schema)

export const BackupTargetInput = t.Union([
  t.Object({ type: t.Literal('path'), path: t.String({ minLength: 1 }) }, { additionalProperties: false }),
  t.Object({ type: t.Literal('s3'), endpoint: t.String({ minLength: 1 }), bucket: t.String({ minLength: 1 }), prefix: t.String(), credentials_variable: t.String({ minLength: 1 }) }, { additionalProperties: false })
])

export const ServiceSource = t.Union([
  t.Object({ type: t.Literal('image'), ref: t.String({ minLength: 1 }) }, { additionalProperties: false }),
  t.Object(
    { type: t.Literal('dockerfile'), repo: t.String({ minLength: 1 }), branch: t.String({ minLength: 1 }), path: t.Optional(t.String()), dockerfile: t.Optional(t.String()) },
    { additionalProperties: false }
  ),
  t.Object({ type: t.Literal('railpack'), repo: t.String({ minLength: 1 }), branch: t.String({ minLength: 1 }), path: t.Optional(t.String()) }, { additionalProperties: false }),
  t.Object({ type: t.Literal('local'), path: t.Optional(t.String()), dockerfile: t.Optional(t.String({ minLength: 1 })) }, { additionalProperties: false }),
  t.Object({ type: t.Literal('template'), template_version_id: t.String() }, { additionalProperties: false })
])

const timing = {
  interval_s: t.Optional(t.Integer({ minimum: 1 })),
  timeout_s: t.Optional(t.Integer({ minimum: 1 })),
  startup_timeout_s: t.Optional(t.Integer({ minimum: 1 })),
  passes: t.Optional(t.Integer({ minimum: 1 })),
  failures: t.Optional(t.Integer({ minimum: 1 }))
}

export const HealthInput = t.Union([
  t.Object({ type: t.Literal('http'), path: t.String({ pattern: '^/' }), port: t.Integer(portRange), host: t.Optional(t.String({ pattern: '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$' })), ...timing }, { additionalProperties: false }),
  t.Object({ type: t.Literal('tcp'), port: t.Integer(portRange), ...timing }, { additionalProperties: false }),
  t.Object({ type: t.Literal('image') }, { additionalProperties: false }),
  t.Object({ type: t.Literal('alive'), seconds: t.Integer({ minimum: 1 }) }, { additionalProperties: false })
])

export const PortInput = t.Object(
  { port: t.Integer(portRange), protocol: t.Optional(input(StringEnum(portProtocolValues))), grpc: t.Optional(t.Boolean()) },
  { additionalProperties: false }
)

export const VolumeInput = t.Object({ mount_path: t.String({ pattern: '^/' }) }, { additionalProperties: false })

export const VariableSet = t.Object(
  {
    key: t.String({ pattern: variableKeyPattern }),
    kind: input(StringEnum(variableKindValues)),
    value: t.Optional(t.String()),
    reference: t.Optional(t.String()),
    injection: t.Optional(input(StringEnum(injectionValues))),
    build: t.Optional(t.Boolean())
  },
  { additionalProperties: false }
)

export const Limits = t.Object({ cpu_millis: t.Optional(t.Integer({ minimum: 1 })), memory_bytes: t.Optional(t.Integer({ minimum: 4194304 })) }, { additionalProperties: false })

export const Schedule = t.Object(
  { cron: t.String({ minLength: 1 }), timezone: t.String({ minLength: 1 }), concurrency: t.Union([t.Literal('skip'), t.Literal('allow')]) },
  { additionalProperties: false }
)

const mutable = {
  source: t.Optional(ServiceSource),
  station_id: t.Optional(t.String()),
  command: t.Optional(t.Union([t.Array(t.String()), t.Null()])),
  build_args: t.Optional(t.Union([t.Record(t.String(), t.String()), t.Null()])),
  ports: t.Optional(t.Array(PortInput)),
  volumes: t.Optional(t.Array(VolumeInput)),
  limits: t.Optional(Limits),
  health: t.Optional(t.Union([HealthInput, t.Null()])),
  strategy: t.Optional(t.Union([t.Literal('overlap'), t.Literal('replace')])),
  multi_writer_safe: t.Optional(t.Boolean()),
  drain_timeout_s: t.Optional(t.Integer({ minimum: 0 })),
  readonly_rootfs: t.Optional(t.Boolean()),
  secrets_owner: t.Optional(t.Union([t.Object({ uid: t.Integer({ minimum: 0 }), gid: t.Integer({ minimum: 0 }) }), t.Null()])),
  pre_deploy: t.Optional(t.Union([t.Array(t.String()), t.Null()])),
  schedule: t.Optional(t.Union([Schedule, t.Null()])),
  variables: t.Optional(t.Array(VariableSet))
}

export const ServiceCreate = t.Object(
  {
    name: t.String({ pattern: slugPattern }),
    kind: t.Union([t.Literal('web'), t.Literal('worker'), t.Literal('cron'), t.Literal('one_off')]),
    ...mutable,
    source: ServiceSource,
    deploy_on_create: t.Optional(t.Boolean())
  },
  { additionalProperties: false }
)

export const ServicePatch = t.Object({ ...mutable, deploy: t.Optional(t.Boolean()) }, { additionalProperties: false })

export const VariablesPatch = {
  set: t.Optional(t.Array(VariableSet)),
  unset: t.Optional(t.Array(t.String({ pattern: variableKeyPattern }))),
  apply: t.Optional(t.Boolean()),
  allow_unresolved: t.Optional(t.Boolean())
}

export const ScopeInput = t.Object(
  { project_id: t.String(), environment_id: t.String(), level: t.Union([t.Literal('read'), t.Literal('deploy'), t.Literal('admin')]) },
  { additionalProperties: false }
)
