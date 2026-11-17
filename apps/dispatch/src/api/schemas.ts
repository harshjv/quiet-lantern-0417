import type { Static, TSchema } from '@sinclair/typebox'
import { t } from 'elysia'

import {
  appFieldText,
  appKindValues,
  dnsLogTail,
  injectionValues,
  keyKindValues,
  keyNamePattern,
  keyPatchText,
  portFieldText,
  portProtocolValues,
  portRange,
  probeKinds,
  probeTimeout,
  scheduleConcurrencyValues,
  slugPattern,
  strategyValues,
  StringEnum,
  volumeFieldText,
} from '@stationly/protocol'

export const input = <S extends TSchema>(schema: S) => t.Unsafe<Static<S>>(schema)

export const AppSource = t.Union(
  [
    t.Object(
      {
        type: t.Literal('image'),
        ref: t.String({
          minLength: 1,
        }),
      },
      {
        additionalProperties: false,
      },
    ),
    t.Object(
      {
        type: t.Literal('dockerfile'),
        repo: t.String({
          minLength: 1,
        }),
        branch: t.String({
          minLength: 1,
        }),
        path: t.Optional(t.String()),
        dockerfile: t.Optional(t.String()),
      },
      {
        additionalProperties: false,
      },
    ),
    t.Object(
      {
        type: t.Literal('railpack'),
        repo: t.String({
          minLength: 1,
        }),
        branch: t.String({
          minLength: 1,
        }),
        path: t.Optional(t.String()),
      },
      {
        additionalProperties: false,
      },
    ),
    t.Object(
      {
        type: t.Literal('local'),
        path: t.Optional(t.String()),
        dockerfile: t.Optional(
          t.String({
            minLength: 1,
          }),
        ),
      },
      {
        additionalProperties: false,
      },
    ),
    t.Object(
      {
        type: t.Literal('template'),
        template_version_id: t.String(),
      },
      {
        additionalProperties: false,
      },
    ),
  ],
  {
    description:
      'Where the image comes from: type=image with ref, type=dockerfile or type=railpack with repo and branch, or type=local for sly push',
  },
)

const timing = {
  interval_s: t.Optional(
    t.Integer({
      minimum: 1,
    }),
  ),
  timeout_s: t.Optional(
    t.Integer({
      minimum: 1,
    }),
  ),
  startup_timeout_s: t.Optional(
    t.Integer({
      minimum: 1,
    }),
  ),
  passes: t.Optional(
    t.Integer({
      minimum: 1,
    }),
  ),
  failures: t.Optional(
    t.Integer({
      minimum: 1,
    }),
  ),
}

export const HealthInput = t.Union([
  t.Object(
    {
      type: t.Literal('http'),
      path: t.String({
        pattern: '^/',
      }),
      port: t.Integer(portRange),
      host: t.Optional(
        t.String({
          pattern: '^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$',
        }),
      ),
      ...timing,
    },
    {
      additionalProperties: false,
    },
  ),
  t.Object(
    {
      type: t.Literal('tcp'),
      port: t.Integer(portRange),
      ...timing,
    },
    {
      additionalProperties: false,
    },
  ),
  t.Object(
    {
      type: t.Literal('image'),
    },
    {
      additionalProperties: false,
    },
  ),
  t.Object(
    {
      type: t.Literal('alive'),
      seconds: t.Integer({
        minimum: 1,
      }),
    },
    {
      additionalProperties: false,
    },
  ),
])

export const PortInput = t.Object(
  {
    port: t.Integer({
      ...portRange,
      description: portFieldText.port,
    }),
    protocol: t.Optional(
      input(
        StringEnum(portProtocolValues, {
          description: portFieldText.protocol,
        }),
      ),
    ),
    grpc: t.Optional(
      t.Boolean({
        description: portFieldText.grpc,
      }),
    ),
  },
  {
    additionalProperties: false,
  },
)

export const VolumeInput = t.Object(
  {
    mount_path: t.String({
      pattern: '^/',
      description: volumeFieldText.mount_path,
    }),
  },
  {
    additionalProperties: false,
  },
)

export const KeySet = t.Object(
  {
    name: t.String({
      pattern: keyNamePattern,
    }),
    kind: input(StringEnum(keyKindValues)),
    value: t.Optional(t.String()),
    reference: t.Optional(t.String()),
    injection: t.Optional(input(StringEnum(injectionValues))),
    build: t.Optional(t.Boolean()),
  },
  {
    additionalProperties: false,
  },
)

export const Limits = t.Object(
  {
    cpu_millis: t.Optional(
      t.Integer({
        minimum: 1,
      }),
    ),
    memory_bytes: t.Optional(
      t.Integer({
        minimum: 4194304,
      }),
    ),
  },
  {
    additionalProperties: false,
    description: appFieldText.limits,
  },
)

export const Schedule = t.Object(
  {
    cron: t.String({
      minLength: 1,
    }),
    timezone: t.String({
      minLength: 1,
    }),
    concurrency: input(StringEnum(scheduleConcurrencyValues)),
  },
  {
    additionalProperties: false,
  },
)

const mutable = {
  source: t.Optional(AppSource),
  server_id: t.Optional(
    t.String({
      description: 'The server to run on; the only online server by default',
    }),
  ),
  command: t.Optional(
    t.Union([t.Array(t.String()), t.Null()], {
      description: appFieldText.command,
    }),
  ),
  build_args: t.Optional(
    t.Union([t.Record(t.String(), t.String()), t.Null()], {
      description: appFieldText.build_args,
    }),
  ),
  ports: t.Optional(
    t.Array(PortInput, {
      description: appFieldText.ports,
    }),
  ),
  volumes: t.Optional(
    t.Array(VolumeInput, {
      description: 'Volumes to mount, each by mount_path',
    }),
  ),
  limits: t.Optional(Limits),
  health: t.Optional(
    t.Union([HealthInput, t.Null()], {
      description: appFieldText.health,
    }),
  ),
  strategy: t.Optional(
    input(
      StringEnum(strategyValues, {
        description: appFieldText.strategy,
      }),
    ),
  ),
  multi_writer_safe: t.Optional(
    t.Boolean({
      description: appFieldText.multi_writer_safe,
    }),
  ),
  drain_timeout_s: t.Optional(
    t.Integer({
      minimum: 0,
      description: appFieldText.drain_timeout_s,
    }),
  ),
  readonly_rootfs: t.Optional(
    t.Boolean({
      description: appFieldText.readonly_rootfs,
    }),
  ),
  secrets_owner: t.Optional(
    t.Union(
      [
        t.Object({
          uid: t.Integer({
            minimum: 0,
          }),
          gid: t.Integer({
            minimum: 0,
          }),
        }),
        t.Null(),
      ],
      {
        description: appFieldText.secrets_owner,
      },
    ),
  ),
  pre_deploy: t.Optional(
    t.Union([t.Array(t.String()), t.Null()], {
      description: appFieldText.pre_deploy,
    }),
  ),
  schedule: t.Optional(
    t.Union([Schedule, t.Null()], {
      description: appFieldText.schedule,
    }),
  ),
  keys: t.Optional(
    t.Array(KeySet, {
      description: 'App keys to set: name, kind, and value or reference',
    }),
  ),
}

export const AppCreate = t.Object(
  {
    name: t.String({
      pattern: slugPattern,
      description: 'The app name and DNS label',
    }),
    kind: input(
      StringEnum(appKindValues, {
        description: appFieldText.kind,
      }),
    ),
    ...mutable,
    source: AppSource,
    deploy_on_create: t.Optional(
      t.Boolean({
        description: 'Deploy the new app at once (default true)',
      }),
    ),
  },
  {
    additionalProperties: false,
  },
)

export const AppPatch = t.Object(
  {
    ...mutable,
    deploy: t.Optional(
      t.Boolean({
        description: 'Deploy when the configuration changed (default true)',
      }),
    ),
  },
  {
    additionalProperties: false,
  },
)

export const KeysPatch = {
  set: t.Optional(
    t.Array(KeySet, {
      description: keyPatchText.set,
    }),
  ),
  unset: t.Optional(
    t.Array(
      t.String({
        pattern: keyNamePattern,
      }),
      {
        description: keyPatchText.unset,
      },
    ),
  ),
  apply: t.Optional(
    t.Boolean({
      description: 'Redeploy the dependents the change makes stale (default false)',
    }),
  ),
  allow_unresolved: t.Optional(
    t.Boolean({
      description: keyPatchText.allow_unresolved,
    }),
  ),
}

export const supersede = t.Optional(
  t.Boolean({
    description:
      'Replace a deployment in flight that has not reached cutover, instead of DEPLOY_IN_PROGRESS (default false)',
  }),
)

export const ProbeBody = t.Object(
  {
    to: t.String({
      minLength: 1,
      maxLength: 260,
      description: 'An app, a <name>.internal, or a host or address with :port',
    }),
    port: t.Optional(
      t.Integer({
        ...portRange,
        description: "The target port; the target's only declared port by default",
      }),
    ),
    kind: t.Optional(
      input(
        StringEnum(probeKinds, {
          description: 'One TCP handshake (default) or one DNS query',
        }),
      ),
    ),
    timeout_s: t.Optional(
      t.Integer({
        minimum: probeTimeout.minS,
        maximum: probeTimeout.maxS,
        description: `How long to wait for the answer (default ${probeTimeout.defaultS} s)`,
      }),
    ),
  },
  {
    additionalProperties: false,
  },
)

export const DnsLogQuery = t.Object({
  tail: t.Optional(
    t.Numeric({
      minimum: 1,
      maximum: dnsLogTail.max,
      description: `The last N queries (default ${dnsLogTail.default}, at most ${dnsLogTail.max})`,
    }),
  ),
  name: t.Optional(
    t.String({
      minLength: 1,
      maxLength: 253,
      description: 'Only names containing this, ignoring case',
    }),
  ),
  rcode: t.Optional(
    t.String({
      minLength: 1,
      maxLength: 16,
      description: 'Only answers with this response code, such as NXDOMAIN',
    }),
  ),
})
