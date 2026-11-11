import { Type } from '@sinclair/typebox'

import { slugPattern, variableKeyPattern, variableKindValues } from './domain.ts'
import { variablePatchText } from './field-text.ts'
import {
  sandboxEgressModeValues,
  sandboxNetworkValues,
  SandboxRuntime,
  sandboxTtl,
} from './model.ts'
import { Port, StringEnum } from './primitives.ts'
import { SandboxWorkspaceInput } from './workspace.ts'

export const sandboxExecLimits = {
  envBytes: 64 * 1024,
  stdinBytes: 256 * 1024,
  timeoutS: {
    default: 1800,
    max: 86400,
  },
  activeRuns: 16,
  forwards: 16,
} as const

export const SandboxSizeInput = Type.Object(
  {
    cpu_millis: Type.Optional(
      Type.Integer({
        minimum: 100,
      }),
    ),
    memory_bytes: Type.Optional(
      Type.Integer({
        minimum: 67108864,
      }),
    ),
    disk_bytes: Type.Optional(
      Type.Integer({
        minimum: 1073741824,
      }),
    ),
  },
  {
    additionalProperties: false,
    description: 'cpu_millis, memory_bytes and disk_bytes; the disk only grows',
  },
)

export const SandboxEgressInput = Type.Object(
  {
    mode: StringEnum(sandboxEgressModeValues),
    domains: Type.Optional(
      Type.Array(
        Type.Object(
          {
            domain: Type.String({
              minLength: 1,
              maxLength: 253,
            }),
            wildcard: Type.Optional(Type.Boolean()),
            ports: Type.Optional(Type.Array(Port)),
          },
          {
            additionalProperties: false,
          },
        ),
      ),
    ),
  },
  {
    additionalProperties: false,
    description: 'Outbound traffic: mode open or allowlist, with the allowed domains',
  },
)

export const SandboxVariableSet = Type.Object(
  {
    key: Type.String({
      pattern: variableKeyPattern,
    }),
    kind: StringEnum(variableKindValues),
    value: Type.Optional(Type.String()),
    reference: Type.Optional(Type.String()),
  },
  {
    additionalProperties: false,
  },
)

const ttl = Type.Integer({
  minimum: sandboxTtl.min,
  maximum: sandboxTtl.max,
  description: `Time to live after each start (default ${sandboxTtl.default} s)`,
})

const command = Type.Union(
  [
    Type.Array(Type.String(), {
      minItems: 1,
    }),
    Type.Null(),
  ],
  {
    description: "Overrides the image's entrypoint and command for the init process",
  },
)

const configurable = {
  command: Type.Optional(command),
  size: Type.Optional(SandboxSizeInput),
  network: Type.Optional(
    StringEnum(sandboxNetworkValues, {
      description: "isolated (default), or environment to join the environment's network",
    }),
  ),
  docker: Type.Optional(
    Type.Boolean({
      description: 'Start dockerd inside at boot (default false)',
    }),
  ),
  egress: Type.Optional(SandboxEgressInput),
  ttl_s: Type.Optional(ttl),
}

export const SandboxCreateBody = Type.Object(
  {
    name: Type.Optional(
      Type.String({
        pattern: slugPattern,
        description: 'Unique in the environment; generated from the id by default',
      }),
    ),
    image: Type.Optional(
      Type.Object(
        {
          ref: Type.String({
            minLength: 1,
          }),
        },
        {
          additionalProperties: false,
          description: 'ref=<image>; the toolchain image by default',
        },
      ),
    ),
    from: Type.Optional(
      Type.Union(
        [
          Type.Object(
            {
              sandbox: Type.String({
                minLength: 1,
              }),
            },
            {
              additionalProperties: false,
            },
          ),
          Type.Object(
            {
              snapshot: Type.String({
                minLength: 1,
              }),
            },
            {
              additionalProperties: false,
            },
          ),
        ],
        {
          description: 'Fork the disk of sandbox=<sandbox> or snapshot=<snapshot id>',
        },
      ),
    ),
    station_id: Type.Optional(
      Type.String({
        minLength: 1,
        description: 'The station to place it on; a sandbox never moves',
      }),
    ),
    runtime: Type.Optional(SandboxRuntime),
    ...configurable,
    variables: Type.Optional(
      Type.Array(SandboxVariableSet, {
        description: variablePatchText.set,
      }),
    ),
    workspace: Type.Optional(SandboxWorkspaceInput),
    start: Type.Optional(
      Type.Boolean({
        description: 'Start it once created (default true)',
      }),
    ),
  },
  {
    additionalProperties: false,
  },
)

export const SandboxPatchBody = Type.Object(
  {
    ...configurable,
  },
  {
    additionalProperties: false,
  },
)

export const SandboxStartBody = Type.Object(
  {
    ttl_s: Type.Optional(ttl),
  },
  {
    additionalProperties: false,
  },
)

export const SandboxExecBody = Type.Object(
  {
    command: Type.Array(Type.String(), {
      minItems: 1,
    }),
    cwd: Type.Optional(
      Type.String({
        minLength: 1,
      }),
    ),
    user: Type.Optional(
      Type.String({
        minLength: 1,
      }),
    ),
    env: Type.Optional(
      Type.Record(
        Type.String({
          pattern: '^[A-Za-z_][A-Za-z0-9_]*$',
        }),
        Type.String(),
      ),
    ),
    stdin: Type.Optional(
      Type.String({
        pattern: '^[A-Za-z0-9_-]*$',
        maxLength: Math.ceil((sandboxExecLimits.stdinBytes * 4) / 3),
      }),
    ),
    timeout_s: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: sandboxExecLimits.timeoutS.max,
      }),
    ),
    attach: Type.Optional(Type.Boolean()),
    wait_s: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 10,
      }),
    ),
  },
  {
    additionalProperties: false,
  },
)

export const SandboxShellBody = Type.Object(
  {
    command: Type.Optional(
      Type.Array(Type.String(), {
        minItems: 1,
      }),
    ),
    user: Type.Optional(
      Type.String({
        minLength: 1,
      }),
    ),
    cwd: Type.Optional(
      Type.String({
        minLength: 1,
      }),
    ),
  },
  {
    additionalProperties: false,
  },
)

export const SandboxVariablesPatchBody = Type.Object(
  {
    set: Type.Optional(
      Type.Array(SandboxVariableSet, {
        description: variablePatchText.set,
      }),
    ),
    unset: Type.Optional(
      Type.Array(
        Type.String({
          pattern: variableKeyPattern,
        }),
        {
          description: variablePatchText.unset,
        },
      ),
    ),
    allow_unresolved: Type.Optional(
      Type.Boolean({
        description: variablePatchText.allow_unresolved,
      }),
    ),
  },
  {
    additionalProperties: false,
  },
)

export const SandboxSnapshotBody = Type.Object(
  {
    name: Type.Optional(
      Type.String({
        pattern: slugPattern,
        description: 'Unique in the environment when set',
      }),
    ),
  },
  {
    additionalProperties: false,
  },
)

export const SandboxStorageGrowRequest = Type.Object(
  {
    size_bytes: Type.Integer({
      minimum: 1,
      description: 'The new size of the sandbox filesystem; it only grows',
    }),
  },
  {
    additionalProperties: false,
  },
)
