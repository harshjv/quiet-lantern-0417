import { Type } from '@sinclair/typebox'
import { and, desc, eq } from 'drizzle-orm'
import { t } from 'elysia'

import {
  volumeOwnerValues,
  volumeSnapshotStatusValues,
  volumeStatusValues,
} from '@stationly/protocol'

import { anyTarget } from '../../auth/scopes.ts'
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
import { appById, isProduction, projectTarget, volumeById } from '../lookup.ts'
import { before, collect, filterOne, getQuery, listQuery } from '../pagination.ts'
import type { TargetInput } from '../route-meta.ts'
import { input, VolumeInput } from '../schemas.ts'
import {
  ApprovalDetail,
  BackupTargetShape,
  component,
  extend,
  Page,
  replies,
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
    server_id: Type.String(),
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
          if (row.app_id) {
            return can(principal, appById(db, row.app_id).target, 'read')
          }

          if (row.project_id) {
            return can(principal, projectTarget(row.project_id), 'read')
          }

          return can(principal, anyTarget, 'read')
        }
        const page = collect(
          (cursor, size) =>
            db
              .select()
              .from(volume)
              .where(
                and(
                  query.status ? eq(volume.status, query.status as 'active') : undefined,
                  query.server ? eq(volume.server_id, query.server) : undefined,
                  query.app ? eq(volume.app_id, query.app) : undefined,
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
          server: t.Optional(
            t.String({
              description: 'Only volumes on this server id',
            }),
          ),
          app: t.Optional(
            t.String({
              description: 'Only volumes of this app',
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
      '/apps/:app/volumes',
      ({ ctx, query }) => {
        return {
          items: projectAll(
            kit.views.volume,
            db
              .select()
              .from(volume)
              .where(eq(volume.app_id, ctx.app.id))
              .orderBy(desc(volume.id))
              .all(),
            kit.fields(query.fields),
          ),
          next_cursor: null,
        }
      },
      {
        app: {
          id: 'list_app_volumes',
          summary: 'List the volumes of an app',
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
      '/apps/:app/volumes',
      async ({ ctx, request, body, set }) => {
        const call = await kit.call(request)

        if (ctx.app.strategy === 'overlap' && !ctx.app.multi_writer_safe) {
          fail(
            'STRATEGY_VOLUME_CONFLICT',
            `${ctx.app.name} uses strategy overlap, which is unsafe with a volume.`,
            'Set strategy = replace, or multi_writer_safe = true, before adding a volume.',
          )
        }

        if (
          db
            .select()
            .from(volume)
            .where(and(eq(volume.app_id, ctx.app.id), eq(volume.mount_path, body.mount_path)))
            .get()
        ) {
          fail('NAME_TAKEN', `${ctx.app.name} already mounts a volume at ${body.mount_path}.`)
        }

        requireStationReady(db, ctx.app.server_id)
        const changes = new ChangeSet()

        changes.add('volume', ctx.app.id, {
          mount_path: body.mount_path,
        })
        const trigger = configDeployTrigger(ctx.app, ctx.app.source)

        if (trigger) {
          changes.deploy(ctx.app.id, trigger, {
            reason: `volume at ${body.mount_path} added`,
          })
        }

        const result = commit(
          kit.deps,
          call,
          {
            target: ctx.target_row,
            protect: isProduction(ctx.target_row),
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
        app: {
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
          202: ApprovalDetail,
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
            'Only a volume mounted by an app can be released here.',
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
        changes.update('volume', ctx.volume.id, '/app_id', ctx.volume.app_id, null)
        const result = commit(
          kit.deps,
          call,
          {
            target: ctx.owner!.target_row,
            protect: isProduction(ctx.owner!.target_row),
          },
          changes,
        )

        if (!result.applied) {
          return kit.approvalBody(result, set)
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
          202: ApprovalDetail,
        }),
      },
    )
    .post(
      '/volumes/:id/adopt',
      async ({ request, params, body, set }) => {
        const call = await kit.call(request)
        const ctx = volumeById(db, params.id)
        const target = appById(db, body.app_id)
        const reason =
          ctx.volume.status !== 'retained'
            ? `it is ${ctx.volume.status}, not retained`
            : ctx.volume.server_id !== target.app.server_id
              ? 'it lives on another server'
              : ctx.volume.project_id !== target.project.id
                ? 'it belongs to another project'
                : null

        if (reason) {
          fail(
            'VOLUME_NOT_ADOPTABLE',
            `Volume ${ctx.volume.id} cannot be adopted: ${reason}.`,
            'Adopt a retained volume of the same project on the app server.',
          )
        }

        requireStationReady(db, target.app.server_id)
        const changes = new ChangeSet()

        changes.update('volume', ctx.volume.id, '/app_id', null, target.app.id)
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
        const trigger = configDeployTrigger(target.app, target.app.source)

        if (trigger) {
          changes.deploy(target.app.id, trigger, {
            reason: `volume ${ctx.volume.id} adopted`,
          })
        }

        const result = commit(
          kit.deps,
          call,
          {
            target: target.target_row,
            protect: isProduction(target.target_row),
          },
          changes,
        )

        return respond(kit, set, result, () => view(ctx.volume.id))
      },
      {
        body: t.Object(
          {
            app_id: t.String({
              description: 'The app that mounts the volume',
            }),
            mount_path: VolumeInput.properties.mount_path,
          },
          {
            additionalProperties: false,
          },
        ),
        operation: {
          id: 'adopt_volume',
          summary: 'Adopt a retained volume into an app',
          level: 'admin',
          target: ({ body }: TargetInput) =>
            appById(db, (body as { app_id: string }).app_id).target,
        },
        response: replies({
          200: VolumeWritten,
          202: ApprovalDetail,
        }),
      },
    )
    .post(
      '/volumes/:id/backups',
      async ({ request, params, body, set }) => {
        const { call, ctx } = await callAndVolume(request, params.id)
        const quiesce = body.quiesce ?? true
        const place = ctx.owner?.target_row

        if (place && isProduction(place) && !call.principal.human) {
          const plan = guarded(() => backupPlan(db, params.id, body.target))
          const changes = new ChangeSet()

          changes.add('volume_snapshot', plan.vol.id, {
            target: plan.target,
            quiesce,
            trigger: 'manual',
          })
          const waiting = commit(
            kit.deps,
            call,
            {
              target: place,
              protect: true,
            },
            changes,
          )

          if (!waiting.applied) {
            return kit.approvalBody(waiting, set)
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
          202: ApprovalDetail,
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
        const place = ctx.owner?.target_row

        if (place && isProduction(place) && !call.principal.human) {
          const plan = guarded(() => restorePlan(db, params.id, body.backup, body.server))
          const changes = new ChangeSet()

          changes.add('volume_restore', plan.source.id, {
            snapshot_id: plan.snap.id,
            ...(body.server
              ? {
                  server_id: body.server,
                }
              : {}),
          })
          const waiting = commit(
            kit.deps,
            call,
            {
              target: place,
              protect: true,
            },
            changes,
          )

          if (!waiting.applied) {
            return kit.approvalBody(waiting, set)
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
          body.server,
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
            server: t.Optional(
              t.String({
                description: 'The server to restore an S3 backup on',
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
            'Restore a complete backup into a new retained volume of the same project; completion arrives as volume.restore_done; needs approval for a non-human actor in production',
          level: 'admin',
          mcp: {
            destructive: true,
          },
        },
        response: replies({
          201: RestoreStarted,
          202: ApprovalDetail,
        }),
      },
    )
}
