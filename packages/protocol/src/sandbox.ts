import { Type } from '@sinclair/typebox'

import { environmentVariableKindValues, environmentVariableNamePattern } from './domain.ts'
import { machineEgressModeValues } from './model.ts'
import { Port, StringEnum } from './primitives.ts'

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

export const MachineEnvironmentVariableSet = Type.Object(
  {
    name: Type.String({
      pattern: environmentVariableNamePattern,
    }),
    kind: StringEnum(environmentVariableKindValues),
    value: Type.Optional(Type.String()),
    reference: Type.Optional(Type.String()),
  },
  {
    additionalProperties: false,
  },
)

export const TaskStorageGrowRequest = Type.Object(
  {
    size_bytes: Type.Integer({
      minimum: 1,
      description: 'The new size of task storage; it only grows',
    }),
  },
  {
    additionalProperties: false,
  },
)
