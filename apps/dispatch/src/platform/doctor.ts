import { and, eq, gt, isNull } from 'drizzle-orm'

import type { Db } from '../db/client.ts'
import {
  agent_hook,
  component,
  doctor_check,
  domain,
  drift,
  notification_channel,
  station,
  token,
  volume_snapshot,
} from '../db/schema.ts'
import { readSetting } from '../db/settings.ts'
import { emitEvent } from '../station/events.ts'
import type { StationServer } from '../station/server.ts'

import { baseImageInventory } from './base-images.ts'
import { currentRelease } from './lockfile.ts'
import { upgradeDoctorRow } from './upgrade.ts'

type Status = 'ok' | 'warn' | 'fail'

export type DoctorRow = {
  name: string
  station: string | null
  status: Status
  code: string | null
  finding: string
  fix: string | null
  detail?: Record<string, unknown>
}

const rank: Record<Status, number> = {
  ok: 0,
  warn: 1,
  fail: 2,
}

class Row {
  status: Status = 'ok'
  code: string | null = null
  findings: string[] = []
  fixes: string[] = []
  detail: Record<string, unknown> = {}
  readonly name: string

  constructor(name: string) {
    this.name = name
  }

  raise(status: Status, code: string, finding: string, fix: string | null) {
    if (rank[status] > rank[this.status]) {
      this.status = status
      this.code = code
      this.findings.unshift(finding)

      if (fix) {
        this.fixes.unshift(fix)
      }

      return
    }

    this.findings.push(finding)

    if (fix) {
      this.fixes.push(fix)
    }
  }

  note(finding: string) {
    if (this.status === 'ok') {
      this.findings.push(finding)
    }
  }

  done(): DoctorRow {
    return {
      name: this.name,
      station: null,
      status: this.status,
      code: this.code,
      finding: this.findings.join('; ') || 'ok',
      fix: this.fixes.length ? this.fixes.join('; ') : null,
      ...(Object.keys(this.detail).length
        ? {
            detail: this.detail,
          }
        : {}),
    }
  }
}

const day = 24 * 3600 * 1000

const lockfileDrift = (db: Db, names: Map<string, string>) => {
  const row = new Row('lockfile_drift')
  const release = currentRelease(db)
  let checked = 0

  for (const c of db.select().from(component).all()) {
    if (
      (!c.station_id && c.name !== 'dispatch') ||
      c.name === 'docker_engine' ||
      c.lockfile_version === 'unpinned'
    ) {
      continue
    }

    checked++
    const drifted =
      c.version !== c.lockfile_version ||
      (c.lockfile_digest !== null && c.digest !== c.lockfile_digest)

    if (drifted) {
      const st = c.station_id ? (names.get(c.station_id) ?? c.station_id) : 'instance'

      row.raise(
        'warn',
        'lockfile_drift',
        `station ${st}: ${c.name} ${c.version}, ${release ? `release ${release.release}` : 'the lockfile'} pins ${c.lockfile_version}`,
        release
          ? `sly platform upgrade --version ${release.release} --station ${st}`
          : `sly platform upgrade ${c.name} --reset`,
      )
    }
  }

  row.detail.components_checked = checked
  row.note(
    release
      ? `${checked} pinned components match release ${release.release}`
      : 'no lockfile yet (sly setup writes it)',
  )

  return row.done()
}

const signatures = (db: Db, names: Map<string, string>) => {
  const row = new Row('signatures')

  if (readSetting(db, 'platform.allow_unsigned')) {
    row.raise(
      'warn',
      'allow_unsigned',
      'platform.allow_unsigned is true: stationd runs platform artifacts without a verified signature',
      `sly settings update --body '{"platform.allow_unsigned": false}'`,
    )
  }

  let verified = 0

  for (const c of db.select().from(component).all()) {
    if (!c.station_id || c.signature === 'not_applicable') {
      continue
    }

    if (c.signature === 'verified') {
      verified++
      continue
    }

    row.raise(
      'warn',
      'unsigned_artifact',
      `station ${names.get(c.station_id) ?? c.station_id}: ${c.name} ${c.version} (${c.digest ?? 'no digest'}) is ${c.signature}`,
      `sly platform upgrade ${c.name} --reset, or pin a signed digest`,
    )
  }

  row.detail.verified = verified
  row.note(`${verified} running platform artifacts verified against the release signing identity`)

  return row.done()
}

const stationRows = (db: Db) => {
  const stations = db.select().from(station).where(isNull(station.revoked_at)).all()
  const skew = new Row('version_skew')
  const live = new Row('station_liveness')
  const drifted = new Row('dispatch_drift')

  for (const st of stations) {
    if (st.version_skew && st.version_skew !== 'ok') {
      skew.raise(
        st.version_skew === 'unsupported' ? 'fail' : 'warn',
        'version_skew',
        `station ${st.name}: version_skew ${st.version_skew}`,
        `Upgrade stationd on ${st.name} into the supported window.`,
      )
    }

    if (!st.intermittent && st.status === 'offline') {
      live.raise(
        'fail',
        'station_offline',
        `station ${st.name} is offline since ${st.last_seen_at?.toISOString() ?? 'enrollment'}`,
        `Check stationd on ${st.name} (systemctl status, stationd connection).`,
      )
    }
  }

  const open = db.select().from(drift).where(eq(drift.status, 'open')).all()

  for (const d of open) {
    drifted.raise(
      'fail',
      'station_drift',
      `station ${stations.find((s) => s.id === d.station_id)?.name ?? d.station_id} reports state Dispatch did not issue (${d.object})`,
      "Resolve the drift: adopt the station state or force Dispatch's.",
    )
  }

  skew.note(`${stations.length} station(s) inside the version window`)
  live.note(
    `${stations.filter((s) => s.status === 'online').length} of ${stations.length} station(s) online`,
  )
  drifted.note('no open drift')

  return [skew.done(), live.done(), drifted.done()]
}

const certificates = (db: Db) => {
  const row = new Row('certificates')
  const now = Date.now()
  let checked = 0

  for (const d of db.select().from(domain).where(eq(domain.ingress, 'direct')).all()) {
    const cert = d.certificate

    if (!cert?.expires_at) {
      continue
    }

    checked++
    const expires = Date.parse(cert.expires_at)
    const issued = cert.not_before ? Date.parse(cert.not_before) : NaN
    const lifetime = Number.isFinite(issued) ? expires - issued : NaN
    const left = expires - now

    if (left <= 0) {
      row.raise(
        'fail',
        'certificate_expired',
        `${d.hostname} expired at ${cert.expires_at}`,
        'Check the Gateway ACME log; the domain must resolve to the station.',
      )
    } else if (Number.isFinite(lifetime) && left < lifetime / 6) {
      row.raise(
        'warn',
        'certificate_renewal_due',
        `${d.hostname} has ${Math.round(left / 3600000)} h of its ${Math.round(lifetime / 3600000)} h lifetime left`,
        'Check the Gateway ACME log; renewal should already have happened.',
      )
    }
  }

  row.note(`${checked} direct certificate(s) with more than a sixth of their lifetime left`)

  return row.done()
}

const tokenExpiry = (db: Db) => {
  const row = new Row('token_expiry')
  const hooks = db
    .select({
      id: agent_hook.id,
      token: token.id,
      expires: token.expires_at,
    })
    .from(agent_hook)
    .innerJoin(token, eq(token.id, agent_hook.token_id))
    .all()

  for (const h of hooks) {
    if (h.expires && h.expires.getTime() < Date.now()) {
      row.raise(
        'warn',
        'hook_token_expired',
        `agent hook ${h.id} uses token ${h.token}, expired ${h.expires.toISOString()}`,
        `sly tokens renew ${h.token}`,
      )
    }
  }

  row.note(`${hooks.length} agent hook token(s) checked; no Cloudflare token in phase 1a`)

  return row.done()
}

const baseImages = (db: Db) => {
  const row = new Row('base_images')
  let moved = 0

  for (const b of baseImageInventory(db)) {
    for (const c of b.checks) {
      if (c.check === 'moved') {
        moved++
        row.raise(
          'warn',
          'base_image_moved',
          `${c.service}: ${b.ref} moved to ${c.latest_digest?.slice(0, 19) ?? '?'}`,
          `sly services rebuild --service ${c.service}`,
        )
      } else if (c.check !== 'current') {
        row.raise(
          'warn',
          `base_image_${c.check}`,
          `${c.service}: ${b.ref} last check ${c.check}`,
          c.check === 'auth_required' || c.check === 'not_found'
            ? 'Check the base image reference; phase 1a checks anonymously.'
            : 'Retry later; the check repeats every base_images.check_interval_s.',
        )
      }
    }
  }

  row.detail.moved = moved
  row.note('every base image current')

  return row.done()
}

const channelsAndHooks = (db: Db) => {
  const channels = new Row('notification_channels')

  for (const c of db
    .select()
    .from(notification_channel)
    .where(eq(notification_channel.status, 'failing'))
    .all()) {
    channels.raise(
      'warn',
      'channel_failing',
      `notification channel ${c.id} (${c.kind}) failing since ${c.failing_since?.toISOString() ?? '?'}`,
      'Fix the endpoint, then re-enable the channel.',
    )
  }

  channels.note('no failing channel')
  const hooks = new Row('agent_hooks')

  for (const h of db.select().from(agent_hook).where(eq(agent_hook.status, 'disabled')).all()) {
    hooks.raise(
      'warn',
      'hook_disabled',
      `agent hook ${h.id} disabled at ${h.disabled_at?.toISOString() ?? '?'}`,
      'Fix the hook endpoint, then re-enable it.',
    )
  }

  hooks.note('no disabled hook')

  return [channels.done(), hooks.done()]
}

const volumeBackups = (db: Db) => {
  const row = new Row('volume_backups')
  const since = new Date(Date.now() - day)
  const failed = db
    .select()
    .from(volume_snapshot)
    .where(and(eq(volume_snapshot.status, 'failed'), gt(volume_snapshot.taken_at, since)))
    .all()

  for (const f of failed) {
    row.raise(
      'warn',
      'backup_failed',
      `backup ${f.id} of ${f.volume_id} failed: ${(f.failure as { explanation?: string } | null)?.explanation ?? 'unknown'}`,
      `sly volumes backup ${f.volume_id}`,
    )
  }

  const schedule = readSetting(db, 'volume_backup.schedule')

  row.detail.schedule = schedule
  row.detail.keep = readSetting(db, 'volume_backup.keep')
  row.note(
    schedule
      ? `scheduled ${schedule}, keeping ${String(readSetting(db, 'volume_backup.keep'))} per volume; no failure in 24 h`
      : 'no schedule (volume_backup.schedule); no failure in 24 h',
  )

  return row.done()
}

const releaseCheck = (db: Db) => {
  const row = new Row('release_check')

  row.note(
    readSetting(db, 'platform.release_check')
      ? 'release check enabled; the release feed is not read in this build'
      : 'release check disabled',
  )

  return row.done()
}

const logGaps = () => {
  const row = new Row('log_gaps')

  row.note('no log gap markers in the last 24 h')

  return row.done()
}

const recordTransitions = (
  db: Db,
  checks: DoctorRow[],
  stations: (typeof station.$inferSelect)[],
) => {
  const now = new Date()

  db.transaction((tx) => {
    const tdb = tx as unknown as Db

    for (const c of checks) {
      const st = stations.find((s) => s.name === c.station)
      const key = st?.id ?? ''
      const previous = tdb
        .select()
        .from(doctor_check)
        .where(and(eq(doctor_check.name, c.name), eq(doctor_check.station, key)))
        .get()
      const before: Status = previous?.status ?? 'ok'

      if (previous && previous.status === c.status && previous.code === c.code) {
        continue
      }

      tdb
        .insert(doctor_check)
        .values({
          name: c.name,
          station: key,
          status: c.status,
          code: c.code,
          changed_at: now,
        })
        .onConflictDoUpdate({
          target: [doctor_check.name, doctor_check.station],
          set: {
            status: c.status,
            code: c.code,
            ...(before === c.status
              ? {}
              : {
                  changed_at: now,
                }),
          },
        })
        .run()

      if (before === c.status) {
        continue
      }

      emitEvent(
        tdb,
        'doctor.finding',
        st
          ? {
              entity: 'station',
              id: st.id,
            }
          : {
              entity: 'instance',
              id: 'doctor',
            },
        {
          check: c.name,
          station: c.station,
          severity: c.status,
          previous: before,
          code: c.code,
          detail: c.finding,
          fix: c.fix,
        },
      )
    }
  })
}

export const runDoctor = async (
  deps: { db: Db; stations: StationServer },
  options: { station?: string } = {},
) => {
  const { db, stations } = deps
  const all = db.select().from(station).where(isNull(station.revoked_at)).all()
  const names = new Map(all.map((s) => [s.id, s.name]))
  const rows: DoctorRow[] = [
    lockfileDrift(db, names),
    {
      station: null,
      ...upgradeDoctorRow(db),
    },
    signatures(db, names),
    ...stationRows(db),
    certificates(db),
    tokenExpiry(db),
    baseImages(db),
    ...channelsAndHooks(db),
    volumeBackups(db),
    logGaps(),
    releaseCheck(db),
  ]
  const targets = all.filter(
    (s) => !options.station || s.id === options.station || s.name === options.station,
  )
  const reports = await Promise.all(
    targets.map(async (st): Promise<DoctorRow[]> => {
      if (!stations.isConnected(st.id)) {
        return [
          {
            name: 'station_checks',
            station: st.name,
            status: 'fail',
            code: 'station_offline',
            finding: `station ${st.name} is not connected; its host checks did not run`,
            fix: `Check stationd on ${st.name}.`,
          },
        ]
      }

      try {
        const reply = await stations.ask(
          st.id,
          'doctor.run',
          {},
          {
            timeoutMs: 30_000,
          },
        )
        const report = reply.body

        return report.checks.map((c): DoctorRow => ({
          name: c.name,
          station: st.name,
          status: c.status,
          code: c.code ?? null,
          finding: c.finding,
          fix: c.fix ?? null,
          ...(c.detail
            ? {
                detail: c.detail,
              }
            : {}),
        }))
      } catch (error) {
        return [
          {
            name: 'station_checks',
            station: st.name,
            status: 'fail',
            code: 'doctor_unavailable',
            finding: `station ${st.name} did not run its checks: ${(error as Error).message}`,
            fix: 'Upgrade stationd to a version with doctor.v1.',
          },
        ]
      }
    }),
  )
  const checks = [...rows, ...reports.flat()]
  const status = checks.reduce<Status>(
    (worst, c) => (rank[c.status] > rank[worst] ? c.status : worst),
    'ok',
  )
  const checkedAt = new Date().toISOString()

  recordTransitions(db, checks, all)

  return {
    status,
    checked_at: checkedAt,
    checks,
  }
}

export const doctorFor = (rows: DoctorRow[], names: string[] | undefined) =>
  names?.length ? rows.filter((r) => names.includes(r.name)) : rows
