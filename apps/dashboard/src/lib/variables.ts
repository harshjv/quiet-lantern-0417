import { keyNamePattern as keyNameSource } from '@stationly/protocol/domain'

import type { Key } from './api'
import { optimistic } from './cache.ts'
import { inputPattern } from './format.ts'

export type KeyKind = Key['kind']

export const keyKinds: KeyKind[] = ['literal', 'sealed', 'reference']

export const keyNamePattern = inputPattern(keyNameSource)

export const keyNameTitle = 'Upper case letters, digits and underscores'

export const sealedNote =
  'Sealed values are write-only. No endpoint returns them, including to you.'

export const noValueLabel = 'No value here'

export const hasNoValue = (key: Pick<Key, 'kind' | 'head_version'>) =>
  key.kind === 'sealed' && !key.head_version

export const buildNote =
  'Build-time keys reach the Dockerfile as BuildKit secrets: read one with RUN --mount=type=secret,id=KEY. They never become build arguments or image layers.'

export const referencePlaceholder = '${{db.HOST}}'

export const projectReference = '${{project.NAME}}'

export type KeyEntry = {
  name: string
  kind: KeyKind
  value: string
  build: boolean
  injection?: 'env' | 'file'
}

const valueOf = (kind: KeyKind, value: string) =>
  kind === 'reference'
    ? {
        reference: value,
      }
    : {
        value,
      }

export const toKeyInput = ({ name, kind, value, build, injection }: KeyEntry) => ({
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

export const toMachineKeyInput = ({ name, kind, value }: KeyEntry) => ({
  name,
  kind,
  ...valueOf(kind, value),
})

export const draftKey = (entry: KeyEntry, scope: Key['scope'], existing?: Key): Key =>
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

export const withDraft = (list: Key[], entry: KeyEntry, scope: Key['scope']) =>
  list.some((v) => v.name === entry.name)
    ? list.map((v) => (v.name === entry.name ? draftKey(entry, scope, v) : v))
    : [...list, draftKey(entry, scope)]

export const withoutKeys = (list: Key[], names: string[]) =>
  list.filter((v) => !names.includes(v.name))
