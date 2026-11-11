import { Type } from '@sinclair/typebox'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { t } from 'elysia'

import {
  buildStatusValues,
  deploymentPastCutoverStatuses,
  deploymentTerminalStatuses,
} from '@stationly/protocol'

import { build, deployment, deployment_step, secret_value } from '../../db/schema.ts'
import { snapshotOf, type EnvSnapshot } from '../../secrets/deploy.ts'
import { leaves } from '../../secrets/resolve.ts'
import { ChangeSet, commit } from '../changes.ts'
import { requireStationReady } from '../deployments.ts'
import { buildDiagnosis, deploymentDiagnosis } from '../diagnosis.ts'
import { ApiError, fail, notFound } from '../errors.ts'
import { project as select } from '../fields.ts'
import { warning, type Kit } from '../kit.ts'
import { type DeploymentRow, type ServiceContext } from '../lookup.ts'
import { before, collect, filterOne, getQuery, listQuery } from '../pagination.ts'
import { supersede } from '../schemas.ts'
import {
  Build,
  Deployment,
  DeploymentCreated,
  DeploymentStep,
  Diagnosis,
  extend,
  Page,
  replies,
  Staged,
} from '../shapes.ts'

const Waited = extend(Deployment, {
  done: Type.Boolean(),
})
const deployReplies = replies({
  201: DeploymentCreated,
  202: Staged,
})

const waitPollMs = 200
const cutoverReached = new Set<string>([
  ...deploymentPastCutoverStatuses,
  ...deploymentTerminalStatuses,
])

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)

    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), {
      once: true,
    })
  })

const leafVersions = (snapshot: EnvSnapshot) => {
  const out = new Map<string, { key: string; secret_value_id: string; version: number }>()

  for (const entry of snapshot.entries) {
    for (const leaf of leaves(entry.node)) {
      if (leaf.kind === 'value') {
        out.set(`${leaf.variable_id}|${leaf.environment_id ?? ''}`, {
          key: entry.key,
          secret_value_id: leaf.secret_value_id,
          version: leaf.version,
        })
      }
    }
  }

  return out
}

export const deployActionRoutes = (kit: Kit) => {
  const { db } = kit.deps
  const view = (id: string, fields?: string) =>
    select(
      kit.views.deployment,
      db.select().from(deployment).where(eq(deployment.id, id)).get()!,
      kit.fields(fields),
    )

  const redactorFor = (
    deploymentIds: string[],
    principal: { actor: Parameters<Kit['redaction']>[1] },
    requestId: string,
  ) => kit.redaction(deploymentIds, principal.actor, requestId)

  const deployOne = (
    call: Awaited<ReturnType<Kit['call']>>,
    ctx: ServiceContext,
    set: { status?: number | string },
    trigger: 'redeploy' | 'manual' | 'rollback' | 'base_image',
    extra: Record<string, unknown>,
    warnings: { code: string; explanation: string }[] = [],
  ) => {
    requireStationReady(db, ctx.service.station_id)
    const changes = new ChangeSet()

    changes.deploy(ctx.service.id, trigger, extra)
    const result = commit(
      kit.deps,
      call,
      {
        environment: ctx.environment,
        protect: ctx.environment.protected,
      },
      changes,
    )

    if (!result.applied) {
      return kit.stagedBody(result, set)
    }

    set.status = 201
    const created = view(result.deployments[0]!)
    const downtime =
      created.strategy === 'replace'
        ? [
            warning(
              'DOWNTIME_EXPECTED',
              'strategy = replace stops the old container before the new one is healthy.',
            ),
          ]
        : []

    return {
      ...created,
      warnings: [...warnings, ...downtime],
    }
  }

  const rollbackTarget = (ctx: ServiceContext, ref: string | undefined): DeploymentRow => {
    if (ref) {
      const byId = ref.startsWith('dep_')
        ? db
            .select()
            .from(deployment)
            .where(and(eq(deployment.id, ref), eq(deployment.service_id, ctx.service.id)))
            .get()
        : /^\d+$/.test(ref)
          ? db
              .select()
              .from(deployment)
              .where(
                and(eq(deployment.number, Number(ref)), eq(deployment.service_id, ctx.service.id)),
              )
              .get()
          : undefined

      return byId ?? notFound('deployment', ref)
    }

    return (
      db
        .select()
        .from(deployment)
        .where(and(eq(deployment.service_id, ctx.service.id), eq(deployment.status, 'superseded')))
        .orderBy(desc(deployment.number))
        .limit(1)
        .get() ??
      fail(
        'NO_CURRENT_DEPLOYMENT',
        `${ctx.service.name} has no earlier deployment to roll back to.`,
        'Name a deployment with deployment_id.',
      )
    )
  }

  const checkRollback = (ctx: ServiceContext, target: DeploymentRow, confirm: boolean) => {
    if (target.id === ctx.service.current_deployment_id) {
      fail(
        'VALIDATION_FAILED',
        `Deployment ${target.number} is already current.`,
        'Name an earlier deployment.',
        {
          issues: [
            {
              path: '/deployment_id',
              message: 'already current',
            },
          ],
        },
      )
    }

    if (!target.image_ref || !['active', 'superseded'].includes(target.status)) {
      fail(
        'VALIDATION_FAILED',
        `Deployment ${target.number} is ${target.status} and never ran an image.`,
        'Roll back to a deployment that reached active.',
        {
          issues: [
            {
              path: '/deployment_id',
              message: target.status,
            },
          ],
        },
      )
    }

    if (target.image_pruned_at) {
      fail(
        'IMAGE_PRUNED',
        `The image of deployment ${target.number} was pruned from Depot at ${target.image_pruned_at.toISOString()}.`,
        'Rebuild the service from source instead.',
        {
          deployment_id: target.id,
          image_ref: target.image_ref,
        },
      )
    }

    const pinned = leafVersions(target.env_snapshot as EnvSnapshot)
    const ids = [...pinned.values()].map((p) => p.secret_value_id)
    const rows = ids.length
      ? db
          .select({
            id: secret_value.id,
            revoked_at: secret_value.revoked_at,
          })
          .from(secret_value)
          .where(inArray(secret_value.id, ids))
          .all()
      : []
    const usable = new Set(rows.filter((r) => !r.revoked_at).map((r) => r.id))
    const revokedKeys = [
      ...new Set(
        [...pinned.values()].filter((p) => !usable.has(p.secret_value_id)).map((p) => p.key),
      ),
    ]

    if (revokedKeys.length) {
      fail(
        'ROLLBACK_SECRET_REVOKED',
        `Deployment ${target.number} pins secret versions that were revoked or swept: ${revokedKeys.join(', ')}.`,
        'Restore the versions with revoke_secret_version undo, or deploy with current values.',
        {
          keys: revokedKeys,
        },
      )
    }

    let heads: ReturnType<typeof leafVersions>

    try {
      heads = leafVersions(snapshotOf(db, ctx.service.id))
    } catch {
      heads = new Map()
    }

    const stale = [
      ...new Set(
        [...pinned.entries()]
          .filter(
            ([k, v]) => heads.get(k)?.version !== undefined && heads.get(k)!.version !== v.version,
          )
          .map(([, v]) => v.key),
      ),
    ]

    if (stale.length && !confirm) {
      fail(
        'STALE_SECRETS_CONFIRM_REQUIRED',
        `Deployment ${target.number} pins secret versions older than the current heads for ${stale.join(', ')}.`,
        'Send confirm_stale_secrets = true (sly rollback --confirm-stale-secrets) to roll back with those older values.',
        {
          keys: stale,
        },
      )
    }

    return stale.length
      ? [
          {
            ...warning(
              'STALE_SECRET_VERSIONS',
              `The rollback runs older secret versions for ${stale.join(', ')}.`,
            ),
            details: {
              keys: stale,
            },
          },
        ]
      : []
  }

  return kit
    .router('deployments', '/v1')
    .get(
      '/deployments/:id/wait',
      async ({ ctx, request, query }) => {
        const timeoutMs = Math.min(query.timeout_s ?? 10, 10) * 1000
        const until = query.until ?? 'terminal'
        const reached = (status: string) =>
          until === 'cutover'
            ? cutoverReached.has(status)
            : (deploymentTerminalStatuses as readonly string[]).includes(status)
        const deadline = Date.now() + timeoutMs
        let row = ctx.deployment

        while (!reached(row.status) && Date.now() < deadline && !request.signal.aborted) {
          await sleep(Math.min(waitPollMs, deadline - Date.now()), request.signal)
          row = db.select().from(deployment).where(eq(deployment.id, row.id)).get()!
        }

        return {
          ...select(kit.views.deployment, row, kit.fields(query.fields)),
          done: reached(row.status),
        }
      },
      {
        deployment: {
          id: 'wait_for_deployment',
          summary: 'Wait up to 10 s for a deployment to reach a terminal state or cutover',
          level: 'read',
          mcp: {
            always_load: true,
            poll: true,
          },
          cli: {
            path: ['deployments', 'wait'],
            render: 'deployment',
          },
        },
        query: t.Object({
          timeout_s: t.Optional(
            t.Numeric({
              minimum: 0,
              maximum: 10,
            }),
          ),
          until: t.Optional(
            t.Union([t.Literal('terminal'), t.Literal('cutover')], {
              description: 'Wait for a terminal state (default) or for cutover',
            }),
          ),
          ...getQuery,
        }),
        response: replies({
          200: Waited,
        }),
      },
    )
    .get(
      '/deployments/:id/steps',
      ({ ctx }) => {
        const items = db
          .select()
          .from(deployment_step)
          .where(eq(deployment_step.deployment_id, ctx.deployment.id))
          .orderBy(asc(deployment_step.created_at))
          .all()
          .map((s) => ({
            id: s.id,
            step: s.step,
            status: s.status,
            attempt: s.attempt,
            detail: s.detail,
            started_at: s.started_at?.toISOString() ?? null,
            finished_at: s.finished_at?.toISOString() ?? null,
          }))

        return {
          items,
          next_cursor: null,
        }
      },
      {
        deployment: {
          id: 'list_deployment_steps',
          summary: 'Deployment steps in step order',
          level: 'read',
          mcp: false,
        },
        response: replies({
          200: Page(DeploymentStep),
        }),
      },
    )
    .get(
      '/deployments/:id/diagnosis',
      async ({ ctx, request }) => {
        const call = await kit.call(request)

        return (
          deploymentDiagnosis(
            db,
            ctx.deployment,
            redactorFor([ctx.deployment.id], call.principal, call.request_id),
          ) ??
          fail(
            'NOT_FOUND',
            `Deployment ${ctx.deployment.number} is ${ctx.deployment.status}; only failed deployments have a diagnosis.`,
            'Call wait_for_deployment and read the status.',
            {
              status: ctx.deployment.status,
            },
          )
        )
      },
      {
        deployment: {
          id: 'get_deployment_diagnosis',
          summary: 'The diagnosis object of a failed deployment',
          level: 'read',
          mcp: {
            always_load: true,
          },
          cli: {
            path: ['deployments', 'diagnosis'],
          },
        },
        response: replies({
          200: Diagnosis,
        }),
      },
    )
    .post(
      '/services/:service/redeploy',
      async ({ ctx, request, body, set }) => {
        const call = await kit.call(request)

        if (!ctx.service.current_deployment_id) {
          fail(
            'NO_CURRENT_DEPLOYMENT',
            `${ctx.service.name} has no current deployment to redeploy.`,
            'Call deploy (POST /v1/services/{service}/deployments) first.',
          )
        }

        return deployOne(call, ctx, set, 'redeploy', {
          supersede: body?.supersede ?? false,
        })
      },
      {
        service: {
          id: 'redeploy',
          summary: 'Redeploy the current image with current variables',
          level: 'deploy',
          cli: {
            wait: 'wait_for_deployment',
          },
        },
        body: t.Optional(
          t.Object(
            {
              supersede,
            },
            {
              additionalProperties: false,
            },
          ),
        ),
        response: deployReplies,
      },
    )
    .post(
      '/services/:service/rebuild',
      async ({ ctx, request, body, set }) => {
        const call = await kit.call(request)

        if (!ctx.service.current_deployment_id) {
          fail(
            'NO_CURRENT_DEPLOYMENT',
            `${ctx.service.name} has no current deployment to rebuild.`,
            'Call deploy (POST /v1/services/{service}/deployments) first.',
          )
        }

        if ((ctx.service.source as { type: string }).type === 'image') {
          fail(
            'SOURCE_UNREACHABLE',
            `${ctx.service.name} deploys an image and has no source to rebuild.`,
            'Use redeploy, or deploy a new image.',
          )
        }

        return deployOne(call, ctx, set, 'base_image', {
          supersede: body?.supersede ?? false,
          reason: 'rebuild',
        })
      },
      {
        service: {
          id: 'rebuild_service',
          summary: 'Rebuild from the same source and deploy',
          level: 'deploy',
          cli: {
            path: ['services', 'rebuild'],
            wait: 'wait_for_deployment',
          },
        },
        body: t.Optional(
          t.Object(
            {
              supersede,
            },
            {
              additionalProperties: false,
            },
          ),
        ),
        response: deployReplies,
      },
    )
    .post(
      '/services/:service/rollback',
      async ({ ctx, request, body, set }) => {
        const call = await kit.call(request)
        const target = rollbackTarget(ctx, body?.deployment_id)
        const warnings = checkRollback(ctx, target, body?.confirm_stale_secrets ?? false)

        return deployOne(
          call,
          ctx,
          set,
          'rollback',
          {
            rollback_of: target.id,
            supersede: false,
          },
          warnings,
        )
      },
      {
        service: {
          id: 'rollback',
          summary: 'Roll back to a previous deployment',
          level: 'deploy',
          mcp: {
            destructive: true,
          },
          cli: {
            wait: 'wait_for_deployment',
          },
        },
        body: t.Optional(
          t.Object(
            {
              deployment_id: t.Optional(
                t.String({
                  description:
                    'The deployment to roll back to; the one before the current by default',
                }),
              ),
              confirm_stale_secrets: t.Optional(
                t.Boolean({
                  description:
                    'Deploy secret versions older than the current ones, instead of STALE_SECRETS_CONFIRM_REQUIRED',
                }),
              ),
            },
            {
              additionalProperties: false,
            },
          ),
        ),
        response: deployReplies,
      },
    )
    .get(
      '/services/:service/builds',
      ({ ctx, query }) => {
        const deploymentIds = db
          .select({
            id: deployment.id,
          })
          .from(deployment)
          .where(eq(deployment.service_id, ctx.service.id))
          .all()
          .map((d) => d.id)
        const page = deploymentIds.length
          ? collect(
              (cursor, size) =>
                db
                  .select()
                  .from(build)
                  .where(
                    and(
                      inArray(build.deployment_id, deploymentIds),
                      query.status ? eq(build.status, query.status as never) : undefined,
                      before(build.id, cursor),
                    ),
                  )
                  .orderBy(desc(build.id))
                  .limit(size)
                  .all(),
              query,
            )
          : {
              rows: [],
              next_cursor: null,
            }

        return {
          items: page.rows.map((row) => select(kit.views.build, row, kit.fields(query.fields))),
          next_cursor: page.next_cursor,
        }
      },
      {
        service: {
          id: 'list_builds',
          summary: 'List the builds of a service',
          level: 'read',
        },
        query: t.Object({
          ...listQuery,
          status: filterOne(buildStatusValues),
        }),
        response: replies({
          200: Page(Build),
        }),
      },
    )
    .get(
      '/builds/:id',
      async ({ ctx, request, query }) => {
        const call = await kit.call(request)
        const b = ctx.build
        const shown = select(kit.views.build, b, kit.fields(query.fields))

        if (b.status === 'failed') {
          const diagnosis = buildDiagnosis(
            b,
            redactorFor([b.deployment_id], call.principal, call.request_id),
          )

          throw new ApiError(
            'BUILD_FAILED',
            `Build ${b.id} failed: ${b.failure?.summary ?? 'no summary'}.`,
            'Read details.diagnosis, fix the source, and deploy again.',
            {
              build: shown,
              diagnosis,
            },
          )
        }

        return shown
      },
      {
        build: {
          id: 'get_build',
          summary: 'Get a build; a failed build answers BUILD_FAILED with its diagnosis',
          level: 'read',
          mcp: false,
        },
        query: t.Object(getQuery),
        response: replies({
          200: Build,
        }),
      },
    )
    .get(
      '/builds/:id/diagnosis',
      async ({ ctx, request }) => {
        const call = await kit.call(request)
        const b = ctx.build

        return (
          buildDiagnosis(b, redactorFor([b.deployment_id], call.principal, call.request_id)) ??
          fail(
            'NOT_FOUND',
            `Build ${b.id} is ${b.status}; only failed builds have a diagnosis.`,
            undefined,
            {
              status: b.status,
            },
          )
        )
      },
      {
        build: {
          id: 'get_build_diagnosis',
          summary: 'The diagnosis object of a failed build',
          level: 'read',
          cli: {
            path: ['deployments', 'build-diagnosis'],
          },
        },
        response: replies({
          200: Diagnosis,
        }),
      },
    )
}
