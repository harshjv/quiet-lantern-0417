import { Type } from '@sinclair/typebox'

import { keyKindValues, keyNamePattern, slugPattern } from './domain.ts'
import { keyPatchText } from './field-text.ts'
import {
  machineEgressModeValues,
  machineNetworkValues,
  MachineRuntime,
  machineTtl,
} from './model.ts'
import { Port, StringEnum } from './primitives.ts'
import { MachineWorkspaceInput } from './workspace.ts'

export const machineExecLimits = {
  envBytes: 64 * 1024,
  stdinBytes: 256 * 1024,
  timeoutS: {
    default: 1800,
    max: 86400,
  },
  activeRuns: 16,
  forwards: 16,
} as const

export const MachineSizeInput = Type.Object(
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

export const MachineEgressInput = Type.Object(
  {
    mode: StringEnum(machineEgressModeValues),
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

export const MachineKeySet = Type.Object(
  {
    name: Type.String({
      pattern: keyNamePattern,
    }),
    kind: StringEnum(keyKindValues),
    value: Type.Optional(Type.String()),
    reference: Type.Optional(Type.String()),
  },
  {
    additionalProperties: false,
  },
)

const ttl = Type.Integer({
  minimum: machineTtl.min,
  maximum: machineTtl.max,
  description: `Time to live after each start (default ${machineTtl.default} s)`,
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
  size: Type.Optional(MachineSizeInput),
  network: Type.Optional(
    StringEnum(machineNetworkValues, {
      description: "isolated (default), or environment to join the environment's network",
    }),
  ),
  docker: Type.Optional(
    Type.Boolean({
      description: 'Start dockerd inside at boot (default false)',
    }),
  ),
  egress: Type.Optional(MachineEgressInput),
  ttl_s: Type.Optional(ttl),
}

export const MachineCreateBody = Type.Object(
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
              machine: Type.String({
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
          description: 'Fork the disk of machine=<machine> or snapshot=<snapshot id>',
        },
      ),
    ),
    server_id: Type.Optional(
      Type.String({
        minLength: 1,
        description: 'The server to place it on; a machine never moves',
      }),
    ),
    runtime: Type.Optional(MachineRuntime),
    ...configurable,
    keys: Type.Optional(
      Type.Array(MachineKeySet, {
        description: keyPatchText.set,
      }),
    ),
    workspace: Type.Optional(MachineWorkspaceInput),
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

export const MachinePatchBody = Type.Object(
  {
    ...configurable,
  },
  {
    additionalProperties: false,
  },
)

export const MachineStartBody = Type.Object(
  {
    ttl_s: Type.Optional(ttl),
  },
  {
    additionalProperties: false,
  },
)

export const MachineExecBody = Type.Object(
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
        maxLength: Math.ceil((machineExecLimits.stdinBytes * 4) / 3),
      }),
    ),
    timeout_s: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: machineExecLimits.timeoutS.max,
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

export const MachineShellBody = Type.Object(
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

export const MachineKeysPatchBody = Type.Object(
  {
    set: Type.Optional(
      Type.Array(MachineKeySet, {
        description: keyPatchText.set,
      }),
    ),
    unset: Type.Optional(
      Type.Array(
        Type.String({
          pattern: keyNamePattern,
        }),
        {
          description: keyPatchText.unset,
        },
      ),
    ),
    allow_unresolved: Type.Optional(
      Type.Boolean({
        description: keyPatchText.allow_unresolved,
      }),
    ),
  },
  {
    additionalProperties: false,
  },
)

export const MachineSnapshotBody = Type.Object(
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

export const MachineStorageGrowRequest = Type.Object(
  {
    size_bytes: Type.Integer({
      minimum: 1,
      description: 'The new size of the machine filesystem; it only grows',
    }),
  },
  {
    additionalProperties: false,
  },
)
