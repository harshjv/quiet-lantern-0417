import { Cron } from 'croner'
import { and, eq, inArray } from 'drizzle-orm'

import {
  appWithDefaults,
  pointer,
  type AppDoc,
  type AppKeyDoc,
  type AppOverrideDoc,
  type DomainDoc,
  type ManifestDoc,
  type ProjectKeyDoc,
} from '@stationly/manifest-schema'

import { can } from '../api/access.ts'
import { ChangeSet, isTransient, leafDiff, placeName, type Change } from '../api/changes.ts'
import { configDeployTrigger } from '../api/deployments.ts'
import { ApiError, fail } from '../api/errors.ts'
import { generatedHostname, requireGatewayPin } from '../api/exposure.ts'
import type { AppRow, KeyRow, ProjectRow, TargetRow } from '../api/lookup.ts'
import { oneLabelProblem } from '../auth/hostnames.ts'
import type { Principal } from '../auth/principal.ts'
import type { Level, Target } from '../auth/scopes.ts'
import type { Db } from '../db/client.ts'
import { app, app_port, domain, server, volume } from '../db/schema.ts'
import { readSetting } from '../db/settings.ts'
import { normalizeHealth, undeclaredHealthPort } from '../generation/health.ts'
import { pinImageSource, pinnedWarning } from '../platform/image-source.ts'
import type { Keyring } from '../secrets/keyring.ts'
import { parseValue, type Segment } from '../secrets/reference.ts'
import {
  decryptValue,
  headValue,
  keysOf,
  nextValueVersion,
  type ValueTarget,
} from '../secrets/values.ts'

export type Issue = { path: string; code: string; message: string }
export type Warning = { code: string; explanation: string; path?: string }
export type Unmanaged = {
  entity: string
  id: string
  app?: string
  name?: string
  hostname?: string
  port?: number
  mount_path?: string
}

export type RepoAuth = { auth: 'app' | 'public'; default_branch: string }
export type RepoResolver = (repo: string) => Promise<RepoAuth>

type Json = Record<string, unknown>
type PortDoc = { port: number; protocol: 'http' | 'tcp'; grpc: boolean }

export const defaultLimits = {
  cpu_millis: 1000,
  memory_bytes: 536870912,
}

const phase1b = 'is phase 1b and not available on this instance'

const overrideMerge = (base: AppDoc, override: AppOverrideDoc | undefined): AppDoc => {
  if (!override) {
    return base
  }

  const out: Json = {
    ...base,
  }

  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue
    }

    if (value === null) {
      delete out[key]
      continue
    }

    if (key === 'source') {
      out.source = {
        ...base.source,
        ...(value as Json),
      }
    } else if (
      (key === 'limits' || key === 'schedule' || key === 'keys') &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      out[key] = {
        ...((base as Json)[key] as Json | undefined),
        ...value,
      }
    } else {
      out[key] = value
    }
  }

  return out as AppDoc
}

export const effectiveApps = (doc: ManifestDoc, place: { kind: ValueTarget; name: string }) => {
  const overrides = place.kind === 'preview' ? (doc.previews?.[place.name]?.apps ?? {}) : {}

  return Object.fromEntries(
    Object.entries(doc.apps ?? {}).map(([name, svc]) => [
      name,
      overrideMerge(svc, overrides[name]),
    ]),
  )
}

export const canonicalScalar = (value: string | number | boolean) =>
  typeof value === 'string' ? value : String(value)

const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(sortKeys)
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys((value as Json)[k])]),
    )
  }

  return value
}

export const escapeLiteral = (value: string) => value.replaceAll('${{', () => '$${{')

type DesiredKey =
  | { kind: 'literal'; value: string; injection: 'env' | 'file'; build: boolean }
  | { kind: 'literal-generator'; reference: string; injection: 'env' | 'file'; build: boolean }
  | { kind: 'reference'; reference: string; injection: 'env' | 'file'; build: boolean }
  | { kind: 'sealed'; reference: string | null; injection: 'env' | 'file'; build: boolean }

const isGenerator = (segments: Segment[]) =>
  segments.length === 1 &&
  segments[0]!.type === 'reference' &&
  segments[0]!.target.type === 'generator'

const parseReference = (text: string, path: string, issues: Issue[]) => {
  try {
    const segments = parseValue(text)
    const references = segments.filter((s) => s.type === 'reference')

    if (references.length > 16) {
      issues.push({
        path,
        code: 'REFERENCE_SYNTAX',
        message: `A value holds at most 16 references; this one has ${references.length}.`,
      })
    }

    return segments
  } catch (error) {
    const reason =
      (error as { details?: { reason?: string } }).details?.reason ?? (error as Error).message

    if (/secret\(N\) must be the entire value/.test(reason)) {
      issues.push({
        path,
        code: 'GENERATOR_POSITION',
        message: 'secret(N) must be the whole value, never part of an interpolation.',
      })
    } else {
      issues.push({
        path,
        code: 'REFERENCE_SYNTAX',
        message: reason,
      })
    }

    return null
  }
}

const desiredAppKey = (raw: AppKeyDoc, path: string, issues: Issue[]): DesiredKey | null => {
  if (typeof raw !== 'object') {
    const text = canonicalScalar(raw)

    if (!text.includes('${{')) {
      return {
        kind: 'literal',
        value: text,
        injection: 'env',
        build: false,
      }
    }

    const segments = parseReference(text, path, issues)

    if (!segments) {
      return null
    }

    if (isGenerator(segments)) {
      return {
        kind: 'literal-generator',
        reference: text,
        injection: 'env',
        build: false,
      }
    }

    return {
      kind: 'reference',
      reference: text,
      injection: 'env',
      build: false,
    }
  }

  const injection = raw.injection ?? 'env'
  const build = raw.build ?? false
  const forms = [
    raw.value !== undefined,
    raw.reference !== undefined && !raw.sealed,
    raw.sealed === true,
  ].filter(Boolean).length

  if (forms !== 1) {
    issues.push({
      path,
      code: 'REFERENCE_SYNTAX',
      message:
        'Use exactly one of { value }, { reference } or { sealed: true }, optionally with a ${{secret(N)}} reference.',
    })

    return null
  }

  if (raw.value !== undefined) {
    return {
      kind: 'literal',
      value: raw.value,
      injection,
      build,
    }
  }

  if (raw.sealed) {
    if (raw.reference === undefined) {
      return {
        kind: 'sealed',
        reference: null,
        injection,
        build,
      }
    }

    const segments = parseReference(raw.reference, `${path}/reference`, issues)

    if (!segments) {
      return null
    }

    if (!isGenerator(segments)) {
      issues.push({
        path: `${path}/reference`,
        code: 'REFERENCE_SYNTAX',
        message: 'A sealed key takes only ${{secret(N)}} as its reference.',
      })

      return null
    }

    return {
      kind: 'sealed',
      reference: raw.reference,
      injection,
      build,
    }
  }

  const segments = parseReference(raw.reference!, `${path}/reference`, issues)

  if (!segments) {
    return null
  }

  if (isGenerator(segments)) {
    return {
      kind: 'literal-generator',
      reference: raw.reference!,
      injection,
      build,
    }
  }

  return {
    kind: 'reference',
    reference: raw.reference!,
    injection,
    build,
  }
}

type ProjectDesired = {
  sealed: boolean
  reference: string | null
  value: string | null
}

const desiredProjectKey = (
  raw: ProjectKeyDoc,
  valueTarget: ValueTarget,
  path: string,
  issues: Issue[],
): ProjectDesired | null => {
  const check = (text: string, at: string) => {
    if (!text.includes('${{')) {
      return true
    }

    const segments = parseReference(text, at, issues)

    if (segments && !isGenerator(segments)) {
      issues.push({
        path: at,
        code: 'PROJECT_REFERENCE',
        message:
          'Project keys hold literals or ${{secret(N)}}; reference project values from app keys instead.',
      })
    }

    return false
  }

  if (typeof raw !== 'object') {
    const text = canonicalScalar(raw)

    if (!check(text, path)) {
      return issues.some((i) => i.path === path)
        ? null
        : {
            sealed: false,
            reference: text,
            value: null,
          }
    }

    return {
      sealed: false,
      reference: null,
      value: valueTarget === 'production' ? text : null,
    }
  }

  if (raw.sealed) {
    if (raw.production !== undefined || raw.preview !== undefined) {
      issues.push({
        path,
        code: 'REFERENCE_SYNTAX',
        message:
          'A sealed project key never carries values in the file; set them with set_project_keys.',
      })
    }

    if (raw.reference !== undefined) {
      const segments = parseReference(raw.reference, `${path}/reference`, issues)

      if (segments && !isGenerator(segments)) {
        issues.push({
          path: `${path}/reference`,
          code: 'PROJECT_REFERENCE',
          message: 'A sealed project key takes only ${{secret(N)}}.',
        })
      }
    }

    return {
      sealed: true,
      reference: raw.reference ?? null,
      value: null,
    }
  }

  if (raw.reference !== undefined) {
    issues.push({
      path: `${path}/reference`,
      code: 'PROJECT_REFERENCE',
      message: 'reference at project scope is only allowed with sealed: true.',
    })

    return null
  }

  const text = (value: string | number | boolean | undefined, at: string) => {
    if (value === undefined) {
      return null
    }

    const s = canonicalScalar(value)

    if (s.includes('${{')) {
      issues.push({
        path: at,
        code: 'PROJECT_REFERENCE',
        message: 'Values per production or preview are literals.',
      })
    }

    return s
  }

  return {
    sealed: false,
    reference: null,
    value: text(raw[valueTarget], `${path}/${valueTarget}`),
  }
}

const currentValue = (db: Db, keyring: Keyring, row: KeyRow, valueTarget: ValueTarget) => {
  const value = headValue(db, row.id, valueTarget, 'unset')

  return value
    ? {
        version: value.version,
        plaintext: decryptValue(keyring, value),
      }
    : null
}

export type PlanInput = {
  db: Db
  keyring: Keyring
  project: ProjectRow
  place: TargetRow
  doc: ManifestDoc
  prune: boolean
  allowUnresolved: boolean
  resolveRepo: RepoResolver
}

export type Plan = {
  set: ChangeSet
  unmanaged: Unmanaged[]
  warnings: Warning[]
  issues: Issue[]
}

const stationIssue = (path: string, message: string): Issue => ({
  path,
  code: 'SERVER_REQUIRED',
  message,
})

const deployableStations = new Set(['online', 'asleep'])

export const planManifest = async (input: PlanInput): Promise<Plan> => {
  const { db, keyring, project, place, doc } = input
  const where = placeName(place)
  const valueTarget: ValueTarget = place.kind
  const issues: Issue[] = []
  const warnings: Warning[] = []
  const unmanaged: Unmanaged[] = []
  const set = new ChangeSet()
  const zone = readSetting(db, 'domains.zone')

  if (doc.version !== 1) {
    issues.push({
      path: '/version',
      code: 'VERSION_UNSUPPORTED',
      message: `version ${doc.version} is not supported; use 1.`,
    })
  }

  if (doc.project !== project.name) {
    issues.push({
      path: '/project',
      code: 'PROJECT_MISMATCH',
      message: `The file is for project ${doc.project}, the request names ${project.name}.`,
    })
  }

  if (doc.shared) {
    issues.push({
      path: '/shared',
      code: 'PHASE_UNAVAILABLE',
      message: `shared ${phase1b}.`,
    })
  }

  for (const [previewName, override] of Object.entries(doc.previews ?? {})) {
    for (const name of Object.keys(override.apps ?? {})) {
      if (!doc.apps?.[name]) {
        issues.push({
          path: pointer(['previews', previewName, 'apps', name]),
          code: 'OVERRIDE_KEY',
          message: `The override names ${name}, which apps does not declare.`,
        })
      }
    }
  }

  const stations = db
    .select()
    .from(server)
    .all()
    .filter((s) => !s.revoked_at)
  const online = stations.filter((s) => s.status === 'online' && !s.draining)
  const existing = db.select().from(app).where(eq(app.target_id, place.id)).all()
  const existingByName = new Map(existing.map((s) => [s.name, s]))
  const declared = effectiveApps(doc, {
    kind: valueTarget,
    name: place.name,
  })
  const declaredNames = new Set(Object.keys(declared))

  type Prepared = {
    name: string
    doc: AppDoc
    row: AppRow | undefined
    stationId: string | null
    ports: PortDoc[]
    desired: Json
    volumes: string[] | null
    domains:
      | {
          identity: string
          hostname: string | null
          generated: boolean
          port: number
          path: string
        }[]
      | null
    keys: Map<string, DesiredKey | null> | null
  }
  const prepared: Prepared[] = []

  for (const [name, raw] of Object.entries(declared).sort(([a], [b]) => a.localeCompare(b))) {
    const at = (...rest: (string | number)[]) => pointer(['apps', name, ...rest])
    const svc = appWithDefaults(raw)
    const row = existingByName.get(name)
    const kind = svc.kind

    if (row && row.kind !== kind) {
      issues.push({
        path: at('kind'),
        code: 'KIND_IMMUTABLE',
        message: `${name} is a ${row.kind} app; kind cannot change. Delete and recreate it under a new name.`,
      })
    }

    if (svc.firewall) {
      issues.push({
        path: at('firewall'),
        code: 'PHASE_UNAVAILABLE',
        message: `firewall ${phase1b}.`,
      })
    }

    if (svc.gpu) {
      issues.push({
        path: at('gpu'),
        code: 'PHASE_UNAVAILABLE',
        message: 'gpu is phase 2 and not available on this instance.',
      })
    }

    if (svc.source.type === 'template') {
      issues.push({
        path: at('source', 'type'),
        code: 'PHASE_UNAVAILABLE',
        message: `template sources are phase 1b and not available on this instance.`,
      })
    }

    const ports = (svc.ports ?? []) as PortDoc[]

    if (kind === 'web' && ports.length === 0) {
      issues.push({
        path: at('ports'),
        code: 'KIND_PORTS',
        message: 'A web app needs at least one port.',
      })
    }

    if (kind !== 'web' && ports.length > 0) {
      issues.push({
        path: at('ports'),
        code: 'KIND_PORTS',
        message: `A ${kind} app has no ports.`,
      })
    }

    ports.forEach((p, i) => {
      if (ports.findIndex((o) => o.port === p.port) !== i) {
        issues.push({
          path: at('ports', i),
          code: 'DUPLICATE',
          message: `port ${p.port} appears twice.`,
        })
      }
    })
    const portSet = new Map(ports.map((p) => [p.port, p]))

    const health = normalizeHealth(kind, ports, raw.health)

    const undeclared = undeclaredHealthPort(health, ports)

    if (undeclared) {
      issues.push({
        path: at('health', svc.health?.port !== undefined ? 'port' : 'type'),
        code: 'PORT_UNDECLARED',
        message: undeclared,
      })
    }

    if (raw.health?.host !== undefined && health?.type !== 'http') {
      issues.push({
        path: at('health', 'host'),
        code: 'TYPE',
        message: `health.host applies only to an http check, not ${health?.type ?? 'none'}.`,
      })
    }

    if (
      health &&
      raw.health?.timeout_s !== undefined &&
      'interval_s' in health &&
      health.timeout_s > health.interval_s
    ) {
      issues.push({
        path: at('health', 'timeout_s'),
        code: 'RANGE',
        message: `timeout_s ${health.timeout_s} exceeds interval_s ${health.interval_s}.`,
      })
    }

    const volumes = svc.volumes ? svc.volumes.map((v) => v.mount_path) : null

    svc.volumes?.forEach((v, i) => {
      if (v.server_volume) {
        issues.push({
          path: at('volumes', i, 'server_volume'),
          code: 'PHASE_UNAVAILABLE',
          message: 'server_volume is phase 2.',
        })
      }

      if (v.mount_path === '/run/secrets' || v.mount_path.startsWith('/run/secrets/')) {
        issues.push({
          path: at('volumes', i, 'mount_path'),
          code: 'PATTERN',
          message: '/run/secrets is reserved for file-injected secrets.',
        })
      }

      if (volumes!.indexOf(v.mount_path) !== i) {
        issues.push({
          path: at('volumes', i),
          code: 'DUPLICATE',
          message: `mount_path ${v.mount_path} appears twice.`,
        })
      }
    })
    const volumeCount =
      volumes?.length ??
      (row
        ? db
            .select({
              id: volume.id,
            })
            .from(volume)
            .where(and(eq(volume.app_id, row.id), eq(volume.status, 'active')))
            .all().length
        : 0)

    if ((kind === 'cron' || kind === 'one_off') && svc.strategy) {
      issues.push({
        path: at('strategy'),
        code: 'STRATEGY_KIND',
        message: `strategy does not apply to ${kind} apps.`,
      })
    }

    const strategy = svc.strategy ?? (volumeCount > 0 ? 'replace' : 'overlap')

    if (strategy === 'overlap' && volumeCount > 0 && !svc.multi_writer_safe) {
      issues.push({
        path: at('strategy'),
        code: 'STRATEGY_VOLUME_CONFLICT',
        message:
          'overlap runs two containers at once with the same volume; use replace or set multi_writer_safe.',
      })
    }

    if (kind === 'cron' && !svc.schedule) {
      issues.push({
        path: at('schedule'),
        code: 'SCHEDULE_KIND',
        message: 'A cron app needs a schedule.',
      })
    }

    if (kind !== 'cron' && svc.schedule) {
      issues.push({
        path: at('schedule'),
        code: 'SCHEDULE_KIND',
        message: `A ${kind} app takes no schedule.`,
      })
    }

    const schedule = svc.schedule
      ? {
          cron: svc.schedule.cron,
          timezone: svc.schedule.timezone ?? 'UTC',
          concurrency: svc.schedule.concurrency ?? 'skip',
        }
      : null

    if (schedule) {
      try {
        if (schedule.cron.trim().split(/\s+/).length !== 5) {
          throw new Error('needs five fields')
        }

        new Intl.DateTimeFormat('en', {
          timeZone: schedule.timezone,
        })
        new Cron(schedule.cron, {
          timezone: schedule.timezone,
          paused: true,
        })
      } catch (error) {
        issues.push({
          path: at('schedule', 'cron'),
          code: 'CRON_INVALID',
          message: `${schedule.cron} in ${schedule.timezone}: ${(error as Error).message}`,
        })
      }
    }

    let stationId: string | null = null

    if (svc.server !== undefined) {
      const found = stations.find((s) => s.name === svc.server || s.id === svc.server)

      if (!found) {
        issues.push(stationIssue(at('server'), `No enrolled server is named ${svc.server}.`))
      } else {
        stationId = found.id
      }
    } else if (row) {
      stationId = row.server_id
    } else if (online.length === 1) {
      stationId = online[0]!.id
    } else {
      issues.push(
        stationIssue(at('server'), `${online.length} servers are online; name one with server.`),
      )
    }

    const st = stations.find((s) => s.id === stationId)
    const limits = {
      ...defaultLimits,
      ...svc.limits,
    }

    if (st?.resources) {
      if (limits.cpu_millis > st.resources.cpu_millis) {
        issues.push({
          path: at('limits', 'cpu_millis'),
          code: 'RANGE',
          message: `${limits.cpu_millis} exceeds the server's ${st.resources.cpu_millis} millicores.`,
        })
      }

      if (limits.memory_bytes > st.resources.memory_bytes) {
        issues.push({
          path: at('limits', 'memory_bytes'),
          code: 'RANGE',
          message: `${limits.memory_bytes} exceeds the server's ${st.resources.memory_bytes} bytes.`,
        })
      }
    }

    const domains = svc.domains
      ? svc.domains.map((d: DomainDoc, i) => {
          const path = at('domains', i)

          if ((d.generated === true) === (d.hostname !== undefined)) {
            issues.push({
              path,
              code: 'REQUIRED',
              message: 'Give exactly one of generated: true and hostname.',
            })
          }

          const httpPorts = ports.filter((p) => p.protocol === 'http')

          if (d.port === undefined && httpPorts.length > 1) {
            issues.push({
              path: `${path}/port`,
              code: 'REQUIRED',
              message: 'port is required when the app has several http ports.',
            })
          }

          const port = d.port ?? httpPorts[0]?.port ?? 0
          const declaredPort = portSet.get(port)

          if (!declaredPort) {
            issues.push({
              path: d.port !== undefined ? `${path}/port` : path,
              code: 'PORT_UNDECLARED',
              message: `port ${port || '(none)'} is not in ports.`,
            })
          } else if (declaredPort.protocol !== 'http') {
            issues.push({
              path: d.port !== undefined ? `${path}/port` : path,
              code: 'PORT_PROTOCOL',
              message: `port ${port} is tcp; a domain needs an http port.`,
            })
          }

          if (declaredPort?.grpc) {
            issues.push({
              path: d.port !== undefined ? `${path}/port` : path,
              code: 'PORT_PROTOCOL',
              message: `port ${port} is gRPC, which the Cloudflare Tunnel cannot carry to the public; reach it from another app over its .internal name.`,
            })
          }

          const deep = d.hostname && zone ? oneLabelProblem(d.hostname, zone) : null

          if (deep) {
            issues.push({
              path: `${path}/hostname`,
              code: 'DOMAIN_INVALID',
              message: `${deep}.`,
            })
          }

          return {
            identity: d.hostname ?? `generated:${port}`,
            hostname: d.hostname ?? null,
            generated: d.generated === true,
            port,
            path,
          }
        })
      : null

    domains?.forEach((d, i) => {
      if (domains.findIndex((o) => o.identity === d.identity) !== i) {
        issues.push({
          path: d.path,
          code: 'DUPLICATE',
          message: `${d.hostname ?? `a generated domain on port ${d.port}`} appears twice.`,
        })
      }
    })

    const keys = svc.keys
      ? new Map(
          Object.entries(svc.keys).map(([key, value]) => {
            const path = at('keys', key)

            if (key.startsWith('STATIONLY_')) {
              issues.push({
                path,
                code: 'RESERVED_KEY',
                message: 'Keys starting STATIONLY_ are reserved.',
              })
            }

            return [key, desiredAppKey(value, path, issues)]
          }),
        )
      : null

    for (const [key, desired] of keys ?? []) {
      if (!desired || desired.kind !== 'reference') {
        continue
      }

      for (const segment of parseValue(desired.reference)) {
        if (segment.type !== 'reference') {
          continue
        }

        const target = segment.target

        if (target.type === 'shared') {
          issues.push({
            path: at('keys', key),
            code: 'PHASE_UNAVAILABLE',
            message: `shared references ${phase1b}.`,
          })
        }

        if (target.type !== 'app') {
          continue
        }

        const known = declaredNames.has(target.app) || existingByName.has(target.app)

        if (known) {
          continue
        }

        const message = `${key} references ${target.app}.${target.key}, and no app ${target.app} exists in the Manifest or in ${where}.`

        if (input.allowUnresolved) {
          warnings.push({
            code: 'KEY_TARGET_MISSING',
            explanation: message,
            path: at('keys', key),
          })
        } else {
          issues.push({
            path: at('keys', key),
            code: 'KEY_TARGET_MISSING',
            message,
          })
        }
      }
    }

    const command = svc.command ?? null
    const desired: Json = {
      source: {
        ...svc.source,
      },
      server_id: stationId,
      command,
      build_args: svc.build_args && Object.keys(svc.build_args).length ? svc.build_args : null,
      limits,
      health,
      strategy,
      multi_writer_safe: svc.multi_writer_safe ?? false,
      drain_timeout_s: svc.drain_timeout_s ?? 30,
      readonly_rootfs: svc.readonly_rootfs ?? false,
      secrets_owner: svc.secrets_owner ?? null,
      pre_deploy: svc.pre_deploy ?? null,
      schedule,
      desired_state: svc.desired_state ?? 'running',
    }

    prepared.push({
      name,
      doc: svc,
      row,
      stationId,
      ports,
      desired,
      volumes,
      domains,
      keys,
    })
  }

  const projectKeys = doc.keys
    ? new Map(
        Object.entries(doc.keys).map(([key, value]) => {
          const path = pointer(['keys', key])

          if (key.startsWith('STATIONLY_')) {
            issues.push({
              path,
              code: 'RESERVED_KEY',
              message: 'Keys starting STATIONLY_ are reserved.',
            })
          }

          return [key, desiredProjectKey(value, valueTarget, path, issues)]
        }),
      )
    : null

  if (issues.length) {
    return {
      set,
      unmanaged,
      warnings,
      issues,
    }
  }

  await Promise.all(
    prepared.map(async (p) => {
      const source = p.desired.source as Json

      if (source.type !== 'image') {
        return
      }

      const path = pointer(['apps', p.name, 'source', 'ref'])
      const prior = p.row && p.row.server_id === p.stationId ? p.row.source : null
      const pinned = await pinImageSource(
        db,
        {
          type: 'image',
          ref: source.ref as string,
        },
        p.stationId,
        prior,
        path,
      ).catch((error) => {
        if (error instanceof ApiError) {
          throw new ApiError(error.code, error.message, error.fix, {
            ...error.details,
            path,
          })
        }

        throw error
      })

      p.desired.source = pinned.source

      if (pinned.resolution) {
        warnings.push({
          ...pinnedWarning(pinned.resolution),
          path,
        })
      }
    }),
  )

  for (const p of prepared) {
    const source = p.desired.source as Json

    if (source.type === 'dockerfile' || source.type === 'railpack') {
      const prior = p.row?.source

      try {
        const repo = source.repo as string
        const resolved = await input.resolveRepo(repo)

        source.auth = resolved.auth

        if (source.branch === undefined) {
          source.branch =
            prior && prior.repo === repo && typeof prior.branch === 'string'
              ? prior.branch
              : resolved.default_branch
        }

        if (resolved.auth === 'public') {
          warnings.push({
            code: 'SOURCE_POLLING',
            explanation: `${repo} is read anonymously; Dispatch polls ${source.branch as string} every github.poll_interval_s seconds and posts no commit statuses.`,
            path: pointer(['apps', p.name, 'source']),
          })
        }
      } catch (error) {
        if (error instanceof ApiError) {
          throw new ApiError(error.code, error.message, error.fix, {
            ...error.details,
            path: pointer(['apps', p.name, 'source', 'repo']),
          })
        }

        throw error
      }
    }
  }

  if (issues.length) {
    return {
      set,
      unmanaged,
      warnings,
      issues,
    }
  }

  const keyChanges = (
    appName: string,
    parent: string,
    existingRows: KeyRow[],
    desired: Map<string, DesiredKey | null>,
    appPath: string,
  ) => {
    const scope = 'app'
    let changed = false
    const rows = new Map(existingRows.map((r) => [r.name, r]))

    for (const [name, want] of [...desired].sort(([a], [b]) => a.localeCompare(b))) {
      if (!want) {
        continue
      }

      const prior = rows.get(name)

      if (prior?.kind === 'sealed' && want.kind !== 'sealed') {
        issues.push({
          path: `${appPath}/keys/${name}`,
          code: 'TYPE',
          message: `${name} is sealed; a sealed key cannot become ${want.kind}. Use another key.`,
        })
        continue
      }

      if (prior && prior.kind !== 'sealed' && want.kind === 'sealed') {
        issues.push({
          path: `${appPath}/keys/${name}`,
          code: 'TYPE',
          message: `${name} is ${prior.kind}; converting it to sealed is not possible. Use another key.`,
        })
        continue
      }

      const base = {
        scope,
        name,
        injection: want.injection,
        build: want.build,
        allow_unresolved: true,
      }

      if (want.kind === 'sealed') {
        if (!prior) {
          if (want.reference === null) {
            warnings.push({
              code: 'SEALED_VALUE_MISSING',
              explanation: `${name} is declared sealed and has no value in ${where}; set it with set_app_keys.`,
              path: `${appPath}/keys/${name}`,
            })
            continue
          }

          set.add('key', parent, {
            ...base,
            kind: 'sealed',
            reference: want.reference,
            value_length: null,
            version: 1,
          })
          changed = true
          continue
        }

        const referenceChanged = want.reference !== null && want.reference !== prior.reference

        if (!referenceChanged && prior.injection === want.injection && prior.build === want.build) {
          continue
        }

        set.update(
          'key',
          prior.id,
          '',
          {
            name,
            kind: prior.kind,
            reference: prior.reference,
            injection: prior.injection,
            build: prior.build,
          },
          {
            ...base,
            kind: 'sealed',
            reference: referenceChanged ? want.reference : null,
            value_length: null,
            version: referenceChanged ? nextValueVersion(db, prior.id, 'production') : null,
          },
        )
        changed = true
        continue
      }

      if (want.kind === 'literal') {
        const current =
          prior?.kind === 'literal' && prior.reference === null
            ? currentValue(db, keyring, prior, 'production')
            : null

        if (
          prior &&
          current &&
          current.plaintext === want.value &&
          prior.injection === want.injection &&
          prior.build === want.build
        ) {
          continue
        }

        const after = {
          ...base,
          kind: 'literal',
          reference: null,
          value_length: Buffer.byteLength(want.value, 'utf8'),
          version: prior ? nextValueVersion(db, prior.id, 'production') : 1,
          value_id: set.secret(escapeLiteral(want.value)),
        }

        if (prior) {
          set.update(
            'key',
            prior.id,
            '',
            {
              name,
              kind: prior.kind,
              reference: prior.reference,
              injection: prior.injection,
              build: prior.build,
            },
            after,
          )
        } else {
          set.add('key', parent, after)
        }

        changed = true
        continue
      }

      const kind = want.kind === 'literal-generator' ? 'literal' : 'reference'

      if (
        prior &&
        prior.kind === kind &&
        prior.reference === want.reference &&
        prior.injection === want.injection &&
        prior.build === want.build
      ) {
        continue
      }

      const after = {
        ...base,
        kind,
        reference: want.reference,
        value_length: null,
        version:
          kind === 'literal' ? (prior ? nextValueVersion(db, prior.id, 'production') : 1) : null,
      }

      if (prior) {
        set.update(
          'key',
          prior.id,
          '',
          {
            name,
            kind: prior.kind,
            reference: prior.reference,
            injection: prior.injection,
            build: prior.build,
          },
          after,
        )
      } else {
        set.add('key', parent, after)
      }

      changed = true
    }

    for (const row of existingRows) {
      if (desired.has(row.name)) {
        continue
      }

      if (input.prune) {
        set.remove('key', row.id, {
          name: row.name,
          kind: row.kind,
        })
        changed = true
      } else {
        unmanaged.push({
          entity: 'key',
          id: row.id,
          name: row.name,
          app: appName,
        })
      }
    }

    return changed
  }

  const stationReady = (stationId: string | null) => {
    const st = stations.find((s) => s.id === stationId)

    return (
      !!st && deployableStations.has(st.status) && !st.draining && st.version_skew !== 'unsupported'
    )
  }

  for (const p of prepared) {
    const appPath = pointer(['apps', p.name])
    const desired = p.desired

    if (!p.row) {
      const { desired_state, ...rest } = desired
      const ref = set.add('app', place.id, {
        name: p.name,
        kind: p.doc.kind,
        ...rest,
        desired_state,
      })
      const portRefs = new Map<number, string>()

      for (const port of p.ports) {
        portRefs.set(
          port.port,
          set.add('app_port', ref, {
            port: port.port,
            protocol: port.protocol,
            grpc: port.grpc,
          }),
        )
      }

      for (const mount of p.volumes ?? []) {
        set.add('volume', ref, {
          mount_path: mount,
        })
      }

      for (const d of p.domains ?? []) {
        const hostname = d.hostname ?? generatedHostname(db, p.name, place.name)

        if (!hostname) {
          issues.push({
            path: d.path,
            code: 'PORT_UNDECLARED',
            message: 'No domains.zone is set, so no hostname can be generated.',
          })
          continue
        }

        requireGatewayPin(db, p.stationId!)
        set.add('domain', portRefs.get(d.port)!, {
          hostname,
          kind: d.generated ? 'generated' : 'custom',
        })
      }

      if (p.keys) {
        keyChanges(p.name, ref, [], p.keys, appPath)
      }

      const source = desired.source as Json

      if (desired_state === 'running' && source.type !== 'local' && stationReady(p.stationId)) {
        set.deploy(ref, 'manual')
      }

      continue
    }

    const row = p.row
    let deployReason: string[] = []
    let sourceChanged = false

    for (const [field, value] of Object.entries(desired)) {
      const current = (row as Json)[field] ?? null

      if (field === 'source') {
        const merged = {
          ...(current as Json),
        }
        const next = {
          ...(value as Json),
        }

        if (!sameJson(merged, next)) {
          leafDiff(set, 'app', row.id, '/source', merged, next)
          sourceChanged = true
          deployReason.push('/source')
        }

        continue
      }

      if (sameJson(current, value)) {
        continue
      }

      if (
        field === 'health' ||
        field === 'limits' ||
        field === 'schedule' ||
        field === 'secrets_owner'
      ) {
        if (current === null || value === null) {
          set.update('app', row.id, `/${field}`, current, value)
        } else {
          leafDiff(set, 'app', row.id, `/${field}`, current, value)
        }
      } else {
        set.update('app', row.id, `/${field}`, current, value)
      }

      if (field !== 'desired_state') {
        deployReason.push(`/${field}`)
      }
    }

    const currentPorts = db.select().from(app_port).where(eq(app_port.app_id, row.id)).all()
    let structural = false
    const portIds = new Map<number, string>()
    const protocolChanges: {
      id: string
      port: number
      before: 'http' | 'tcp'
      after: 'http' | 'tcp'
      path: string
    }[] = []

    for (const cp of currentPorts) {
      const index = p.ports.findIndex((x) => x.port === cp.port)
      const want = p.ports[index]

      if (want) {
        portIds.set(cp.port, cp.id)

        if (want.protocol !== cp.protocol) {
          protocolChanges.push({
            id: cp.id,
            port: cp.port,
            before: cp.protocol,
            after: want.protocol,
            path: pointer(['apps', p.name, 'ports', index, 'protocol']),
          })
          deployReason.push(`/ports/${cp.port}/protocol`)
        }

        if (want.grpc !== cp.grpc) {
          set.update('app_port', cp.id, '/grpc', cp.grpc, want.grpc)
          deployReason.push(`/ports/${cp.port}/grpc`)
        }

        continue
      }

      if (input.prune) {
        set.remove('app_port', cp.id, {
          port: cp.port,
          protocol: cp.protocol,
        })
        structural = true
      } else {
        unmanaged.push({
          entity: 'app_port',
          id: cp.id,
          app: p.name,
          port: cp.port,
        })
        portIds.set(cp.port, cp.id)
      }
    }

    for (const want of p.ports) {
      if (portIds.has(want.port)) {
        continue
      }

      portIds.set(
        want.port,
        set.add('app_port', row.id, {
          port: want.port,
          protocol: want.protocol,
          grpc: want.grpc,
        }),
      )
      structural = true
    }

    if (p.volumes) {
      const current = db
        .select()
        .from(volume)
        .where(and(eq(volume.app_id, row.id), eq(volume.status, 'active')))
        .all()

      for (const vol of current) {
        if (p.volumes.includes(vol.mount_path)) {
          continue
        }

        if (!input.prune) {
          unmanaged.push({
            entity: 'volume',
            id: vol.id,
            app: p.name,
            mount_path: vol.mount_path,
          })
          continue
        }

        set.update('volume', vol.id, '/status', vol.status, 'retained')
        set.update(
          'volume',
          vol.id,
          '/retain_until',
          null,
          new Date(Date.now() + (isTransient(place) ? 24 : 7 * 24) * 3600 * 1000).toISOString(),
        )
        set.update('volume', vol.id, '/app_id', row.id, null)
        structural = true
      }

      for (const mount of p.volumes) {
        if (current.some((v) => v.mount_path === mount)) {
          continue
        }

        set.add('volume', row.id, {
          mount_path: mount,
        })
        structural = true
      }
    }

    const ids = currentPorts.map((cp) => cp.id)
    const removedDomains = new Set<string>()

    if (p.domains) {
      const current = ids.length
        ? db.select().from(domain).where(inArray(domain.app_port_id, ids)).all()
        : []
      const portOf = new Map(currentPorts.map((cp) => [cp.id, cp.port]))
      const identity = (d: (typeof current)[number]) =>
        d.kind === 'generated' ? `generated:${portOf.get(d.app_port_id)}` : d.hostname

      for (const d of current) {
        const want = p.domains.find((w) => w.identity === identity(d))

        if (want) {
          continue
        }

        if (input.prune) {
          set.remove('domain', d.id, {
            hostname: d.hostname,
          })
          removedDomains.add(d.id)
        } else {
          unmanaged.push({
            entity: 'domain',
            id: d.id,
            app: p.name,
            hostname: d.hostname,
          })
        }
      }

      for (const want of p.domains) {
        const have = current.find((d) => identity(d) === want.identity)

        if (have) {
          continue
        }

        const hostname = want.hostname ?? generatedHostname(db, p.name, place.name)

        if (!hostname) {
          issues.push({
            path: want.path,
            code: 'PORT_UNDECLARED',
            message: 'No domains.zone is set, so no hostname can be generated.',
          })
          continue
        }

        requireGatewayPin(db, p.stationId!)
        set.add('domain', portIds.get(want.port)!, {
          hostname,
          kind: want.generated ? 'generated' : 'custom',
        })
      }
    }

    for (const change of protocolChanges) {
      const remaining =
        change.after === 'tcp'
          ? db
              .select({
                id: domain.id,
                hostname: domain.hostname,
              })
              .from(domain)
              .where(eq(domain.app_port_id, change.id))
              .all()
              .filter((d) => !removedDomains.has(d.id))
          : []

      if (remaining.length) {
        issues.push({
          path: change.path,
          code: 'PORT_PROTOCOL',
          message: `port ${change.port} cannot become tcp while domain ${remaining.map((r) => r.hostname).join(', ')} routes to it; drop the domain from domains and apply with prune.`,
        })
        continue
      }

      set.update('app_port', change.id, '/protocol', change.before, change.after)
    }

    let keysChanged = false

    if (p.keys) {
      const rows = keysOf(db, {
        scope: 'app',
        id: row.id,
      }).all()

      keysChanged = keyChanges(p.name, row.id, rows, p.keys, appPath)
    }

    const running = ((desired.desired_state as string) ?? row.desired_state) === 'running'
    const source = desired.source as Json
    const trigger = configDeployTrigger(
      row,
      source,
      sourceChanged,
      deployReason.length || structural ? 'redeploy' : 'key_change',
    )

    if (
      trigger &&
      running &&
      stationReady(p.stationId) &&
      (structural || deployReason.length || keysChanged)
    ) {
      const reasons = [
        ...deployReason,
        ...(structural ? ['ports or volumes changed'] : []),
        ...(keysChanged ? ['keys changed'] : []),
      ]

      set.deploy(row.id, trigger, {
        reason: reasons.join(', '),
      })
    }

    deployReason = []
  }

  if (doc.apps) {
    for (const row of existing) {
      if (declaredNames.has(row.name)) {
        continue
      }

      if (!input.prune) {
        unmanaged.push({
          entity: 'app',
          id: row.id,
          name: row.name,
        })
        continue
      }

      set.remove('app', row.id, {
        name: row.name,
        kind: row.kind,
      })
    }
  }

  if (projectKeys) {
    const rows = keysOf(db, {
      scope: 'project',
      id: project.id,
    }).all()
    const byName = new Map(rows.map((r) => [r.name, r]))

    for (const [name, want] of [...projectKeys].sort(([a], [b]) => a.localeCompare(b))) {
      if (!want) {
        continue
      }

      const prior = byName.get(name)
      const path = pointer(['keys', name])

      if (prior?.kind === 'sealed' && !want.sealed) {
        issues.push({
          path,
          code: 'TYPE',
          message: `${name} is sealed; it cannot become a literal. Use another key.`,
        })
        continue
      }

      if (prior && prior.kind !== 'sealed' && want.sealed) {
        issues.push({
          path,
          code: 'TYPE',
          message: `${name} is ${prior.kind}; converting it to sealed is not possible. Use another key.`,
        })
        continue
      }

      let targetRef: string | null = prior?.id ?? null
      const write = (
        writeTarget: ValueTarget,
        plaintext: string | null,
        reference: string | null,
      ) => {
        const after: Json = {
          scope: 'project',
          name,
          kind: want.sealed ? 'sealed' : 'literal',
          reference,
          injection: prior?.injection ?? 'env',
          build: prior?.build ?? false,
          value_length: plaintext === null ? null : Buffer.byteLength(plaintext, 'utf8'),
          version:
            targetRef && !targetRef.startsWith('new:')
              ? nextValueVersion(db, targetRef, writeTarget)
              : 1,
          allow_unresolved: true,
          target: writeTarget,
          ...(plaintext === null
            ? {}
            : {
                value_id: set.secret(escapeLiteral(plaintext)),
              }),
        }

        if (targetRef) {
          set.update(
            'key',
            targetRef,
            '',
            prior
              ? {
                  name,
                  kind: prior.kind,
                  reference: prior.reference,
                }
              : {
                  name,
                },
            after,
          )
        } else {
          targetRef = set.add('key', project.id, after)
        }
      }

      if (want.sealed) {
        const hasValue = prior ? headValue(db, prior.id, valueTarget, 'unset') : null

        if (hasValue && (!want.reference || prior!.reference === want.reference)) {
          continue
        }

        if (want.reference) {
          write(valueTarget, null, want.reference)
        } else {
          warnings.push({
            code: 'SEALED_VALUE_MISSING',
            explanation: `${name} is declared sealed and has no value in ${where}; set it with set_project_keys.`,
            path,
          })
        }

        continue
      }

      if (want.reference) {
        if (prior && prior.reference === want.reference && headValue(db, prior.id, valueTarget)) {
          continue
        }

        write(valueTarget, null, want.reference)
        continue
      }

      const desired = want.value

      if (desired !== null) {
        const current = prior ? currentValue(db, keyring, prior, valueTarget) : null

        if (!current || current.plaintext !== desired || prior?.reference) {
          write(valueTarget, desired, null)
        }
      }
    }

    for (const row of rows) {
      if (projectKeys.has(row.name)) {
        continue
      }

      if (input.prune) {
        set.remove('key', row.id, {
          name: row.name,
          kind: row.kind,
        })
      } else {
        unmanaged.push({
          entity: 'key',
          id: row.id,
          name: row.name,
        })
      }
    }
  }

  return {
    set,
    unmanaged,
    warnings,
    issues,
  }
}

export const changeLevel = (change: Change): Level => {
  if (change.entity === 'deployment') {
    return 'deploy'
  }

  if (change.entity === 'app' && change.op !== 'update') {
    return 'admin'
  }

  if (change.entity === 'app' && change.op === 'update' && change.path === '/server_id') {
    return 'admin'
  }

  if (change.entity === 'domain') {
    return 'admin'
  }

  if (change.entity === 'volume' && change.op === 'update') {
    return 'admin'
  }

  if (change.entity === 'key') {
    const after = (change.op === 'remove' ? change.before : change.after) as Json

    if (after?.scope === 'project' || after?.kind === 'sealed') {
      return 'admin'
    }

    if (change.op === 'remove' && change.before.kind === 'sealed') {
      return 'admin'
    }
  }

  return 'deploy'
}

export const requireDiffLevel = (principal: Principal, target: Target, changes: Change[]) => {
  changes.forEach((change, index) => {
    const level = changeLevel(change)

    if (can(principal, target, level)) {
      return
    }

    fail(
      'FORBIDDEN_SCOPE',
      `Entry ${index} of the diff (${change.op} ${change.entity}) needs ${level}.`,
      `Create a token with ${level} on this production or these previews, or ask the admin to apply the Manifest.`,
      {
        required: {
          ...target,
          level,
        },
        entry: index,
        op: change.op,
        entity: change.entity,
      },
    )
  })
}
