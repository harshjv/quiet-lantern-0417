import { variableKeyPattern as variableKeySource } from '@stationly/protocol/domain'

import type { Variable } from './api'
import { optimistic } from './cache.ts'
import { inputPattern } from './format.ts'

export type VariableKind = Variable['kind']

export const variableKinds: VariableKind[] = ['literal', 'sealed', 'reference']

export const variableKeyPattern = inputPattern(variableKeySource)

export const variableKeyTitle = 'Upper case letters, digits and underscores'

export const sealedNote =
  'Sealed values are write-only. No endpoint returns them, including to you.'

export const noValueLabel = 'No value in this environment'

export const hasNoValue = (variable: Pick<Variable, 'kind' | 'head_version'>) =>
  variable.kind === 'sealed' && !variable.head_version

export const buildNote =
  'Build-time variables reach the Dockerfile as BuildKit secrets: read one with RUN --mount=type=secret,id=KEY. They never become build arguments or image layers.'

export const referencePlaceholder = '${{db.HOST}}'

export type VariableEntry = {
  key: string
  kind: VariableKind
  value: string
  build: boolean
  injection?: 'env' | 'file'
}

const valueOf = (kind: VariableKind, value: string) =>
  kind === 'reference'
    ? {
        reference: value,
      }
    : {
        value,
      }

export const toVariableInput = ({ key, kind, value, build, injection }: VariableEntry) => ({
  key,
  kind,
  build,
  ...(injection
    ? {
        injection,
      }
    : {}),
  ...valueOf(kind, value),
})

export const toSandboxVariableInput = ({ key, kind, value }: VariableEntry) => ({
  key,
  kind,
  ...valueOf(kind, value),
})

export const draftVariable = (
  entry: VariableEntry,
  scope: Variable['scope'],
  existing?: Variable,
): Variable =>
  optimistic({
    id: `draft-${entry.key}`,
    head_version: null,
    bytes: null,
    copy_to_clones: false,
    ...existing,
    scope,
    key: entry.key,
    kind: entry.kind,
    reference: entry.kind === 'reference' ? entry.value : null,
    injection: entry.injection ?? existing?.injection ?? 'env',
    build: entry.build,
  })

export const withDraft = (list: Variable[], entry: VariableEntry, scope: Variable['scope']) =>
  list.some((v) => v.key === entry.key)
    ? list.map((v) => (v.key === entry.key ? draftVariable(entry, scope, v) : v))
    : [...list, draftVariable(entry, scope)]

export const withoutKeys = (list: Variable[], keys: string[]) =>
  list.filter((v) => !keys.includes(v.key))
