import { and, asc, eq, inArray } from 'drizzle-orm'
import { stringify } from 'yaml'

import type { EnvironmentRow, ProjectRow, ServiceRow, VariableRow } from '../api/lookup.ts'
import type { Db } from '../db/client.ts'
import {
  domain,
  environment,
  port_allocation,
  service,
  service_port,
  station,
  volume,
} from '../db/schema.ts'
import { normalizeHealth } from '../generation/health.ts'
import type { Keyring } from '../secrets/keyring.ts'
import { decryptValue, headValue, variablesOf } from '../secrets/values.ts'

import { defaultLimits } from './plan.ts'

type Json = Record<string, unknown>

const sorted = <T>(entries: [string, T][]) =>
  Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)))

const latest = (db: Db, keyring: Keyring, row: VariableRow, environmentId: string | null) => {
  const value = headValue(db, row.id, environmentId)

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

const serviceVariable = (db: Db, keyring: Keyring, row: VariableRow): unknown => {
  const plain = row.injection === 'env' && !row.build

  if (row.kind === 'sealed') {
    return withFlags(
      {
        sealed: true,
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

  const value = latest(db, keyring, row, null) ?? ''

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

type ServiceExport = { doc: Json; overridable: Json }

const exportService = (
  db: Db,
  keyring: Keyring,
  svc: ServiceRow,
  stationNames: Map<string, string>,
  multiStation: boolean,
): ServiceExport => {
  const ports = db
    .select()
    .from(service_port)
    .where(eq(service_port.service_id, svc.id))
    .orderBy(asc(service_port.port))
    .all()
  const portDocs = ports.map((p) => ({
    port: p.port,
    protocol: p.protocol,
    grpc: p.grpc,
  }))
  const volumes = db
    .select()
    .from(volume)
    .where(and(eq(volume.service_id, svc.id), eq(volume.status, 'active')))
    .orderBy(asc(volume.mount_path))
    .all()
  const portIds = ports.map((p) => p.id)
  const portOf = new Map(ports.map((p) => [p.id, p]))
  const domains = portIds.length
    ? db
        .select()
        .from(domain)
        .where(inArray(domain.service_port_id, portIds))
        .orderBy(asc(domain.hostname))
        .all()
    : []
  const allocations = portIds.length
    ? db
        .select()
        .from(port_allocation)
        .where(
          and(
            inArray(port_allocation.service_port_id, portIds),
            eq(port_allocation.status, 'active'),
          ),
        )
        .all()
    : []
  const variables = variablesOf(db, {
    scope: 'service',
    id: svc.id,
  }).all()
  const firstHttp = portDocs.find((p) => p.protocol === 'http')?.port
  const doc: Json = {
    kind: svc.kind,
    source: exportSource(svc.source),
  }

  if (multiStation) {
    doc.station = stationNames.get(svc.station_id)
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
      const port = portOf.get(d.service_port_id)!.port
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

      if (d.ingress !== 'direct') {
        out.ingress = d.ingress
      }

      return out
    })
  }

  if (allocations.length) {
    overridable.expose_tcp = allocations
      .map((a) => portOf.get(a.service_port_id)!.port)
      .sort((a, b) => a - b)
  }

  if (variables.length) {
    overridable.variables = sorted(variables.map((v) => [v.key, serviceVariable(db, keyring, v)]))
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
    overridable.station = stationNames.get(svc.station_id)
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
  'station',
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
  'expose_tcp',
  'variables',
  'desired_state',
]

const order = (doc: Json) =>
  Object.fromEntries(keyOrder.filter((k) => doc[k] !== undefined).map((k) => [k, doc[k]]))

const projectVariable = (
  db: Db,
  keyring: Keyring,
  row: VariableRow,
  environments: EnvironmentRow[],
): unknown => {
  if (row.kind === 'sealed') {
    return {
      sealed: true,
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

  const fallback = latest(db, keyring, row, null)
  const perEnv = environments
    .map((e) => [e.name, latest(db, keyring, row, e.id)] as const)
    .filter((e): e is readonly [string, string] => e[1] !== null)

  if (!perEnv.length) {
    return fallback ?? ''
  }

  return {
    ...(fallback !== null
      ? {
          default: fallback,
        }
      : {}),
    environments: sorted(perEnv.map(([k, v]) => [k, v])),
  }
}

const diffOverride = (base: Json, other: Json) => {
  const out: Json = {}

  for (const key of [
    'source',
    'station',
    'limits',
    'domains',
    'expose_tcp',
    'desired_state',
    'schedule',
    'variables',
  ]) {
    const a = base[key]
    const b = other[key]

    if (JSON.stringify(a) === JSON.stringify(b)) {
      continue
    }

    if (b === undefined) {
      out[key] = null
    } else if (key === 'variables' && a && typeof a === 'object' && b && typeof b === 'object') {
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
  target: EnvironmentRow | null,
) => {
  const base =
    target ??
    db.select().from(environment).where(eq(environment.id, proj.default_environment_id)).get()!
  const stations = db
    .select()
    .from(station)
    .all()
    .filter((s) => !s.revoked_at)
  const stationNames = new Map(stations.map((s) => [s.id, s.name]))
  const multiStation = stations.length > 1
  const servicesOf = (env: EnvironmentRow) =>
    new Map(
      db
        .select()
        .from(service)
        .where(eq(service.environment_id, env.id))
        .all()
        .map(
          (svc) => [svc.name, exportService(db, keyring, svc, stationNames, multiStation)] as const,
        ),
    )
  const baseServices = servicesOf(base)
  const others = target
    ? []
    : db
        .select()
        .from(environment)
        .where(eq(environment.project_id, proj.id))
        .all()
        .filter((e) => e.id !== base.id && !e.ephemeral)
  const projectRows = variablesOf(db, {
    scope: 'project',
    id: proj.id,
  }).all()
  const doc: Json = {
    version: 1,
    project: proj.name,
  }

  if (projectRows.length) {
    doc.variables = sorted(
      projectRows.map((row) => [
        row.key,
        projectVariable(db, keyring, row, target ? [target] : [base, ...others]),
      ]),
    )
  }

  if (baseServices.size) {
    doc.services = sorted([...baseServices].map(([name, e]) => [name, e.doc]))
  }

  const overrides: Json = {}

  for (const env of others) {
    const services: Json = {}

    for (const [name, e] of servicesOf(env)) {
      const baseline = baseServices.get(name)

      if (!baseline) {
        continue
      }

      const diff = diffOverride(baseline.overridable, e.overridable)

      if (Object.keys(diff).length) {
        services[name] = diff
      }
    }

    if (Object.keys(services).length) {
      overrides[env.name] = {
        services: sorted(Object.entries(services)),
      }
    }
  }

  if (Object.keys(overrides).length) {
    doc.environments = sorted(Object.entries(overrides))
  }

  return doc
}

export const manifestYaml = (doc: Json, schemaUrl: string) =>
  `# yaml-language-server: $schema=${schemaUrl}\n${stringify(doc, {
    defaultStringType: 'QUOTE_DOUBLE',
    defaultKeyType: 'PLAIN',
    lineWidth: 0,
  })}`
