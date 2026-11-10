import { variableKeyPattern as variableKeySource } from '@stationly/protocol/domain'

import type { Variable } from './api'
import { inputPattern } from './format'

export type VariableKind = Variable['kind']

export const variableKinds: VariableKind[] = ['literal', 'sealed', 'reference']

export const variableKeyPattern = inputPattern(variableKeySource)

export const variableKeyTitle = 'Upper case letters, digits and underscores'

export const sealedNote =
  'Sealed values are write-only. No endpoint returns them, including to you.'

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
