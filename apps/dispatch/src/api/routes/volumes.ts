import { Type } from '@sinclair/typebox'
import { and, desc, eq } from 'drizzle-orm'
import { t } from 'elysia'

import {
  volumeOwnerValues,
  volumeSnapshotStatusValues,
  volumeStatusValues,
} from '@stationly/protocol'

import { volume, volume_snapshot } from '../../db/schema.ts'
import {
  BackupError,
  backupPlan,
  restoreBackup,
  restorePlan,
  snapshotView,
  startBackup,
} from '../../volumes/backups.ts'
import { can, requireHuman } from '../access.ts'
import { ChangeSet, commit } from '../changes.ts'
import { configDeployTrigger, requireStationReady } from '../deployments.ts'
import { fail } from '../errors.ts'
import { projectAll, project as select } from '../fields.ts'
import type { Kit } from '../kit.ts'
import { serviceById, volumeById } from '../lookup.ts'
import { before, collect, filterOne, getQuery, listQuery } from '../pagination.ts'
import type { TargetInput } from '../route-meta.ts'
import { input, VolumeInput } from '../schemas.ts'
import {
  BackupTargetShape,
  component,
  extend,
  Page,
  replies,
  Staged,
  Volume,
  VolumeSnapshot,
  Warnings,
} from '../shapes.ts'

import { respond, withDeployments } from './services.ts'

const retentionMs = 7 * 24 * 3600 * 1000

const VolumeWritten = component('VolumeWritten', withDeployments(Volume))

const BackupStarted = extend(VolumeSnapshot, {
  warnings: Warnings,
})

const RestoreStarted = Type.Object(
  {
    volume_id: Type.String(),
    docker_name: Type.String(),
    snapshot_id: Type.String(),
    station_id: Type.String(),
    status: Type.Literal('running'),
    adopt: Type.String(),
  },
  {
    additionalProperties: false,
  },
)

export const volumeRoutes = (kit: Kit) => {
  const { db } = kit.deps
  const view = (id: string) =>
    select(kit.views.volume, db.select().from(volume).where(eq(volume.id, id)).get()!, undefined)
  const backupError = (error: unknown): never => {
    if (error instanceof BackupError) {
      fail(error.code, error.message, error.fix)
    }

    throw error
  }
  const guarded = <T>(fn: () => T): T => {
    try {
      return fn()
    } catch (error) {
      return backupError(error)
    }
  }
  const callAndVolume = async (request: Request, id: string) => ({
    call: await kit.call(request),
    ctx: volumeById(db, id),
  })

  return kit
    .router('volumes', '/v1')
    .get(
      '/volumes',
      async ({ request, query }) => {
        const principal = await kit.principal(request)
        const visible = (row: typeof volume.$inferSelect) => {
          if (row.service_id) {
            return can(principal, serviceById(db, row.service_id).target, 'read')
          }

          if (row.project_id) {
            return can(
              principal,
              {
                project_id: row.project_id,
                environment_id: '*',
              },
              'read',
            )
          }

          return can(
            principal,
            {
              project_id: '*',
              environment_id: '*',
            },
            'read',
          )
        }
        const page = collect(
          (cursor, size) =>
            db
              .select()
              .from(volume)
              .where(
                and(
                  query.status ? eq(volume.status, query.status as 'active') : undefined,
                  query.station ? eq(volume.station_id, query.station) : undefined,
                  query.service ? eq(volume.service_id, query.service) : undefined,
                  query.owner ? eq(volume.owner, query.owner as 'service') : undefined,
                  before(volume.id, cursor),
                ),
              )
              .orderBy(desc(volume.id))
              .limit(size)
              .all(),
          query,
          visible,
        )

        return {
          items: page.rows.map((row) => select(kit.views.volume, row, kit.fields(query.fields))),
          next_cursor: page.next_cursor,
        }
      },
      {
        operation: {
          id: 'list_volumes',
          summary: 'List volumes visible to the caller',
          level: 'any',
        },
        query: t.Object({
          ...listQuery,
          status: filterOne(volumeStatusValues),
          station: t.Optional(
            t.String({
              description: 'Only volumes on this station id',
            }),
          ),
          service: t.Optional(
            t.String({
              description: 'Only volumes of this service',
            }),
          ),
          owner: filterOne(volumeOwnerValues),
        }),
        response: replies({
          200: Page(Volume),
        }),
      },
    )
    .get(
      '/services/:service/volumes',
      ({ ctx, query }) => {
        return {
          items: projectAll(
            kit.views.volume,
            db
              .select()
              .from(volume)
              .where(eq(volume.service_id, ctx.service.id))
              .orderBy(desc(volume.id))
              .all(),
            kit.fields(query.fields),
          ),
          next_cursor: null,
        }
      },
      {
        service: {
          id: 'list_service_volumes',
          summary: 'List the volumes of a service',
          level: 'read',
        },
        query: t.Object(getQuery),
        response: replies({
          200: Page(Volume),
        }),
      },
    )
    .get(
      '/volumes/:id',
      ({ ctx, query }) => select(kit.views.volume, ctx.volume, kit.fields(query.fields)),
      {
        volume: {
          id: 'get_volume',
          summary: 'Get a volume',
          level: 'read',
          mcp: false,
        },
        query: t.Object(getQuery),
        response: replies({
          200: Volume,
        }),
      },
    )
    .post(
      '/services/:service/volumes',
      async ({ ctx, request, body, set }) => {
        const call = await kit.call(request)

        if (ctx.service.strategy === 'overlap' && !ctx.service.multi_writer_safe) {
          fail(
            'STRATEGY_VOLUME_CONFLICT',
            `${ctx.service.name} uses strategy overlap, which is unsafe with a volume.`,
            'Set strategy = replace, or multi_writer_safe = true, before adding a volume.',
          )
        }

        if (
          db
            .select()
            .from(volume)
            .where(
              and(eq(volume.service_id, ctx.service.id), eq(volume.mount_path, body.mount_path)),
            )
            .get()
        ) {
          fail('NAME_TAKEN', `${ctx.service.name} already mounts a volume at ${body.mount_path}.`)
        }

        requireStationReady(db, ctx.service.station_id)
        const changes = new ChangeSet()

        changes.add('volume', ctx.service.id, {
          mount_path: body.mount_path,
        })
        const trigger = configDeployTrigger(ctx.service, ctx.service.source)

        if (trigger) {
          changes.deploy(ctx.service.id, trigger, {
            reason: `volume at ${body.mount_path} added`,
          })
        }

        const result = commit(
          kit.deps,
          call,
          {
            environment: ctx.environment,
            protect: ctx.environment.protected,
          },
          changes,
        )

        if (result.applied) {
          set.status = 201
        }

        return respond(kit, set, result, () =>
          view(result.applied ? result.refs['new:volume:1']! : ''),
        )
      },
      {
        service: {
          id: 'add_volume',
          summary: 'Add a volume; deploys',
          level: 'deploy',
        },
        body: t.Object(
          {
            mount_path: VolumeInput.properties.mount_path,
          },
          {
            additionalProperties: false,
          },
        ),
        response: replies({
          201: VolumeWritten,
          202: Staged,
        }),
      },
    )
    .delete(
      '/volumes/:id',
      async ({ ctx, request, query, set }) => {
        const call = await kit.call(request)

        if (!ctx.owner) {
          fail(
            'VALIDATION_FAILED',
            'Only a volume mounted by a service can be released here.',
            undefined,
            {
              issues: [
                {
                  path: '/id',
                  message: `volume is ${ctx.volume.status}`,
                },
              ],
            },
          )
        }

        if (query.destroy_now) {
          requireHuman(call.principal, 'Destroying a volume before its retention ends', {
            destroy_now: true,
          })
        }

        const changes = new ChangeSet()
        const until = new Date(Date.now() + (query.destroy_now ? 0 : retentionMs)).toISOString()

        changes.update('volume', ctx.volume.id, '/status', ctx.volume.status, 'retained')
        changes.update('volume', ctx.volume.id, '/retain_until', null, until)
        changes.update('volume', ctx.volume.id, '/service_id', ctx.volume.service_id, null)
        const result = commit(
          kit.deps,
          call,
          {
            environment: ctx.owner!.environment,
            protect: ctx.owner!.environment.protected,
          },
          changes,
        )

        if (!result.applied) {
          return kit.stagedBody(result, set)
        }

        return view(ctx.volume.id)
      },
      {
        volume: {
          id: 'remove_volume',
          summary: 'Release a volume into retention',
          level: 'admin',
        },
        query: t.Object({
          destroy_now: t.Optional(
            t.BooleanString({
              description: 'Destroy the data now instead of retaining the volume (default false)',
            }),
          ),
        }),
        response: replies({
          200: Volume,
          202: Staged,
        }),
      },
    )
    .post(
      '/volumes/:id/adopt',
      async ({ request, params, body, set }) => {
        const call = await kit.call(request)
        const ctx = volumeById(db, params.id)
        const target = serviceById(db, body.service_id)
        const reason =
          ctx.volume.status !== 'retained'
            ? `it is ${ctx.volume.status}, not retained`
            : ctx.volume.station_id !== target.service.station_id
              ? 'it lives on another station'
              : ctx.volume.project_id !== target.project.id
                ? 'it belongs to another project'
                : null

        if (reason) {
          fail(
            'VOLUME_NOT_ADOPTABLE',
            `Volume ${ctx.volume.id} cannot be adopted: ${reason}.`,
            'Adopt a retained volume of the same project on the service station.',
          )
        }

        requireStationReady(db, target.service.station_id)
        const changes = new ChangeSet()

        changes.update('volume', ctx.volume.id, '/service_id', null, target.service.id)
        changes.update(
          'volume',
          ctx.volume.id,
          '/mount_path',
          ctx.volume.mount_path,
          body.mount_path,
        )
        changes.update('volume', ctx.volume.id, '/status', 'retained', 'active')
        changes.update(
          'volume',
          ctx.volume.id,
          '/retain_until',
          ctx.volume.retain_until?.toISOString() ?? null,
          null,
        )
        const trigger = configDeployTrigger(target.service, target.service.source)

        if (trigger) {
          changes.deploy(target.service.id, trigger, {
            reason: `volume ${ctx.volume.id} adopted`,
          })
        }

        const result = commit(
          kit.deps,
          call,
          {
            environment: target.environment,
            protect: target.environment.protected,
          },
          changes,
        )

        return respond(kit, set, result, () => view(ctx.volume.id))
      },
      {
        body: t.Object(
          {
            service_id: t.String({
              description: 'The service that mounts the volume',
            }),
            mount_path: VolumeInput.properties.mount_path,
          },
          {
            additionalProperties: false,
          },
        ),
        operation: {
          id: 'adopt_volume',
          summary: 'Adopt a retained volume into a service',
          level: 'admin',
          target: ({ body }: TargetInput) =>
            serviceById(db, (body as { service_id: string }).service_id).target,
        },
        response: replies({
          200: VolumeWritten,
          202: Staged,
        }),
      },
    )
    .post(
      '/volumes/:id/backups',
      async ({ request, params, body, set }) => {
        const { call, ctx } = await callAndVolume(request, params.id)
        const quiesce = body.quiesce ?? true
        const environment = ctx.owner?.environment

        if (environment?.protected && !call.principal.human) {
          const plan = guarded(() => backupPlan(db, params.id, body.target))
          const changes = new ChangeSet()

          changes.add('volume_snapshot', plan.vol.id, {
            target: plan.target,
            quiesce,
            trigger: 'manual',
          })
          const staged = commit(
            kit.deps,
            call,
            {
              environment,
              protect: true,
            },
            changes,
          )

          if (!staged.applied) {
            return kit.stagedBody(staged, set)
          }
        }

        const result = await startBackup(
          {
            db,
            stations: kit.deps.stations,
            keyring: kit.deps.keyring,
          },
          params.id,
          {
            target: body.target,
            quiesce,
            trigger: 'manual',
            actor: call.principal.actor,
          },
        ).catch(backupError)

        set.status = 201

        return {
          ...result.snapshot,
          warnings: result.warnings,
        }
      },
      {
        body: t.Object(
          {
            target: t.Optional(input(BackupTargetShape)),
            quiesce: t.Optional(t.Boolean()),
          },
          {
            additionalProperties: false,
          },
        ),
        volume: {
          id: 'backup_volume',
          summary:
            'Write a tar.zst of the volume to volume_backup.target or the given target; completion arrives as volume.backup_done',
          level: 'admin',
          cli: false,
        },
        response: replies({
          201: BackupStarted,
          202: Staged,
        }),
      },
    )
    .get(
      '/volumes/:id/backups',
      ({ params, query }) => {
        const rows = db
          .select()
          .from(volume_snapshot)
          .where(
            and(
              eq(volume_snapshot.volume_id, params.id),
              query.status ? eq(volume_snapshot.status, query.status as 'complete') : undefined,
            ),
          )
          .orderBy(desc(volume_snapshot.taken_at), desc(volume_snapshot.id))
          .all()

        return {
          items: rows.map(snapshotView),
          next_cursor: null,
        }
      },
      {
        volume: {
          id: 'list_volume_backups',
          summary: 'Backups of a volume, newest first',
          level: 'read',
        },
        query: t.Object({
          status: filterOne(volumeSnapshotStatusValues),
        }),
        response: replies({
          200: Page(VolumeSnapshot),
        }),
      },
    )
    .post(
      '/volumes/:id/restore',
      async ({ request, params, body, set }) => {
        const { call, ctx } = await callAndVolume(request, params.id)
        const environment = ctx.owner?.environment

        if (environment?.protected && !call.principal.human) {
          const plan = guarded(() => restorePlan(db, params.id, body.backup, body.station))
          const changes = new ChangeSet()

          changes.add('volume_restore', plan.source.id, {
            snapshot_id: plan.snap.id,
            ...(body.station
              ? {
                  station_id: body.station,
                }
              : {}),
          })
          const staged = commit(
            kit.deps,
            call,
            {
              environment,
              protect: true,
            },
            changes,
          )

          if (!staged.applied) {
            return kit.stagedBody(staged, set)
          }
        }

        const result = await restoreBackup(
          {
            db,
            stations: kit.deps.stations,
            keyring: kit.deps.keyring,
          },
          params.id,
          body.backup,
          call.principal.actor,
          body.station,
        ).catch(backupError)

        set.status = 201

        return result
      },
      {
        body: t.Object(
          {
            backup: t.String({
              description: 'The id of a complete backup of this volume',
            }),
            station: t.Optional(
              t.String({
                description: 'The station to restore an S3 backup on',
              }),
            ),
          },
          {
            additionalProperties: false,
          },
        ),
        volume: {
          id: 'restore_volume',
          summary:
            'Restore a complete backup into a new retained volume of the same project; completion arrives as volume.restore_done; staged for a non-human actor in a protected environment',
          level: 'admin',
          mcp: {
            destructive: true,
          },
        },
        response: replies({
          201: RestoreStarted,
          202: Staged,
        }),
      },
    )
}
