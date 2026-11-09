import { Type } from '@sinclair/typebox'
import { sandboxNetworkValues, sandboxTtl } from './model.ts'
import { Port, StringEnum } from './primitives.ts'

export const sandboxNamePattern = '^[a-z0-9][a-z0-9-]{0,62}$'

export const sandboxExecLimits = { envBytes: 64 * 1024, stdinBytes: 256 * 1024, timeoutS: { default: 1800, max: 86400 }, activeRuns: 16, forwards: 16 } as const

export const SandboxSizeInput = Type.Object(
  {
    cpu_millis: Type.Optional(Type.Integer({ minimum: 100 })),
    memory_bytes: Type.Optional(Type.Integer({ minimum: 67108864 })),
    disk_bytes: Type.Optional(Type.Integer({ minimum: 1073741824 }))
  },
  { additionalProperties: false }
)

export const SandboxEgressInput = Type.Object(
  {
    mode: StringEnum(['open', 'allowlist']),
    domains: Type.Optional(
      Type.Array(
        Type.Object(
          {
            domain: Type.String({ minLength: 1, maxLength: 253 }),
            wildcard: Type.Optional(Type.Boolean()),
            ports: Type.Optional(Type.Array(Port))
          },
          { additionalProperties: false }
        )
      )
    )
  },
  { additionalProperties: false }
)

export const SandboxVariableSet = Type.Object(
  {
    key: Type.String({ pattern: '^[A-Z_][A-Z0-9_]*$' }),
    kind: StringEnum(['literal', 'reference', 'sealed']),
    value: Type.Optional(Type.String()),
    reference: Type.Optional(Type.String())
  },
  { additionalProperties: false }
)

const ttl = Type.Integer({ minimum: sandboxTtl.min, maximum: sandboxTtl.max })

const command = Type.Union([Type.Array(Type.String(), { minItems: 1 }), Type.Null()])

const configurable = {
  command: Type.Optional(command),
  size: Type.Optional(SandboxSizeInput),
  network: Type.Optional(StringEnum(sandboxNetworkValues)),
  docker: Type.Optional(Type.Boolean()),
  egress: Type.Optional(SandboxEgressInput),
  ttl_s: Type.Optional(ttl)
}

export const SandboxCreateBody = Type.Object(
  {
    name: Type.Optional(Type.String({ pattern: sandboxNamePattern })),
    image: Type.Optional(Type.Object({ ref: Type.String({ minLength: 1 }) }, { additionalProperties: false })),
    from: Type.Optional(
      Type.Union([Type.Object({ sandbox: Type.String({ minLength: 1 }) }, { additionalProperties: false }), Type.Object({ snapshot: Type.String({ minLength: 1 }) }, { additionalProperties: false })])
    ),
    station_id: Type.Optional(Type.String({ minLength: 1 })),
    ...configurable,
    variables: Type.Optional(Type.Array(SandboxVariableSet)),
    start: Type.Optional(Type.Boolean())
  },
  { additionalProperties: false }
)

export const SandboxPatchBody = Type.Object({ ...configurable }, { additionalProperties: false })

export const SandboxStartBody = Type.Object({ ttl_s: Type.Optional(ttl) }, { additionalProperties: false })

export const SandboxExecBody = Type.Object(
  {
    command: Type.Array(Type.String(), { minItems: 1 }),
    cwd: Type.Optional(Type.String({ minLength: 1 })),
    user: Type.Optional(Type.String({ minLength: 1 })),
    env: Type.Optional(Type.Record(Type.String({ pattern: '^[A-Za-z_][A-Za-z0-9_]*$' }), Type.String())),
    stdin: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_-]*$', maxLength: Math.ceil((sandboxExecLimits.stdinBytes * 4) / 3) })),
    timeout_s: Type.Optional(Type.Integer({ minimum: 1, maximum: sandboxExecLimits.timeoutS.max })),
    attach: Type.Optional(Type.Boolean()),
    wait_s: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 }))
  },
  { additionalProperties: false }
)

export const SandboxShellBody = Type.Object(
  {
    command: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
    user: Type.Optional(Type.String({ minLength: 1 })),
    cwd: Type.Optional(Type.String({ minLength: 1 }))
  },
  { additionalProperties: false }
)

export const SandboxVariablesPatchBody = Type.Object(
  {
    set: Type.Optional(Type.Array(SandboxVariableSet)),
    unset: Type.Optional(Type.Array(Type.String({ pattern: '^[A-Z_][A-Z0-9_]*$' }))),
    allow_unresolved: Type.Optional(Type.Boolean())
  },
  { additionalProperties: false }
)

export const SandboxSnapshotBody = Type.Object({ name: Type.Optional(Type.String({ pattern: sandboxNamePattern })) }, { additionalProperties: false })

export const SandboxStorageGrowRequest = Type.Object({ size_bytes: Type.Integer({ minimum: 1 }) }, { additionalProperties: false })
