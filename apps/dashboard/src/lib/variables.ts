import { environmentVariableNamePattern } from '@stationly/protocol/domain'

import type { EnvironmentVariable } from './api'
import { optimistic } from './cache.ts'
import { inputPattern } from './format.ts'

export type EnvironmentVariableKind = EnvironmentVariable['kind']

export const variableKinds: EnvironmentVariableKind[] = ['literal', 'secret', 'reference']

export const variableNamePattern = inputPattern(environmentVariableNamePattern)

export const variableNameTitle = 'Upper case letters, digits and underscores'

export const secretNote =
  'Secret values are write-only. No endpoint returns them, including to you.'

export const noValueLabel = 'No value here'

export const hasNoValue = (variable: Pick<EnvironmentVariable, 'kind' | 'head_version'>) =>
  variable.kind === 'secret' && !variable.head_version

export const buildNote =
  'Build-time environment variables reach the Dockerfile as BuildKit secrets: read one with RUN --mount=type=secret,id=KEY. They never become build arguments or image layers.'

export const referencePlaceholder = '${{db.HOST}}'

export const projectReference = '${{project.NAME}}'

export type VariableEntry = {
  name: string
  kind: EnvironmentVariableKind
  value: string
  build: boolean
  injection?: 'env' | 'file'
}

const valueOf = (kind: EnvironmentVariableKind, value: string) =>
  kind === 'reference'
    ? {
        reference: value,
      }
    : {
        value,
      }

export const toVariableInput = ({ name, kind, value, build, injection }: VariableEntry) => ({
  name,
  kind,
  build,
  ...(injection
    ? {
        injection,
      }
    : {}),
  ...valueOf(kind, value),
})

export const toMachineVariableInput = ({ name, kind, value }: VariableEntry) => ({
  name,
  kind,
  ...valueOf(kind, value),
})

export const draftVariable = (
  entry: VariableEntry,
  scope: EnvironmentVariable['scope'],
  existing?: EnvironmentVariable,
): EnvironmentVariable =>
  optimistic({
    id: `draft-${entry.name}`,
    head_version: null,
    bytes: null,
    ...existing,
    scope,
    name: entry.name,
    kind: entry.kind,
    reference: entry.kind === 'reference' ? entry.value : null,
    injection: entry.injection ?? existing?.injection ?? 'env',
    build: entry.build,
  })

export const withDraft = (
  list: EnvironmentVariable[],
  entry: VariableEntry,
  scope: EnvironmentVariable['scope'],
) =>
  list.some((v) => v.name === entry.name)
    ? list.map((v) => (v.name === entry.name ? draftVariable(entry, scope, v) : v))
    : [...list, draftVariable(entry, scope)]

export const withoutVariables = (list: EnvironmentVariable[], names: string[]) =>
  list.filter((v) => !names.includes(v.name))
