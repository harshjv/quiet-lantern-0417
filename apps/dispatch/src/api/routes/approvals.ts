import { Type, type Static } from '@sinclair/typebox'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { t } from 'elysia'

import { approvalSourceValues, approvalStatusValues, Nullable } from '@stationly/protocol'

import type { Principal } from '../../auth/principal.ts'
import { anyTarget, isInstanceAdmin } from '../../auth/scopes.ts'
import { approval, deployment } from '../../db/schema.ts'
import { sendProbe } from '../../net/probe.ts'
import { growStorage } from '../../sandboxes/storage.ts'
import { decideShip } from '../../tasks/ship.ts'
import { restoreBackup, startBackup, type BackupActor } from '../../volumes/backups.ts'
import { can, requireHuman, requireInstance, requireLevel } from '../access.ts'
import { approveChanges, rejectApproval } from '../changes.ts'
import type { Call } from '../context.ts'
import { fail, failureOf, notFound } from '../errors.ts'
import { project as select } from '../fields.ts'
import type { Kit } from '../kit.ts'
import { appById, approvalById, projectIdByRef, type ApprovalRow } from '../lookup.ts'
import { before, collect, filterOne, getQuery, listQuery } from '../pagination.ts'
import {
  Approval,
  ApprovalDetail,
  Deployment,
  extend,
  NetworkProbe,
  Page,
  replies,
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
      app_id: Type.String(),
      result: NetworkProbe,
    },
    {
      additionalProperties: false,
    },
  ),
  Type.Object(
    {
      app_id: Type.String(),
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
      server_id: Type.String(),
      filesystem_bytes: Type.Integer(),
      filesystem_free_bytes: Type.Integer(),
    },
    {
      additionalProperties: false,
    },
  ),
  Type.Object(
    {
      server_id: Type.String(),
      failure: DecisionFailure,
    },
    {
      additionalProperties: false,
    },
  ),
])

const Decided = extend(ApprovalDetail, {
  grows: Type.Optional(Type.Array(GrowOutcome)),
  deployments: Type.Array(Deployment),
  backups: Type.Optional(Type.Array(BackupOutcome)),
  restores: Type.Optional(Type.Array(RestoreOutcome)),
  probes: Type.Optional(Type.Array(ProbeOutcome)),
})

type ApprovalStatus = ApprovalRow['status']
type ApprovalSource = ApprovalRow['source']

export const seesApproval = (principal: Principal, row: ApprovalRow) => {
  if (can(principal, anyTarget, 'read')) {
    return true
  }

  if (row.task_id) {
    return row.requester === principal.user_id
  }

  return (
    row.project_id !== null &&
    can(
      principal,
      {
        project_id: row.project_id,
        target: 'production',
      },
      'read',
    )
  )
}

export const approvalRoutes = (kit: Kit) => {
  const { db } = kit.deps
  const full = kit.fields('changes,refs,deployments')
  const decided = (row: ApprovalRow) =>
    select(kit.views.approval, row, full) as Static<typeof ApprovalDetail>

  const authorizeDecision = (principal: Principal, ctx: ReturnType<typeof approvalById>) => {
    requireHuman(principal, 'Deciding an approval', {
      level: 'admin',
    })

    if (ctx.approval.task_id) {
      if (!isInstanceAdmin(principal.scopes)) {
        fail(
          'FORBIDDEN_SCOPE',
          'Only an admin approves shipping to production.',
          'Ask an admin to decide.',
          {
            required: {
              ...anyTarget,
              level: 'admin',
            },
          },
        )
      }

      return
    }

    if (ctx.production) {
      requireLevel(principal, ctx.target, 'admin')

      return
    }

    requireInstance(principal, 'admin')
  }

  const approve = async (call: Call, row: ApprovalRow) => {
    const result = approveChanges(kit.deps, call, row)

    if (
      (row.changes as { entity: string; path?: string }[]).some(
        (c) => c.entity === 'setting' || (c.entity === 'server' && c.path === '/public_address'),
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
            actor: row.requested_by,
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
          row.requested_by as BackupActor,
          r.server_id,
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
        sendProbe(kit.deps, call, appById(db, p.app_id).app, p, row.requested_by).then(
          (probe) => ({
            app_id: p.app_id,
            result: probe,
          }),
          (error: Error) => ({
            app_id: p.app_id,
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
          g.server_id,
          g.size_bytes,
          stationError,
        ).then(
          (grown) => ({
            server_id: g.server_id,
            filesystem_bytes: grown.filesystem_bytes,
            filesystem_free_bytes: grown.filesystem_free_bytes,
          }),
          (error: Error) => ({
            server_id: g.server_id,
            failure: failureOf(error),
          }),
        ),
      ),
    )

    return {
      ...decided(result.approval),
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
  }

  return kit
    .router('approvals', '/v1')
    .get(
      '/approvals',
      async ({ query, request }) => {
        const call = await kit.call(request)
        const projectId = query.project ? projectIdByRef(db, query.project) : undefined
        const page = collect(
          (cursor, size) =>
            db
              .select()
              .from(approval)
              .where(
                and(
                  query.status === 'all'
                    ? undefined
                    : eq(approval.status, (query.status ?? 'waiting') as ApprovalStatus),
                  query.source ? eq(approval.source, query.source as ApprovalSource) : undefined,
                  projectId ? eq(approval.project_id, projectId) : undefined,
                  query.task ? eq(approval.task_id, query.task) : undefined,
                  query.scope === 'instance' ? isNull(approval.project_id) : undefined,
                  before(approval.id, cursor),
                ),
              )
              .orderBy(desc(approval.id))
              .limit(size)
              .all(),
          query,
          (row) => seesApproval(call.principal, row),
        )

        return {
          items: page.rows.map((row) => select(kit.views.approval, row, kit.fields(query.fields))),
          next_cursor: page.next_cursor,
        }
      },
      {
        operation: {
          id: 'list_approvals',
          summary:
            'List the approvals the caller can see (default status waiting; status=all for every row)',
          level: 'any',
          cli: {
            path: ['approvals', 'list'],
          },
        },
        query: t.Object({
          ...listQuery,
          status: t.Optional(
            t.String({
              description: `One of ${approvalStatusValues.join(', ')}, or all (default waiting)`,
            }),
          ),
          source: filterOne(approvalSourceValues),
          project: t.Optional(
            t.String({
              description: "Only the approvals of this project's production, by id or name",
            }),
          ),
          task: t.Optional(
            t.String({
              description: 'Only the approvals of this task id',
            }),
          ),
          scope: t.Optional(t.Literal('instance')),
        }),
        response: replies({
          200: Page(Approval),
        }),
      },
    )
    .get(
      '/approvals/:approval',
      async ({ ctx, query, request }) => {
        const call = await kit.call(request)

        if (!seesApproval(call.principal, ctx.approval)) {
          notFound('approval', ctx.approval.id)
        }

        return select(kit.views.approval, ctx.approval, kit.fields(query.fields) ?? full)
      },
      {
        approval: {
          id: 'get_approval',
          summary: 'Get an approval with its diff',
          level: 'read',
        },
        query: t.Object(getQuery),
        response: replies({
          200: Approval,
        }),
      },
    )
    .post(
      '/approvals/:approval/decision',
      async ({ ctx, request, body }) => {
        const call = await kit.call(request)

        authorizeDecision(call.principal, ctx)

        if (ctx.approval.task_id) {
          const row = await decideShip(
            {
              db,
              github: kit.deps.github,
            },
            call,
            ctx.approval,
            {
              approve: body.decision === 'approve',
              reason: body.reason ?? null,
            },
          )

          return {
            ...decided(row),
            deployments: [],
          }
        }

        if (body.decision === 'approve') {
          return approve(call, ctx.approval)
        }

        return {
          ...decided(rejectApproval(kit.deps, call, ctx.approval, body.reason ?? null)),
          deployments: [],
        }
      },
      {
        approval: {
          id: 'decide_approval',
          summary:
            "Approve a change to production, which applies its diff or merges its task's pull request, or reject it with a reason; a human, and an admin in production",
          level: 'deploy',
          mcp: false,
          cli: {
            path: ['approvals', 'decide'],
          },
        },
        body: t.Object(
          {
            decision: t.Union([t.Literal('approve'), t.Literal('reject')]),
            reason: t.Optional(
              t.String({
                maxLength: 2000,
                description: 'Why the change is rejected, kept with the approval',
              }),
            ),
          },
          {
            additionalProperties: false,
          },
        ),
        response: replies({
          200: Decided,
        }),
      },
    )
}
