import { and, desc, eq, inArray } from 'drizzle-orm'

import { volumeDockerName, type MessageBody } from '@stationly/protocol'

import type { ActorValue } from '../auth/principal.ts'
import { recordAudit } from '../db/audit.ts'
import type { Db } from '../db/client.ts'
import { newId } from '../db/ids.ts'
import {
  app,
  deployment,
  server,
  volume,
  volume_snapshot,
  type StoredBackupTarget,
} from '../db/schema.ts'
import { readSetting, storedSetting } from '../db/settings.ts'
import { DomainError } from '../errors.ts'
import type { Log } from '../log.ts'
import { settingSchedule } from '../schedule.ts'
import { ephemeralDelivery } from '../secrets/deliver.ts'
import { SecretsError } from '../secrets/errors.ts'
import type { Keyring } from '../secrets/keyring.ts'
import { secretGlobalExists, secretGlobalValue } from '../secrets/variables.ts'
import { appSubject, emitEvent } from '../station/events.ts'
import type { StationServer } from '../station/server.ts'

import { s3Location, s3TargetIssues } from './s3-target.ts'

export type BackupTarget = StoredBackupTarget

export type BackupActor = { type: string; id: string | null; client?: string | null }

export type BackupDeps = { db: Db; stations: StationServer; keyring: Keyring }

type WireTarget = MessageBody<'volume.backup'>['target']

type BackupCode =
  | 'VOLUME_BACKUP_TARGET_MISSING'
  | 'VALIDATION_FAILED'
  | 'SERVER_OFFLINE'
  | 'NOT_FOUND'
  | 'SECRETS_UNAVAILABLE'
  | 'SECRETS_NEED_REENTRY'

export class BackupError extends DomainError<BackupCode> {
  declare readonly fix: string

  constructor(code: BackupCode, message: string, fix: string) {
    super(code, message, fix)
  }
}

export const snapshotView = (s: typeof volume_snapshot.$inferSelect) => ({
  id: s.id,
  volume_id: s.volume_id,
  server_id: s.server_id,
  taken_at: s.taken_at.toISOString(),
  finished_at: s.finished_at?.toISOString() ?? null,
  location: s.location,
  objects: s.objects,
  target: s.target,
  size_bytes: s.size_bytes,
  archive_bytes: s.archive_bytes,
  sha256: s.sha256,
  consistent: s.consistent,
  source: s.source,
  trigger: s.trigger,
  status: s.status,
  failure: s.failure,
})

const utcStamp = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z')

const credentialsFormat =
  'Store the access key id and the secret access key as ACCESS_KEY_ID:SECRET_ACCESS_KEY, for example sly env set --scope global --secret BACKUP_S3=AKIA...:wJal...'

const checkedTarget = (db: Db, target: BackupTarget | undefined): BackupTarget => {
  if (!target) {
    throw new BackupError(
      'VOLUME_BACKUP_TARGET_MISSING',
      'No target was given and the volume_backup.target setting is empty.',
      'sly settings update --body \'{"volume_backup.target":{"type":"path","path":"volumes"}}\', or pass --to.',
    )
  }

  if (target.type === 'path') {
    return {
      type: 'path',
      path: target.path,
    }
  }

  const issues = s3TargetIssues(target)

  if (issues.length) {
    throw new BackupError(
      'VALIDATION_FAILED',
      issues.join('; '),
      'Use an https endpoint, or an http endpoint on a private address, a bucket name, and a prefix of plain path segments.',
    )
  }

  const held = secretGlobalExists(db, target.credentials_environment_variable)

  if (!held) {
    throw new BackupError(
      'VALIDATION_FAILED',
      `credentials_environment_variable ${target.credentials_environment_variable} is not a global environment variable.`,
      credentialsFormat,
    )
  }

  if (!held.secret) {
    throw new BackupError(
      'VALIDATION_FAILED',
      `credentials_environment_variable ${target.credentials_environment_variable} is not secret.`,
      credentialsFormat,
    )
  }

  return {
    type: 's3',
    endpoint: target.endpoint,
    bucket: target.bucket,
    prefix: target.prefix,
    credentials_environment_variable: target.credentials_environment_variable,
  }
}

const wireTarget = (target: BackupTarget): WireTarget =>
  target.type === 'path'
    ? {
        type: 'path',
        path: target.path,
        endpoint: null,
        bucket: null,
        prefix: null,
      }
    : {
        type: 's3',
        path: null,
        endpoint: target.endpoint,
        bucket: target.bucket,
        prefix: target.prefix,
      }

const locationOf = (target: BackupTarget, archive: string) =>
  target.type === 'path' ? `${target.path}/${archive}` : s3Location(target, archive)

const deliverCredentials = async (
  deps: BackupDeps,
  stationId: string,
  snapshotId: string,
  target: BackupTarget,
  actor: BackupActor,
) => {
  if (target.type !== 's3') {
    return
  }

  const { db, stations, keyring } = deps
  let held: ReturnType<typeof secretGlobalValue>

  try {
    held = secretGlobalValue(db, keyring, target.credentials_environment_variable)
  } catch (error) {
    if (
      error instanceof SecretsError &&
      (error.code === 'SECRETS_UNAVAILABLE' || error.code === 'SECRETS_NEED_REENTRY')
    ) {
      throw new BackupError(
        error.code,
        error.message,
        'Set the secret global environment variable again.',
      )
    }

    if (error instanceof SecretsError) {
      throw new BackupError('VALIDATION_FAILED', error.message, credentialsFormat)
    }

    throw error
  }

  const split = held.value.indexOf(':')
  const accessKeyId = split > 0 ? held.value.slice(0, split) : ''
  const secretAccessKey = split > 0 ? held.value.slice(split + 1) : ''

  if (!accessKeyId || !secretAccessKey) {
    throw new BackupError(
      'VALIDATION_FAILED',
      `${target.credentials_environment_variable} does not hold ACCESS_KEY_ID:SECRET_ACCESS_KEY.`,
      credentialsFormat,
    )
  }

  const body = ephemeralDelivery(
    {
      snapshot_id: snapshotId,
    },
    'backup',
    [
      ['STATIONLY_S3_ACCESS_KEY_ID', accessKeyId],
      ['STATIONLY_S3_SECRET_ACCESS_KEY', secretAccessKey],
    ],
  )

  try {
    await stations.ask(stationId, 'secrets.deliver', body, {
      timeoutMs: 30_000,
    })
  } catch (error) {
    throw new BackupError(
      'SERVER_OFFLINE',
      (error as Error).message,
      'Check the server, then try again.',
    )
  }

  recordAudit(db, {
    actor: actor as ActorValue,
    action: 'secret.decrypt',
    target: {
      entity: 'volume_snapshot',
      id: snapshotId,
    },
    purpose: 'backup',
    after: {
      secret_value_ids: [held.secret_value_id],
    },
  })
}

export const backupPlan = (db: Db, volumeId: string, target: BackupTarget | undefined) => {
  const vol = db.select().from(volume).where(eq(volume.id, volumeId)).get()

  if (!vol) {
    throw new BackupError(
      'NOT_FOUND',
      `volume ${volumeId} does not exist`,
      'List volumes with sly volumes list.',
    )
  }

  if (vol.status === 'destroyed') {
    throw new BackupError(
      'VALIDATION_FAILED',
      `volume ${volumeId} is destroyed`,
      'Back up a volume that exists.',
    )
  }

  return {
    vol,
    target: checkedTarget(db, target ?? storedSetting(db, 'volume_backup.target')),
  }
}

export const startBackup = async (
  deps: BackupDeps,
  volumeId: string,
  options: {
    target?: BackupTarget
    quiesce: boolean
    trigger: 'manual' | 'schedule'
    actor: BackupActor
  },
) => {
  const { db, stations } = deps
  const { vol, target } = backupPlan(db, volumeId, options.target)

  if (!stations.isConnected(vol.server_id)) {
    throw new BackupError(
      'SERVER_OFFLINE',
      `server ${vol.server_id} is not connected`,
      'Bring the server online, then back up again.',
    )
  }

  const svc = vol.app_id ? db.select().from(app).where(eq(app.id, vol.app_id)).get() : undefined
  const dep = svc?.current_deployment_id
    ? db.select().from(deployment).where(eq(deployment.id, svc.current_deployment_id)).get()
    : undefined
  const id = newId('volume_snapshot')
  const now = new Date()
  const name = `${vol.id}-${utcStamp(now)}`
  const objects = {
    archive: `${name}.tar.zst`,
    metadata: `${name}.json`,
  }

  db.insert(volume_snapshot)
    .values({
      id,
      volume_id: vol.id,
      server_id: vol.server_id,
      taken_at: now,
      location: locationOf(target, objects.archive),
      source: 'tar',
      status: 'running',
      trigger: options.trigger,
      target,
      objects,
      consistent: options.quiesce,
    })
    .run()
  const body: MessageBody<'volume.backup'> = {
    snapshot_id: id,
    volume_id: vol.id,
    docker_name: vol.docker_name,
    service_id: vol.app_id ?? null,
    environment_id: svc?.target_id ?? null,
    deployment_id: dep?.id ?? null,
    image_ref: dep?.image_ref ?? null,
    mount_path: vol.mount_path,
    target: wireTarget(target),
    name,
    quiesce: options.quiesce,
  }

  try {
    await deliverCredentials(deps, vol.server_id, id, target, options.actor)
    await stations.ask(vol.server_id, 'volume.backup', body, {
      timeoutMs: 30_000,
    })
  } catch (error) {
    const code = (error as { code?: string }).code
    const refused = code === 'VALIDATION_FAILED' || code === 'VOLUME_BACKUP_TARGET_MISSING'

    if (refused) {
      db.delete(volume_snapshot).where(eq(volume_snapshot.id, id)).run()
    } else {
      db.update(volume_snapshot)
        .set({
          status: 'failed',
          finished_at: new Date(),
          failure: {
            code: code ?? 'SERVER_OFFLINE',
            explanation: (error as Error).message,
          },
        })
        .where(eq(volume_snapshot.id, id))
        .run()
    }

    if (error instanceof BackupError) {
      if (refused) {
        throw error
      }

      throw new BackupError(error.code, error.message, error.fix)
    }

    throw new BackupError(
      refused ? code : 'SERVER_OFFLINE',
      (error as Error).message,
      refused
        ? 'Name a directory under the server backup root, or an S3 bucket the server can reach.'
        : 'Check the server, then back up again.',
    )
  }

  recordAudit(db, {
    actor: options.actor as ActorValue,
    action: 'volume.backup_started',
    target: {
      entity: 'volume',
      id: vol.id,
    },
    after: {
      snapshot_id: id,
      target,
      objects,
      quiesce: options.quiesce,
      trigger: options.trigger,
    },
  })
  const row = db.select().from(volume_snapshot).where(eq(volume_snapshot.id, id)).get()!

  return {
    snapshot: snapshotView(row),
    warnings:
      options.quiesce && vol.app_id
        ? [
            {
              code: 'BACKUP_STOPS_APP',
              explanation: `The app using ${vol.id} is stopped while the archive is written, then started again from the same deployment.`,
            },
          ]
        : [],
  }
}

export const restorePlan = (db: Db, volumeId: string, snapshotId: string, stationId?: string) => {
  const snap = db
    .select()
    .from(volume_snapshot)
    .where(and(eq(volume_snapshot.id, snapshotId), eq(volume_snapshot.volume_id, volumeId)))
    .get()

  if (!snap) {
    throw new BackupError(
      'NOT_FOUND',
      `backup ${snapshotId} of volume ${volumeId} does not exist`,
      `List backups with sly volumes list-backups ${volumeId}.`,
    )
  }

  if (snap.status !== 'complete' || !snap.sha256 || !snap.objects || !snap.target) {
    throw new BackupError(
      'VALIDATION_FAILED',
      `backup ${snapshotId} is ${snap.status}; only a complete backup restores`,
      'Pick a complete backup.',
    )
  }

  const source = db.select().from(volume).where(eq(volume.id, volumeId)).get()!
  const targetStation = stationId ?? source.server_id

  if (stationId !== undefined) {
    const row = db.select().from(server).where(eq(server.id, stationId)).get()

    if (!row || row.revoked_at) {
      throw new BackupError(
        'NOT_FOUND',
        `server ${stationId} does not exist or is revoked`,
        'List servers with sly servers list.',
      )
    }
  }

  if (snap.target.type === 'path' && targetStation !== snap.server_id) {
    throw new BackupError(
      'VALIDATION_FAILED',
      `backup ${snapshotId} is a directory on server ${snap.server_id} and cannot be restored on ${targetStation}`,
      'Restore a backup written to an S3 target to move data between servers.',
    )
  }

  const target = checkedTarget(db, snap.target)

  return {
    snap: {
      ...snap,
      sha256: snap.sha256,
      objects: snap.objects,
      target,
    },
    source,
    server_id: targetStation,
  }
}

export const restoreBackup = async (
  deps: BackupDeps,
  volumeId: string,
  snapshotId: string,
  actor: BackupActor,
  stationId?: string,
) => {
  const { db, stations } = deps
  const { snap, source, server_id } = restorePlan(db, volumeId, snapshotId, stationId)

  if (!stations.isConnected(server_id)) {
    throw new BackupError(
      'SERVER_OFFLINE',
      `server ${server_id} is not connected`,
      'Bring the server online, then restore again.',
    )
  }

  const id = newId('volume')
  const dockerName = volumeDockerName(id)

  db.insert(volume)
    .values({
      id,
      owner: 'service',
      app_id: null,
      project_id: source.project_id,
      mount_path: source.mount_path,
      server_id,
      docker_name: dockerName,
      size_bytes: 0,
      status: 'retained',
      retain_until: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    })
    .run()

  try {
    await deliverCredentials(deps, server_id, snap.id, snap.target, actor)
    await stations.ask(
      server_id,
      'volume.restore',
      {
        snapshot_id: snap.id,
        volume_id: id,
        docker_name: dockerName,
        owner: 'service',
        target: wireTarget(snap.target),
        objects: snap.objects,
        sha256: snap.sha256,
      },
      {
        timeoutMs: 30_000,
      },
    )
  } catch (error) {
    db.delete(volume).where(eq(volume.id, id)).run()

    if (error instanceof BackupError) {
      throw error
    }

    throw new BackupError(
      'SERVER_OFFLINE',
      (error as Error).message,
      'Check the server, then restore again.',
    )
  }

  stations.reconcile(server_id)
  recordAudit(db, {
    actor: actor as ActorValue,
    action: 'volume.restore_started',
    target: {
      entity: 'volume',
      id,
    },
    after: {
      from_volume: volumeId,
      snapshot_id: snap.id,
      docker_name: dockerName,
      server_id,
    },
  })

  return {
    volume_id: id,
    docker_name: dockerName,
    snapshot_id: snap.id,
    server_id,
    status: 'running' as const,
    adopt: `sly volumes adopt ${id} --app-id <app id> --mount-path ${source.mount_path}`,
  }
}

export const keepCount = (db: Db) => readSetting(db, 'volume_backup.keep')

export const pruneBackups = async (deps: BackupDeps, volumeId: string) => {
  const { db, stations } = deps
  const keep = keepCount(db)
  const complete = db
    .select()
    .from(volume_snapshot)
    .where(and(eq(volume_snapshot.volume_id, volumeId), eq(volume_snapshot.status, 'complete')))
    .orderBy(desc(volume_snapshot.taken_at), desc(volume_snapshot.id))
    .all()
  const expired = complete.slice(keep).filter((s) => s.target && s.objects && s.server_id)

  if (!expired.length) {
    return {
      kept: complete.length,
      expired: [] as string[],
    }
  }

  const volumeStation = db
    .select({
      server_id: volume.server_id,
    })
    .from(volume)
    .where(eq(volume.id, volumeId))
    .get()?.server_id
  const gone: string[] = []
  const failed: { snapshot_id: string; explanation: string }[] = []
  const byStation = new Map<string, typeof expired>()

  for (const snap of expired) {
    const holder = snap.target!.type === 's3' ? (volumeStation ?? snap.server_id!) : snap.server_id!

    byStation.set(holder, [...(byStation.get(holder) ?? []), snap])
  }

  const actor = {
    type: 'system',
    id: null,
    client: 'volume-backup-retention',
  }

  for (const [stationId, snaps] of byStation) {
    const items: MessageBody<'volume.backup.delete'>['items'] = []

    for (const snap of snaps) {
      try {
        await deliverCredentials(deps, stationId, snap.id, snap.target!, actor)
        items.push({
          snapshot_id: snap.id,
          target: wireTarget(snap.target!),
          objects: snap.objects!,
        })
      } catch (error) {
        failed.push({
          snapshot_id: snap.id,
          explanation: (error as Error).message,
        })
      }
    }

    if (!items.length) {
      continue
    }

    const reply = await stations.ask(
      stationId,
      'volume.backup.delete',
      {
        items,
      },
      {
        timeoutMs: 120_000,
      },
    )
    const result = reply.body

    gone.push(...result.items.filter((i) => i.status !== 'failed').map((i) => i.snapshot_id))
    failed.push(
      ...result.items
        .filter((i) => i.status === 'failed')
        .map((i) => ({
          snapshot_id: i.snapshot_id,
          explanation: i.error?.explanation ?? 'failed',
        })),
    )
  }

  if (gone.length) {
    db.update(volume_snapshot)
      .set({
        status: 'expired',
      })
      .where(inArray(volume_snapshot.id, gone))
      .run()
  }

  recordAudit(db, {
    actor: actor as ActorValue,
    action: 'volume.backup_expired',
    target: {
      entity: 'volume',
      id: volumeId,
    },
    after: {
      keep,
      expired: gone,
      failed: failed.map((f) => f.snapshot_id),
    },
  })

  return {
    kept: complete.length - gone.length,
    expired: gone,
  }
}

const volumeSubject = (db: Db, volumeId: string) => {
  const v = db.select().from(volume).where(eq(volume.id, volumeId)).get()
  const base = v?.app_id ? appSubject(db, v.app_id) : {}

  return {
    ...base,
    entity: 'volume',
    id: volumeId,
    ...(v?.project_id
      ? {
          project_id: v.project_id,
        }
      : {}),
  }
}

export const recordBackupResult = (
  db: Db,
  stationId: string,
  body: MessageBody<'volume.backup.result'>,
) => {
  const snap = db
    .select()
    .from(volume_snapshot)
    .where(eq(volume_snapshot.id, body.snapshot_id))
    .get()

  if (!snap) {
    return false
  }

  db.update(volume_snapshot)
    .set({
      status: body.status,
      size_bytes: body.size_bytes,
      archive_bytes: body.archive_bytes,
      sha256: body.sha256,
      consistent: body.consistent,
      finished_at: new Date(body.finished_at),
      failure: body.failure ?? null,
    })
    .where(eq(volume_snapshot.id, body.snapshot_id))
    .run()
  emitEvent(db, 'volume.backup_done', volumeSubject(db, body.volume_id), {
    snapshot_id: body.snapshot_id,
    server_id: stationId,
    status: body.status,
    trigger: snap.trigger,
    objects: body.objects,
    size_bytes: body.size_bytes,
    archive_bytes: body.archive_bytes,
    sha256: body.sha256,
    consistent: body.consistent,
    failure: body.failure ?? null,
  })

  return false
}

export const recordRestoreResult = (
  db: Db,
  stationId: string,
  body: MessageBody<'volume.restore.result'>,
) => {
  if (body.status === 'complete') {
    db.update(volume)
      .set({
        size_bytes: body.size_bytes,
      })
      .where(eq(volume.id, body.volume_id))
      .run()
  }

  emitEvent(db, 'volume.restore_done', volumeSubject(db, body.volume_id), {
    snapshot_id: body.snapshot_id,
    server_id: stationId,
    status: body.status,
    sha256: body.sha256,
    size_bytes: body.size_bytes,
    files: body.files,
    tree_sha256: body.tree_sha256,
    failure: body.failure ?? null,
  })

  return true
}

export const startBackupScheduler = (deps: BackupDeps, log: Log) => {
  const { db, stations } = deps

  return settingSchedule(db, 'volume_backup.schedule', log, () => {
    const quiesce = readSetting(db, 'volume_backup.schedule_quiesce')

    for (const v of db
      .select()
      .from(volume)
      .where(and(eq(volume.status, 'active'), eq(volume.owner, 'service')))
      .all()) {
      if (!stations.isConnected(v.server_id)) {
        log('volume_backup.skipped', {
          volume_id: v.id,
          reason: 'server offline',
        })
        continue
      }

      startBackup(deps, v.id, {
        quiesce,
        trigger: 'schedule',
        actor: {
          type: 'system',
          id: null,
          client: 'volume-backup-schedule',
        },
      })
        .then((r) =>
          log('volume_backup.scheduled', {
            volume_id: v.id,
            snapshot_id: r.snapshot.id,
          }),
        )
        .catch((error) =>
          log('volume_backup.schedule_failed', {
            volume_id: v.id,
            code: (error as BackupError).code ?? null,
            explanation: (error as Error).message,
          }),
        )
    }
  })
}
