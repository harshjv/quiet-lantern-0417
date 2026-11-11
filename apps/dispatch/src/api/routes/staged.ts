import { Type, type Static } from '@sinclair/typebox'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { t } from 'elysia'

import { Nullable, stagedChangeSourceValues, stagedChangeStatusValues } from '@stationly/protocol'

import type { Principal } from '../../auth/principal.ts'
import { deployment, staged_change } from '../../db/schema.ts'
import { readSetting } from '../../db/settings.ts'
import { sendProbe } from '../../net/probe.ts'
import { growStorage } from '../../sandboxes/storage.ts'
import { restoreBackup, startBackup, type BackupActor } from '../../volumes/backups.ts'
import { requireHuman, requireInstance, requireLevel } from '../access.ts'
import { acceptStaged, rejectStaged } from '../changes.ts'
import { failureOf } from '../errors.ts'
import { project as select } from '../fields.ts'
import type { Kit } from '../kit.ts'
import { serviceById, stagedById } from '../lookup.ts'
import { before, collect, filterOne, getQuery, listQuery } from '../pagination.ts'
import {
  Deployment,
  extend,
  NetworkProbe,
  Page,
  replies,
  Staged,
  StagedChange,
  VolumeSnapshot,
  Warnings,
} from '../shapes.ts'

import { stationError } from './runs.ts'

const DecisionFailure = Type.Object(
  {
    code: Type.String(),
    explanation: Type.String(),
    fix: Nullable(Type.String()),
  },
  {
    additionalProperties: false,
  },
)

const BackupOutcome = Type.Union([
  Type.Object(
    {
      volume_id: Type.String(),
      snapshot: VolumeSnapshot,
      warnings: Warnings,
    },
    {
      additionalProperties: false,
    },
  ),
  Type.Object(
    {
      volume_id: Type.String(),
      failure: DecisionFailure,
    },
    {
      additionalProperties: false,
    },
  ),
])

const RestoreOutcome = Type.Union([
  Type.Object(
    {
      volume_id: Type.String(),
      restore: Type.Object(
        {
          volume_id: Type.String(),
          docker_name: Type.String(),
          snapshot_id: Type.String(),
          status: Type.Literal('running'),
          adopt: Type.String(),
        },
        {
          additionalProperties: false,
        },
      ),
    },
    {
      additionalProperties: false,
    },
  ),
  Type.Object(
    {
      volume_id: Type.String(),
      failure: DecisionFailure,
    },
    {
      additionalProperties: false,
    },
  ),
])

const ProbeOutcome = Type.Union([
  Type.Object(
    {
      service_id: Type.String(),
      result: NetworkProbe,
    },
    {
      additionalProperties: false,
    },
  ),
  Type.Object(
    {
      service_id: Type.String(),
      failure: DecisionFailure,
    },
    {
      additionalProperties: false,
    },
  ),
])

const GrowOutcome = Type.Union([
  Type.Object(
    {
      station_id: Type.String(),
      filesystem_bytes: Type.Integer(),
      filesystem_free_bytes: Type.Integer(),
    },
    {
      additionalProperties: false,
    },
  ),
  Type.Object(
    {
      station_id: Type.String(),
      failure: DecisionFailure,
    },
    {
      additionalProperties: false,
    },
  ),
])

const Accepted = extend(Staged, {
  grows: Type.Optional(Type.Array(GrowOutcome)),
  deployments: Type.Array(Deployment),
  backups: Type.Optional(Type.Array(BackupOutcome)),
  restores: Type.Optional(Type.Array(RestoreOutcome)),
  probes: Type.Optional(Type.Array(ProbeOutcome)),
})

type StagedStatus = (typeof staged_change.$inferSelect)['status']
type StagedSource = (typeof staged_change.$inferSelect)['source']

export const stagedRoutes = (kit: Kit) => {
  const { db } = kit.deps
  const full = kit.fields('changes,refs,deployments,accepted_by')
  const decided = (row: typeof staged_change.$inferSelect) =>
    select(kit.views.staged, row, full) as Static<typeof Staged>

  const authorizeDecision = (principal: Principal, ctx: ReturnType<typeof stagedById>) => {
    if (ctx.environment) {
      if (!ctx.environment.environment.protected) {
        return
      }

      requireLevel(principal, ctx.target, 'admin')
      requireHuman(principal, 'Accepting or rejecting a staged change in a protected environment', {
        ...ctx.target,
        level: 'admin',
      })

      return
    }

    requireInstance(principal, 'admin')

    if (readSetting(db, 'platform.protected')) {
      requireHuman(
        principal,
        'Accepting or rejecting an instance staged change while platform.protected is true',
        {
          level: 'admin',
        },
      )
    }
  }

  return kit
    .router('staged-changes', '/v1')
    .get(
      '/environments/:environment/staged-changes',
      ({ ctx, query }) => {
        const page = collect(
          (cursor, size) =>
            db
              .select()
              .from(staged_change)
              .where(
                and(
                  eq(staged_change.environment_id, ctx.environment.id),
                  query.status === 'all'
                    ? undefined
                    : eq(staged_change.status, (query.status ?? 'staged') as StagedStatus),
                  query.source ? eq(staged_change.source, query.source as StagedSource) : undefined,
                  before(staged_change.id, cursor),
                ),
              )
              .orderBy(desc(staged_change.id))
              .limit(size)
              .all(),
          query,
        )

        return {
          items: page.rows.map((row) => select(kit.views.staged, row, kit.fields(query.fields))),
          next_cursor: page.next_cursor,
        }
      },
      {
        environment: {
          id: 'list_staged_changes',
          summary:
            'List staged changes of an environment (default status staged; status=all for every row)',
          level: 'read',
        },
        query: t.Object({
          ...listQuery,
          status: t.Optional(
            t.String({
              description: `One of ${stagedChangeStatusValues.join(', ')}, or all (default staged)`,
            }),
          ),
          source: filterOne(stagedChangeSourceValues),
        }),
        response: replies({
          200: Page(StagedChange),
        }),
      },
    )
    .get(
      '/staged-changes',
      ({ query }) => {
        const page = collect(
          (cursor, size) =>
            db
              .select()
              .from(staged_change)
              .where(
                and(
                  query.status ? eq(staged_change.status, query.status as StagedStatus) : undefined,
                  query.scope === 'instance' ? isNull(staged_change.environment_id) : undefined,
                  before(staged_change.id, cursor),
                ),
              )
              .orderBy(desc(staged_change.id))
              .limit(size)
              .all(),
          query,
        )

        return {
          items: page.rows.map((row) => select(kit.views.staged, row, kit.fields(query.fields))),
          next_cursor: page.next_cursor,
        }
      },
      {
        operation: {
          id: 'list_instance_staged_changes',
          summary: 'List staged changes across the instance',
          level: 'instance read',
          cli: {
            path: ['staged-changes', 'list-all'],
          },
        },
        query: t.Object({
          ...listQuery,
          status: filterOne(stagedChangeStatusValues),
          scope: t.Optional(t.Literal('instance')),
        }),
        response: replies({
          200: Page(StagedChange),
        }),
      },
    )
    .get(
      '/staged-changes/:id',
      ({ ctx, query }) => {
        return select(kit.views.staged, ctx.staged, kit.fields(query.fields) ?? full)
      },
      {
        staged_change: {
          id: 'get_staged_change',
          summary: 'Get a staged change with its diff',
          level: 'read',
        },
        query: t.Object(getQuery),
        response: replies({
          200: StagedChange,
        }),
      },
    )
    .post(
      '/staged-changes/:id/accept',
      async ({ ctx, request }) => {
        const call = await kit.call(request)

        authorizeDecision(call.principal, ctx)
        const result = acceptStaged(kit.deps, call, ctx.staged)

        if (
          (ctx.staged.changes as { entity: string; path?: string }[]).some(
            (c) =>
              c.entity === 'setting' || (c.entity === 'station' && c.path === '/public_address'),
          )
        ) {
          kit.deps.auth.rebuild()
        }

        const deployments = result.deployments.map((id) =>
          select(
            kit.views.deployment,
            db.select().from(deployment).where(eq(deployment.id, id)).get()!,
            undefined,
          ),
        )
        const backups = await Promise.all(
          result.backups.map((b) =>
            startBackup(
              {
                db,
                stations: kit.deps.stations,
                keyring: kit.deps.keyring,
              },
              b.volume_id,
              {
                target: b.target,
                quiesce: b.quiesce,
                trigger: 'manual',
                actor: ctx.staged.actor,
              },
            ).then(
              (started) => ({
                volume_id: b.volume_id,
                snapshot: started.snapshot,
                warnings: started.warnings,
              }),
              (error: Error) => ({
                volume_id: b.volume_id,
                failure: failureOf(error),
              }),
            ),
          ),
        )
        const restores = await Promise.all(
          result.restores.map((r) =>
            restoreBackup(
              {
                db,
                stations: kit.deps.stations,
                keyring: kit.deps.keyring,
              },
              r.volume_id,
              r.snapshot_id,
              ctx.staged.actor as BackupActor,
              r.station_id,
            ).then(
              (restored) => ({
                volume_id: r.volume_id,
                restore: restored,
              }),
              (error: Error) => ({
                volume_id: r.volume_id,
                failure: failureOf(error),
              }),
            ),
          ),
        )
        const probes = await Promise.all(
          result.probes.map((p) =>
            sendProbe(
              kit.deps,
              call,
              serviceById(db, p.service_id).service,
              p,
              ctx.staged.actor,
            ).then(
              (probe) => ({
                service_id: p.service_id,
                result: probe,
              }),
              (error: Error) => ({
                service_id: p.service_id,
                failure: failureOf(error),
              }),
            ),
          ),
        )
        const grows = await Promise.all(
          result.grows.map((g) =>
            growStorage(
              {
                db,
                stations: kit.deps.stations,
              },
              g.station_id,
              g.size_bytes,
              stationError,
            ).then(
              (grown) => ({
                station_id: g.station_id,
                filesystem_bytes: grown.filesystem_bytes,
                filesystem_free_bytes: grown.filesystem_free_bytes,
              }),
              (error: Error) => ({
                station_id: g.station_id,
                failure: failureOf(error),
              }),
            ),
          ),
        )

        return {
          ...decided(result.staged),
          deployments,
          ...(grows.length
            ? {
                grows,
              }
            : {}),
          ...(backups.length
            ? {
                backups,
              }
            : {}),
          ...(restores.length
            ? {
                restores,
              }
            : {}),
          ...(probes.length
            ? {
                probes,
              }
            : {}),
        }
      },
      {
        staged_change: {
          id: 'accept_staged_change',
          summary: 'Accept a staged change and apply its diff',
          level: 'deploy',
        },
        response: replies({
          200: Accepted,
        }),
      },
    )
    .post(
      '/staged-changes/:id/reject',
      async ({ ctx, request, body }) => {
        const call = await kit.call(request)

        authorizeDecision(call.principal, ctx)

        return decided(rejectStaged(kit.deps, call, ctx.staged, body?.reason ?? null))
      },
      {
        staged_change: {
          id: 'reject_staged_change',
          summary: 'Reject a staged change',
          level: 'deploy',
        },
        body: t.Optional(
          t.Object(
            {
              reason: t.Optional(
                t.String({
                  description: 'Why the change is rejected, kept with the change',
                }),
              ),
            },
            {
              additionalProperties: false,
            },
          ),
        ),
        response: replies({
          200: Staged,
        }),
      },
    )
}
