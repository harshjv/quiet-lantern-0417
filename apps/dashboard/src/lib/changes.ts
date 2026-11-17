import type { App, Approval, Change } from './api'
import { bytes, plural, sourceText } from './format'
import {
  appKind,
  deploymentStrategy,
  deploymentTrigger,
  injection,
  keyKind,
  sentence,
} from './labels'

export type Names = ReadonlyMap<string, string>

export type Field =
  | { key: string; label: string; value: string }
  | { key: string; label: string; before: string; after: string }

type Data = Record<string, unknown>

const nouns: Record<string, string> = {
  app: 'app',
  app_port: 'port',
  volume: 'volume',
  volume_snapshot: 'volume snapshot',
  volume_restore: 'volume restore',
  domain: 'domain',
  port_allocation: 'public port',
  key: 'key',
  deployment: 'deployment',
  preview: 'preview',
  setting: 'setting',
  run: 'run',
  network_probe: 'test connection',
  lockfile: 'release',
  server: 'server',
  machine_storage: 'machine storage',
}

const verbs = {
  add: 'Add',
  update: 'Change',
  remove: 'Remove',
} as const

const labels: Record<string, string> = {
  kind: 'Kind',
  source: 'Source',
  server_id: 'Server',
  app_id: 'App',
  command: 'Command',
  build_args: 'Build arguments',
  limits: 'Limits',
  cpu_millis: 'CPU',
  memory_bytes: 'Memory',
  size_bytes: 'Size',
  health: 'Health check',
  strategy: 'Deploy strategy',
  multi_writer_safe: 'Safe with several writers',
  drain_timeout_s: 'Drain timeout',
  readonly_rootfs: 'Read-only root filesystem',
  secrets_owner: 'Secrets owner',
  pre_deploy: 'Before each deploy',
  schedule: 'Schedule',
  cron: 'Cron',
  timezone: 'Time zone',
  concurrency: 'When a run overlaps',
  port: 'Port',
  protocol: 'Protocol',
  grpc: 'gRPC',
  mount_path: 'Mount path',
  trigger: 'Trigger',
  type: 'Type',
  reference: 'Reference',
  injection: 'Injected as',
  build: 'At build time',
  target: 'Value for',
  host_port: 'Public port',
  ingress: 'Ingress',
  status: 'Status',
  value: 'Value',
}

const shownInTitle = new Set(['name', 'hostname'])

const internal = new Set(['value_id', 'scope', 'value_length', 'version', 'digest'])

export const record = (value: unknown): Data | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : null

const isRef = (value: unknown) => typeof value === 'string' && value.startsWith('new:')

const blank = (value: unknown) =>
  value === null ||
  value === undefined ||
  value === '' ||
  (Array.isArray(value) && value.length === 0) ||
  (record(value) !== null && Object.values(record(value)!).every(blank))

export const fieldLabel = (key: string) => labels[key] ?? sentence(key)

const known = (map: Record<string, string>, value: unknown) =>
  typeof value === 'string' ? (map[value] ?? value) : null

export const formatValue = (key: string, value: unknown, names: Names, entity?: string): string => {
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No'
  }

  if (typeof value === 'number') {
    if (key.endsWith('bytes')) {
      return bytes(value)
    }

    if (key === 'cpu_millis') {
      return `${value / 1000} vCPU`
    }

    if (key.endsWith('_s')) {
      return `${value} s`
    }

    return String(value)
  }

  if (typeof value === 'string') {
    if (key.endsWith('_id') || key === 'id') {
      return names.get(value) ?? value
    }

    if (key === 'kind') {
      return (
        (entity === 'key' ? known(keyKind, value) : null) ??
        (entity === 'app' ? known(appKind, value) : null) ??
        sentence(value)
      )
    }

    if (key === 'strategy') {
      return known(deploymentStrategy, value) ?? value
    }

    if (key === 'injection') {
      return known(injection, value) ?? value
    }

    if (key === 'protocol') {
      return value.toUpperCase()
    }

    return value
  }

  if (Array.isArray(value)) {
    return value.map((item) => formatValue(key, item, names, entity)).join(', ')
  }

  const data = record(value)

  if (!data) {
    return ''
  }

  if (key === 'source' && typeof data.type === 'string') {
    return sourceText({
      source: data as App['source'],
    })
  }

  if (key === 'trigger' && typeof data.type === 'string') {
    return known(deploymentTrigger, data.type) ?? data.type
  }

  return Object.entries(data)
    .filter(([inner, item]) => !blank(item) && !internal.has(inner))
    .map(([inner, item]) => `${fieldLabel(inner)} ${formatValue(inner, item, names, entity)}`)
    .join(' · ')
}

const keyValue = (data: Data) =>
  typeof data.value_length === 'number'
    ? `Hidden · ${plural(data.value_length, 'byte')}${typeof data.version === 'number' ? ` · version ${data.version}` : ''}`
    : null

const visible = ([key, value]: [string, unknown]) =>
  !shownInTitle.has(key) &&
  !internal.has(key) &&
  !blank(value) &&
  !(key === 'allow_unresolved' && value === false)

const objectFields = (entity: string, after: Data, before: Data | null, names: Names): Field[] => {
  const fields = Object.entries(after)
    .filter(visible)
    .map(([key, value]): Field => {
      const now = formatValue(key, value, names, entity)
      const was = before && key in before ? formatValue(key, before[key], names, entity) : null

      return was !== null && was !== now
        ? {
            key,
            label: fieldLabel(key),
            before: was || 'none',
            after: now,
          }
        : {
            key,
            label: fieldLabel(key),
            value: now,
          }
    })
  const value = entity === 'key' ? keyValue(after) : null

  return value
    ? [
        ...fields,
        {
          key: 'value',
          label: fieldLabel('value'),
          value,
        },
      ]
    : fields
}

export const changeFields = (change: Change, names: Names): Field[] => {
  const after = record(change.after)
  const before = record(change.before)

  if (change.op === 'update' && !after) {
    const key = (change.path ?? '').split('/').filter(Boolean).at(-1) ?? 'value'

    return [
      {
        key,
        label: fieldLabel(key),
        before: blank(change.before)
          ? 'none'
          : formatValue(key, change.before, names, change.entity),
        after: blank(change.after) ? 'none' : formatValue(key, change.after, names, change.entity),
      },
    ]
  }

  if (change.op === 'remove') {
    return before ? objectFields(change.entity, before, null, names) : []
  }

  return after
    ? objectFields(change.entity, after, change.op === 'update' ? before : null, names)
    : []
}

const ownName = (change: Change) => {
  const data = record(change.after) ?? record(change.before)

  if (!data) {
    return null
  }

  const name = data.name ?? data.hostname ?? data.mount_path ?? data.port ?? data.host_port

  return typeof name === 'string' || typeof name === 'number' ? String(name) : null
}

export const nameOf = (
  id: string | null | undefined,
  changes: readonly Change[],
  names: Names,
): string | null => {
  if (!id) {
    return null
  }

  if (isRef(id)) {
    const added = changes.find((change) => change.ref === id)

    return added ? subjectName(added, changes, names) : null
  }

  if (id.startsWith('env_')) {
    return names.get(id) ?? 'production'
  }

  return names.get(id) ?? null
}

export function subjectName(change: Change, changes: readonly Change[], names: Names) {
  if (change.entity === 'deployment') {
    return nameOf(change.parent, changes, names)
  }

  return ownName(change) ?? nameOf(change.id, changes, names)
}

export type Headline = { verb: string; noun: string; name: string | null; parent: string | null }

export const describeChange = (
  change: Change,
  changes: readonly Change[],
  names: Names,
): Headline =>
  change.entity === 'deployment'
    ? {
        verb: 'Deploy',
        noun: '',
        name: nameOf(change.parent, changes, names),
        parent: null,
      }
    : {
        verb: verbs[change.op],
        noun: nouns[change.entity] ?? sentence(change.entity).toLowerCase(),
        name: subjectName(change, changes, names),
        parent: change.op === 'add' ? nameOf(change.parent, changes, names) : null,
      }

export const topLevel = (changes: readonly Change[]) =>
  changes.filter((change) => !isRef(change.parent))

export const approvalHeadline = (
  approval: Pick<Approval, 'title' | 'source' | 'project_id' | 'changes'>,
  names: Names,
) => {
  const changes = approval.changes ?? []
  const subjects = topLevel(changes)

  if (approval.source === 'task' || subjects.length !== 1) {
    return approval.title
  }

  const { verb, noun, name } = describeChange(subjects[0]!, changes, names)

  if (!name || subjects[0]!.entity === 'lockfile') {
    return approval.title
  }

  return [verb, noun, name, 'in', approval.project_id ? 'production' : 'the instance']
    .filter(Boolean)
    .join(' ')
}
