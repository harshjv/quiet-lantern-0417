import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type Database from 'better-sqlite3'
import { and, asc, desc, eq, isNull } from 'drizzle-orm'

import type { LockfileDoc, ReleaseManifestDoc } from '@stationly/protocol'

import type { Db } from '../db/client.ts'
import {
  component,
  platform_release,
  platform_upgrade,
  station,
  type UpgradePin,
  type UpgradeStep,
} from '../db/schema.ts'
import { writeSetting } from '../db/settings.ts'
import type { Log } from '../log.ts'
import { every, runNow } from '../schedule.ts'
import { emitEvent } from '../station/events.ts'

import { resolvePins, type Pins } from './lockfile.ts'

type Row = typeof platform_upgrade.$inferSelect
type Actor = Row['actor']
type ErrorValue = NonNullable<UpgradeStep['failure']>

const unlisted = new Set(['docker_engine', 'grype_db'])
const activeStatuses = new Set<Row['status']>(['running', 'reverting', 'failed'])
const toStatuses = new Set<UpgradeStep['status']>(['running', 'done', 'revert_failed'])

export const stepTimeoutMs: Record<string, number> = {
  stationd: 150_000,
  dispatch: 240_000,
  gateway: 360_000,
  depot: 360_000,
  buildkit: 1_800_000,
}
const defaultTimeoutMs = 240_000

export const procedureNotes: Record<string, string> = {
  stationd:
    'handover of the DNS sockets to the new process (MAINPID); containers, nftables and routes untouched; zero downtime',
  dispatch:
    'stop the old container, start the new one after a pre-upgrade backup; API and dashboard unavailable for under 5 s; workloads unaffected',
  gateway:
    'blue/green swap between the two Gateway Couplers with the probe route, port_switch replacement and two conntrack passes; zero downtime',
  depot:
    'maintenance window: builds queue, Depot restarts read-only then writable; pulls fail briefly across the two restarts; running services unaffected',
  buildkit:
    'each project Workshop restarts when no build runs for it; queued builds wait; cache volumes kept',
  coupler_image:
    'pull and verify; each service uses it at its next deployment; running Couplers are never replaced',
  railpack_frontend: 'pull and verify; the next Railpack build uses it',
  syft_scanner: 'pull and verify; the next build attestation uses it',
  litestream: 'sidecar restart, present only with a bucket; Dispatch keeps running',
  cloudflared: 'phase 1b; pin recorded',
  guard_image: 'phase 1b; pin recorded',
  grype: 'phase 1b; pin recorded',
  syft: 'phase 1b; pin recorded',
  presets: 'phase 1b; pin recorded',
}

const now = () => new Date().toISOString()

const pinOf = (pins: Pins, name: string): UpgradePin | null =>
  pins[name]
    ? {
        version: pins[name].version,
        digest: pins[name].digest,
      }
    : null

const samePin = (a: UpgradePin | null, b: UpgradePin | null) =>
  a?.version === b?.version && a?.digest === b?.digest

export const latestUpgrade = (db: Db) =>
  db
    .select()
    .from(platform_upgrade)
    .orderBy(desc(platform_upgrade.created_at), desc(platform_upgrade.id))
    .limit(1)
    .get() ?? null

export const activeUpgrade = (db: Db) => {
  const row = latestUpgrade(db)

  return row && activeStatuses.has(row.status) ? row : null
}

const manifestFor = (db: Db, lockfile: LockfileDoc) =>
  db
    .select()
    .from(platform_release)
    .where(eq(platform_release.manifest_digest, lockfile.manifest_digest))
    .get()?.manifest ?? null

const dispatchStation = (db: Db) =>
  db
    .select({
      id: station.id,
    })
    .from(station)
    .where(eq(station.hosts_dispatch, true))
    .orderBy(asc(station.created_at))
    .get()?.id ?? null

export const overlayPins = (db: Db, stationId: string, base: Pins): Pins => {
  const row = activeUpgrade(db)

  if (!row) {
    return base
  }

  const out: Pins = {
    ...base,
  }

  for (const step of row.steps) {
    if (step.station_id !== stationId) {
      continue
    }

    const pin = toStatuses.has(step.status) ? step.to : step.from
    const prev = out[step.component]

    out[step.component] = {
      version: pin.version,
      digest: pin.digest,
      source: prev?.source ?? null,
      kind: prev?.kind ?? null,
      origin: prev?.origin ?? 'release',
    }
  }

  return out
}

export const generationLockfile = (db: Db, current: unknown) => {
  const row = activeUpgrade(db)

  return row ? row.lockfile_before : current
}

const orderOf = (manifest: ReleaseManifestDoc | null, names: Set<string>) => {
  const listed = Object.keys(manifest?.components ?? {})
  const rest = [...names].filter((n) => !listed.includes(n)).sort()

  return [...listed, ...rest].filter((n) => names.has(n))
}

export type UpgradePlan = { steps: UpgradeStep[]; removedOverrides: string[] }

export const planUpgrade = (
  db: Db,
  before: LockfileDoc,
  after: LockfileDoc,
  stationFilter: string | null,
): UpgradePlan => {
  const beforeManifest = manifestFor(db, before)
  const afterManifest = manifestFor(db, after)
  const stations = db
    .select({
      id: station.id,
      arch: station.arch,
      hosts_dispatch: station.hosts_dispatch,
    })
    .from(station)
    .where(isNull(station.revoked_at))
    .orderBy(asc(station.created_at))
    .all()
    .filter((s) => !stationFilter || s.id === stationFilter)
  const hostId = dispatchStation(db)
  const current = activeUpgrade(db)
  const stepsFirst: UpgradeStep[] = []
  const stepsRest: UpgradeStep[] = []
  let dispatchStep: UpgradeStep | null = null

  for (const st of stations) {
    const from = resolvePins(beforeManifest, before, st.arch)
    const fromRunning = current ? overlayPins(db, st.id, from) : from
    const to = resolvePins(afterManifest, after, st.arch)
    const names = new Set(
      [...Object.keys(fromRunning), ...Object.keys(to)].filter((n) => !unlisted.has(n)),
    )

    for (const name of orderOf(afterManifest ?? beforeManifest, names)) {
      const a = pinOf(fromRunning, name)
      const b = pinOf(to, name)

      if (!b || samePin(a, b)) {
        continue
      }

      if (name === 'dispatch' && st.id !== hostId) {
        continue
      }

      const step: UpgradeStep = {
        component: name,
        station_id: st.id,
        from: a ?? {
          version: 'none',
          digest: null,
        },
        to: b,
        status: 'pending',
        started_at: null,
        finished_at: null,
        failure: null,
        detail: null,
      }

      if (name === 'stationd') {
        stepsFirst.push(step)
      } else if (name === 'dispatch') {
        dispatchStep = step
      } else {
        stepsRest.push(step)
      }
    }
  }

  const removedOverrides = Object.keys(before.overrides ?? {}).filter(
    (n) => !(n in (after.overrides ?? {})),
  )

  return {
    steps: [...stepsFirst, ...stepsRest, ...(dispatchStep ? [dispatchStep] : [])],
    removedOverrides,
  }
}

const componentsPayload = (row: { steps: UpgradeStep[] }) =>
  row.steps.map((s) => ({
    component: s.component,
    station: s.station_id,
    from: s.from,
    to: s.to,
    status: s.status,
  }))

export const startUpgrade = (
  db: Db,
  input: {
    stagedChangeId: string | null
    actor: Actor
    before: LockfileDoc
    after: LockfileDoc
    station: string | null
  },
) => {
  const plan = planUpgrade(db, input.before, input.after, input.station)
  const id = db
    .insert(platform_upgrade)
    .values({
      staged_change_id: input.stagedChangeId,
      station_id: input.station,
      release_from: input.before.release,
      release_to: input.after.release,
      lockfile_before: input.before,
      lockfile_after: input.after,
      steps: plan.steps,
      status: plan.steps.length ? 'running' : 'done',
      actor: input.actor,
      finished_at: plan.steps.length ? null : new Date(),
    })
    .returning({
      id: platform_upgrade.id,
    })
    .get().id
  const payload = {
    staged_change: input.stagedChangeId,
    release: {
      from: input.before.release,
      to: input.after.release,
    },
    components: componentsPayload(plan),
    removed_overrides: plan.removedOverrides,
    station: input.station,
    result: null,
  }

  emitEvent(
    db,
    'platform.upgrade_started',
    {
      entity: 'platform_upgrade',
      id,
    },
    payload,
  )

  if (!plan.steps.length) {
    emitEvent(
      db,
      'platform.upgrade_done',
      {
        entity: 'platform_upgrade',
        id,
      },
      {
        ...payload,
        result: 'done',
      },
    )
  }

  return id
}

const save = (db: Db, row: Row, patch: Partial<Row> = {}) => {
  db.update(platform_upgrade)
    .set({
      steps: row.steps,
      status: row.status,
      failure: row.failure,
      backup: row.backup,
      finished_at: row.finished_at,
      ...patch,
    })
    .where(eq(platform_upgrade.id, row.id))
    .run()
}

const finish = (db: Db, row: Row, result: 'done' | 'failed' | 'reverted') => {
  row.status = result
  row.finished_at = new Date()

  if (result === 'reverted') {
    writeSetting(db, 'platform.lockfile', row.lockfile_before, {
      type: 'system',
      id: null,
      client: 'platform-upgrade-revert',
    })
    syncComponentLockfile(db, row.lockfile_before as unknown as LockfileDoc)
  }

  save(db, row)
  emitEvent(
    db,
    'platform.upgrade_done',
    {
      entity: 'platform_upgrade',
      id: row.id,
    },
    {
      staged_change: row.staged_change_id,
      release: {
        from: row.release_from,
        to: row.release_to,
      },
      components: componentsPayload(row),
      station: row.station_id,
      result,
      failure: row.failure,
    },
  )
}

const syncComponentLockfile = (db: Db, lockfile: LockfileDoc) => {
  const manifest = manifestFor(db, lockfile)

  for (const st of db
    .select({
      id: station.id,
      arch: station.arch,
    })
    .from(station)
    .all()) {
    const pins = resolvePins(manifest, lockfile, st.arch)

    for (const [name, pin] of Object.entries(pins)) {
      db.update(component)
        .set({
          lockfile_version: pin.version,
          lockfile_digest: pin.digest,
        })
        .where(
          and(
            eq(component.name, name as (typeof component.$inferSelect)['name']),
            name === 'dispatch' ? isNull(component.station_id) : eq(component.station_id, st.id),
          ),
        )
        .run()
    }
  }
}

export type Advance = { reconcile: Set<string>; backup: { row: string; version: string } | null }

export const advanceUpgrade = (db: Db, dispatchVersion: string): Advance => {
  const out: Advance = {
    reconcile: new Set(),
    backup: null,
  }
  const row = activeUpgrade(db)

  if (!row || row.status === 'failed') {
    return out
  }

  const at = Date.now()

  for (const step of row.steps) {
    if (
      (step.status === 'running' || step.status === 'reverting') &&
      step.started_at &&
      at - Date.parse(step.started_at) > (stepTimeoutMs[step.component] ?? defaultTimeoutMs)
    ) {
      const failure: ErrorValue = {
        code: 'UPGRADE_FAILED',
        explanation: `${step.component} on ${step.station_id} did not report ${step.status === 'running' ? step.to.version : step.from.version} within ${Math.round((stepTimeoutMs[step.component] ?? defaultTimeoutMs) / 1000)} s`,
        fix: 'Read the stationd log on the station; the upgrade reverts the components already moved.',
        details: {},
      }

      markFailed(db, row, step, failure, out)

      return out
    }
  }

  if (row.status === 'running') {
    if (row.steps.some((s) => s.status === 'running')) {
      return out
    }

    const next = row.steps.find((s) => s.status === 'pending')

    if (!next) {
      finish(db, row, 'done')

      for (const s of row.steps) {
        if (s.station_id) {
          out.reconcile.add(s.station_id)
        }
      }

      return out
    }

    if (next.component === 'dispatch' && !row.backup) {
      out.backup = {
        row: row.id,
        version: dispatchVersion,
      }

      return out
    }

    next.status = 'running'
    next.started_at = now()
    save(db, row)

    if (next.station_id) {
      out.reconcile.add(next.station_id)
    }

    return out
  }

  if (row.steps.some((s) => s.status === 'reverting')) {
    return out
  }

  const back = [...row.steps].reverse().find((s) => s.status === 'done')

  if (!back) {
    finish(db, row, 'reverted')

    for (const s of row.steps) {
      if (s.station_id) {
        out.reconcile.add(s.station_id)
      }
    }

    return out
  }

  back.status = 'reverting'
  back.started_at = now()
  save(db, row)

  if (back.station_id) {
    out.reconcile.add(back.station_id)
  }

  return out
}

const markFailed = (db: Db, row: Row, step: UpgradeStep, failure: ErrorValue, out: Advance) => {
  step.finished_at = now()
  step.failure = failure

  if (step.status === 'reverting') {
    step.status = 'revert_failed'
    row.failure = failure
    finish(db, row, 'failed')

    return
  }

  step.status = 'failed'
  row.status = 'reverting'
  row.failure = failure
  save(db, row)

  if (step.station_id) {
    out.reconcile.add(step.station_id)
  }
}

type ComponentReport = {
  name: string
  version: string
  digest: string | null
  status: string
  failure: unknown
}

export const upgradeOnComponent = (db: Db, stationId: string, body: ComponentReport) => {
  const row = activeUpgrade(db)

  if (!row || row.status === 'failed') {
    return false
  }

  const step = row.steps.find(
    (s) =>
      s.component === body.name &&
      s.station_id === stationId &&
      (s.status === 'running' || s.status === 'reverting'),
  )

  if (!step) {
    return false
  }

  const target = step.status === 'running' ? step.to : step.from
  const matches =
    body.version === target.version && (target.digest === null || body.digest === target.digest)

  if (body.status === 'ok' && matches) {
    const from = step.status === 'running' ? step.from : step.to

    step.status = step.status === 'running' ? 'done' : 'reverted'
    step.finished_at = now()
    save(db, row)
    emitEvent(
      db,
      'component.upgraded',
      {
        entity: 'component',
        id: body.name,
        station_id: stationId,
      },
      {
        component: body.name,
        from,
        to: target,
        station: stationId,
        upgrade: row.id,
        revert: step.status === 'reverted',
      },
    )

    return true
  }

  if (body.status === 'failed' && step.status === 'running') {
    const failure = (body.failure as ErrorValue | null) ?? {
      code: 'UPGRADE_FAILED',
      explanation: `${body.name} reported failed`,
      fix: 'Read the stationd log.',
      details: {},
    }
    const out: Advance = {
      reconcile: new Set(),
      backup: null,
    }

    markFailed(db, row, step, failure, out)

    return true
  }

  if (body.status === 'failed' && step.status === 'reverting' && !matches) {
    markFailed(
      db,
      row,
      step,
      (body.failure as ErrorValue | null) ?? {
        code: 'UPGRADE_FAILED',
        explanation: `${body.name} failed to return to ${target.version}`,
        fix: 'Read the stationd log.',
        details: {},
      },
      {
        reconcile: new Set(),
        backup: null,
      },
    )

    return true
  }

  return false
}

export const writeBackup = async (db: Db, databasePath: string, rowId: string, version: string) => {
  const dir = join(dirname(databasePath), 'backups')

  mkdirSync(dir, {
    recursive: true,
  })
  const path = join(
    dir,
    `pre-upgrade-${version}-${new Date().toISOString().replace(/[-:.]/g, '')}.sqlite`,
  )
  const started = Date.now()

  await (db as unknown as { $client: Database.Database }).$client.backup(path)
  db.update(platform_upgrade)
    .set({
      backup: path,
    })
    .where(eq(platform_upgrade.id, rowId))
    .run()

  return {
    path,
    took_ms: Date.now() - started,
  }
}

export const createUpgradeDriver = (deps: {
  db: Db
  databasePath: string
  version: string
  reconcile: (stationId?: string) => void
  log: Log
}) => {
  const { db, log } = deps
  const advance = async () => {
    for (let i = 0; i < 64; i++) {
      const step = advanceUpgrade(db, deps.version)

      for (const id of step.reconcile) {
        deps.reconcile(id)
      }

      if (step.backup) {
        const res = await writeBackup(db, deps.databasePath, step.backup.row, step.backup.version)

        log('platform_upgrade.backup', {
          upgrade: step.backup.row,
          ...res,
        })
        continue
      }

      if (!step.reconcile.size) {
        break
      }
    }
  }
  const job = every(2, 'platform_upgrade.advance_failed', log, advance)

  return {
    kick: () => runNow(job),
    stop: () => job.stop(),
  }
}

export const upgradeDoctorRow = (db: Db) => {
  const row = latestUpgrade(db)

  if (!row) {
    return {
      name: 'platform_upgrade',
      status: 'ok' as const,
      finding: 'no platform upgrade recorded',
      fix: null,
      code: null,
    }
  }

  const moved = row.steps
    .filter((s) => toStatuses.has(s.status))
    .map((s) => `${s.component} ${s.to.version}`)
  const back = row.steps
    .filter((s) => !toStatuses.has(s.status))
    .map((s) => `${s.component} ${s.from.version}`)
  const current = row.steps.find((s) => s.status === 'running' || s.status === 'reverting')
  const head = `upgrade ${row.id} ${row.release_from} -> ${row.release_to}`

  switch (row.status) {
    case 'done':
      return {
        name: 'platform_upgrade',
        status: 'ok' as const,
        finding: `${head} done at ${row.finished_at?.toISOString()} (${row.steps.length} component(s))`,
        fix: null,
        code: null,
      }
    case 'reverted':
      return {
        name: 'platform_upgrade',
        status: 'warn' as const,
        finding: `${head} reverted at ${row.finished_at?.toISOString()}: ${row.failure?.explanation ?? 'a procedure failed'}; every moved component is back on ${row.release_from}`,
        fix: `Read the failure, then sly platform upgrade --version ${row.release_to} again or stay on ${row.release_from}.`,
        code: 'upgrade_reverted',
      }
    case 'running':
    case 'reverting':
      return {
        name: 'platform_upgrade',
        status: 'warn' as const,
        finding: `${head} ${row.status}: ${current ? `${current.component} ${current.status}` : 'between steps'}; half-applied: on ${row.release_to}: [${moved.join(', ')}], on ${row.release_from}: [${back.join(', ')}]`,
        fix:
          row.status === 'running'
            ? `Wait for platform.upgrade_done, or sly platform upgrade --version ${row.release_from} after it ends.`
            : 'Wait for the revert to finish.',
        code: row.status === 'running' ? 'upgrade_in_progress' : 'upgrade_reverting',
      }
    case 'failed':
      return {
        name: 'platform_upgrade',
        status: 'fail' as const,
        finding: `${head} failed and could not revert: ${row.failure?.explanation ?? ''}; half-applied: on ${row.release_to}: [${moved.join(', ')}], on ${row.release_from}: [${back.join(', ')}]`,
        fix: `sly platform upgrade --version ${row.release_from} to roll back, or --version ${row.release_to} to retry`,
        code: 'upgrade_half_applied',
      }
  }
}
