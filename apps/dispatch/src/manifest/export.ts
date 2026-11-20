import { and, asc, eq, inArray } from 'drizzle-orm'
import { stringify } from 'yaml'

import { isTransient } from '../api/changes.ts'
import {
  productionOf,
  type AppRow,
  type ProjectRow,
  type TargetRow,
  type VariableRow,
} from '../api/lookup.ts'
import type { Db } from '../db/client.ts'
import { app, app_port, domain, server, target, volume } from '../db/schema.ts'
import { normalizeHealth } from '../generation/health.ts'
import type { Keyring } from '../secrets/keyring.ts'
import { decryptValue, headValue, variablesOf, type ValueTarget } from '../secrets/values.ts'

import { defaultLimits } from './plan.ts'

type Json = Record<string, unknown>

const sorted = <T>(entries: [string, T][]) =>
  Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)))

const latest = (db: Db, keyring: Keyring, row: VariableRow, valueTarget: ValueTarget) => {
  const value = headValue(db, row.id, valueTarget)

  return value ? decryptValue(keyring, value) : null
}

const withFlags = (base: Json, row: VariableRow) => ({
  ...base,
  ...(row.injection !== 'env'
    ? {
        injection: row.injection,
      }
    : {}),
  ...(row.build
    ? {
        build: true,
      }
    : {}),
})

const appVariable = (db: Db, keyring: Keyring, row: VariableRow): unknown => {
  const plain = row.injection === 'env' && !row.build

  if (row.kind === 'secret') {
    return withFlags(
      {
        secret: true,
        ...(row.reference
          ? {
              reference: row.reference,
            }
          : {}),
      },
      row,
    )
  }

  if (row.kind === 'reference' || row.reference) {
    return plain
      ? row.reference
      : withFlags(
          {
            reference: row.reference,
          },
          row,
        )
  }

  const value = latest(db, keyring, row, 'production') ?? ''

  if (plain && !value.includes('${{')) {
    return value
  }

  return withFlags(
    {
      value,
    },
    row,
  )
}

const omitDefaults = (value: Json, defaults: Json) =>
  Object.fromEntries(
    Object.entries(value).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(defaults[k])),
  )

const exportSource = (source: Json) => {
  const { auth: _auth, ...rest } = source

  if (rest.type === 'image') {
    return {
      type: 'image',
      ref: rest.ref,
    }
  }

  if (rest.type === 'local') {
    return rest.dockerfile
      ? {
          type: 'local',
          dockerfile: rest.dockerfile,
        }
      : {
          type: 'local',
        }
  }

  const out: Json = {
    type: rest.type,
    repo: rest.repo,
  }

  if (rest.branch !== undefined) {
    out.branch = rest.branch
  }

  if (rest.path !== undefined && rest.path !== '/' && rest.path !== '.') {
    out.path = rest.path
  }

  if (
    rest.type === 'dockerfile' &&
    rest.dockerfile !== undefined &&
    rest.dockerfile !== null &&
    rest.dockerfile !== 'Dockerfile'
  ) {
    out.dockerfile = rest.dockerfile
  }

  return out
}

type AppExport = { doc: Json; overridable: Json }

const exportApp = (
  db: Db,
  keyring: Keyring,
  svc: AppRow,
  stationNames: Map<string, string>,
  multiStation: boolean,
): AppExport => {
  const ports = db
    .select()
    .from(app_port)
    .where(eq(app_port.app_id, svc.id))
    .orderBy(asc(app_port.port))
    .all()
  const portDocs = ports.map((p) => ({
    port: p.port,
    protocol: p.protocol,
    grpc: p.grpc,
  }))
  const volumes = db
    .select()
    .from(volume)
    .where(and(eq(volume.app_id, svc.id), eq(volume.status, 'active')))
    .orderBy(asc(volume.mount_path))
    .all()
  const portIds = ports.map((p) => p.id)
  const portOf = new Map(ports.map((p) => [p.id, p]))
  const domains = portIds.length
    ? db
        .select()
        .from(domain)
        .where(inArray(domain.app_port_id, portIds))
        .orderBy(asc(domain.hostname))
        .all()
    : []
  const keys = variablesOf(db, {
    scope: 'app',
    id: svc.id,
  }).all()
  const firstHttp = portDocs.find((p) => p.protocol === 'http')?.port
  const doc: Json = {
    kind: svc.kind,
    source: exportSource(svc.source),
  }

  if (multiStation) {
    doc.server = stationNames.get(svc.server_id)
  }

  if (svc.command) {
    doc.command = svc.command
  }

  if (svc.build_args && Object.keys(svc.build_args).length) {
    doc.build_args = sorted(Object.entries(svc.build_args))
  }

  if (portDocs.length) {
    doc.ports = portDocs.map((p) => ({
      port: p.port,
      ...(p.protocol !== 'http'
        ? {
            protocol: p.protocol,
          }
        : {}),
      ...(p.grpc
        ? {
            grpc: true,
          }
        : {}),
    }))
  }

  const defaultHealth = normalizeHealth(svc.kind, portDocs, undefined)

  if (svc.health && JSON.stringify(svc.health) !== JSON.stringify(defaultHealth)) {
    const base = normalizeHealth(svc.kind, portDocs, {
      type: (svc.health as { type: 'http' }).type,
    })

    doc.health = {
      type: svc.health.type,
      ...omitDefaults(svc.health, {
        ...(base as Json),
        type: undefined,
      }),
    }
  }

  const limits = omitDefaults(svc.limits, defaultLimits)

  if (Object.keys(limits).length) {
    doc.limits = limits
  }

  const defaultStrategy = volumes.length > 0 ? 'replace' : 'overlap'

  if (svc.kind !== 'cron' && svc.kind !== 'one_off' && svc.strategy !== defaultStrategy) {
    doc.strategy = svc.strategy
  }

  if (svc.multi_writer_safe) {
    doc.multi_writer_safe = true
  }

  if (svc.drain_timeout_s !== 30) {
    doc.drain_timeout_s = svc.drain_timeout_s
  }

  if (svc.readonly_rootfs) {
    doc.readonly_rootfs = true
  }

  if (svc.secrets_owner) {
    doc.secrets_owner = svc.secrets_owner
  }

  if (svc.pre_deploy) {
    doc.pre_deploy = svc.pre_deploy
  }

  const overridable: Json = {}

  if (svc.schedule) {
    overridable.schedule = {
      cron: svc.schedule.cron,
      ...omitDefaults(
        {
          timezone: svc.schedule.timezone,
          concurrency: svc.schedule.concurrency,
        },
        {
          timezone: 'UTC',
          concurrency: 'skip',
        },
      ),
    }
  }

  if (volumes.length) {
    doc.volumes = volumes.map((v) => ({
      mount_path: v.mount_path,
    }))
  }

  if (domains.length) {
    overridable.domains = domains.map((d) => {
      const port = portOf.get(d.app_port_id)!.port
      const out: Json =
        d.kind === 'generated'
          ? {
              generated: true,
            }
          : {
              hostname: d.hostname,
            }

      if (port !== firstHttp) {
        out.port = port
      }

      return out
    })
  }

  if (keys.length) {
    overridable.env = sorted(keys.map((v) => [v.name, appVariable(db, keyring, v)]))
  }

  if (svc.desired_state !== 'running') {
    overridable.desired_state = svc.desired_state
  }

  const source = svc.source

  if (source.branch !== undefined) {
    overridable.source = {
      branch: source.branch,
    }
  }

  if (source.type === 'image') {
    overridable.source = {
      ref: source.ref,
    }
  }

  if (multiStation) {
    overridable.server = stationNames.get(svc.server_id)
  }

  overridable.limits = svc.limits

  return {
    doc: order({
      ...doc,
      ...overridable,
      source: doc.source,
      limits: doc.limits,
    }),
    overridable,
  }
}

const keyOrder = [
  'kind',
  'source',
  'server',
  'command',
  'build_args',
  'ports',
  'health',
  'limits',
  'strategy',
  'multi_writer_safe',
  'drain_timeout_s',
  'readonly_rootfs',
  'secrets_owner',
  'pre_deploy',
  'schedule',
  'volumes',
  'domains',
  'env',
  'desired_state',
]

const order = (doc: Json) =>
  Object.fromEntries(keyOrder.filter((k) => doc[k] !== undefined).map((k) => [k, doc[k]]))

const projectVariable = (
  db: Db,
  keyring: Keyring,
  row: VariableRow,
  places: TargetRow[],
): unknown => {
  if (row.kind === 'secret') {
    return {
      secret: true,
      ...(row.reference
        ? {
            reference: row.reference,
          }
        : {}),
    }
  }

  if (row.reference) {
    return row.reference
  }

  const production = latest(db, keyring, row, 'production')
  const preview = latest(db, keyring, row, 'preview')

  if (places.length === 1) {
    return (places[0]!.kind === 'preview' ? (preview ?? production) : production) ?? ''
  }

  if (preview === null || preview === production) {
    return production ?? ''
  }

  return {
    ...(production !== null
      ? {
          production,
        }
      : {}),
    preview,
  }
}

const diffOverride = (base: Json, other: Json) => {
  const out: Json = {}

  for (const key of ['source', 'server', 'limits', 'domains', 'desired_state', 'schedule', 'env']) {
    const a = base[key]
    const b = other[key]

    if (JSON.stringify(a) === JSON.stringify(b)) {
      continue
    }

    if (b === undefined) {
      out[key] = null
    } else if (key === 'env' && a && typeof a === 'object' && b && typeof b === 'object') {
      const changed = Object.fromEntries(
        Object.entries(b as Json).filter(
          ([k, v]) => JSON.stringify((a as Json)[k]) !== JSON.stringify(v),
        ),
      )

      if (Object.keys(changed).length) {
        out[key] = changed
      }
    } else if (key === 'limits') {
      out[key] = omitDefaults(b as Json, a as Json)
    } else {
      out[key] = b
    }
  }

  return out
}

export const exportManifest = (
  db: Db,
  keyring: Keyring,
  proj: ProjectRow,
  chosen: TargetRow | null,
) => {
  const base = chosen ?? productionOf(db, proj.id)
  const stations = db
    .select()
    .from(server)
    .all()
    .filter((s) => !s.revoked_at)
  const stationNames = new Map(stations.map((s) => [s.id, s.name]))
  const multiStation = stations.length > 1
  const appsOf = (place: TargetRow) =>
    new Map(
      db
        .select()
        .from(app)
        .where(eq(app.target_id, place.id))
        .all()
        .map((svc) => [svc.name, exportApp(db, keyring, svc, stationNames, multiStation)] as const),
    )
  const baseApps = appsOf(base)
  const others = chosen
    ? []
    : db
        .select()
        .from(target)
        .where(eq(target.project_id, proj.id))
        .all()
        .filter((e) => e.id !== base.id && !isTransient(e))
  const projectRows = variablesOf(db, {
    scope: 'project',
    id: proj.id,
  }).all()
  const doc: Json = {
    version: 1,
    project: proj.name,
  }

  if (projectRows.length) {
    doc.env = sorted(
      projectRows.map((row) => [
        row.name,
        projectVariable(db, keyring, row, chosen ? [chosen] : [base, ...others]),
      ]),
    )
  }

  if (baseApps.size) {
    doc.apps = sorted([...baseApps].map(([name, e]) => [name, e.doc]))
  }

  const overrides: Json = {}

  for (const preview of others) {
    const apps: Json = {}

    for (const [name, e] of appsOf(preview)) {
      const baseline = baseApps.get(name)

      if (!baseline) {
        continue
      }

      const diff = diffOverride(baseline.overridable, e.overridable)

      if (Object.keys(diff).length) {
        apps[name] = diff
      }
    }

    if (Object.keys(apps).length) {
      overrides[preview.name] = {
        apps: sorted(Object.entries(apps)),
      }
    }
  }

  if (Object.keys(overrides).length) {
    doc.previews = sorted(Object.entries(overrides))
  }

  return doc
}

export const manifestYaml = (doc: Json, schemaUrl: string) =>
  `# yaml-language-server: $schema=${schemaUrl}\n${stringify(doc, {
    defaultStringType: 'QUOTE_DOUBLE',
    defaultKeyType: 'PLAIN',
    lineWidth: 0,
  })}`
