import { Type, type Static } from '@sinclair/typebox'
import { and, asc, desc, eq, isNotNull, isNull } from 'drizzle-orm'
import { t } from 'elysia'

import {
  grantSourceValues,
  keyNamePattern,
  Nullable,
  StringEnum,
  targetKindValues,
} from '@stationly/protocol'

import { deployment, grant, key, project, secret_value } from '../../db/schema.ts'
import { readSetting } from '../../db/settings.ts'
import type { EnvSnapshot } from '../../secrets/deploy.ts'
import { leaves } from '../../secrets/resolve.ts'
import { keysOf, type ValueTarget } from '../../secrets/values.ts'
import { can } from '../access.ts'
import { ChangeSet, commit, type CommitResult } from '../changes.ts'
import { audit, type Call } from '../context.ts'
import { fail, notFound } from '../errors.ts'
import { projectAll, project as select } from '../fields.ts'
import type { Kit } from '../kit.ts'
import {
  appById,
  isProduction,
  keyById,
  productionOf,
  projectByRef,
  type TargetRow,
} from '../lookup.ts'
import { getQuery } from '../pagination.ts'
import { Resolved, resolvedView } from '../resolved.ts'
import type { TargetInput } from '../route-meta.ts'
import { input, KeysPatch } from '../schemas.ts'
import {
  Approval,
  ApprovalDetail,
  Change,
  component,
  extend,
  Key,
  Page,
  replies,
  SecretValue,
  Warnings,
} from '../shapes.ts'
import {
  refreshStale,
  staleDependents,
  type StaleDependent as StaleDependentRow,
} from '../stale.ts'
import { dependentsOf, planKeys, type KeyItem, type KeyScope } from '../variable-changes.ts'

const StaleDependent = Type.Object(
  {
    app_id: Type.String(),
    project_id: Type.String(),
    preview_id: Nullable(Type.String()),
    keys: Type.Array(Type.String()),
  },
  {
    additionalProperties: false,
  },
)

const ApprovalWithChanges = extend(Approval, {
  changes: Type.Array(Change),
})

const applied = {
  deployments: Type.Array(Type.String()),
  approvals: Type.Array(ApprovalWithChanges),
}

const Applied = Type.Object(applied, {
  additionalProperties: false,
})

const KeysOutcome = component(
  'KeysOutcome',
  Type.Object(
    {
      keys: Type.Array(Key),
      stale_dependents: Type.Array(StaleDependent),
      ...applied,
    },
    {
      additionalProperties: false,
    },
  ),
)

const DeletedWithStale = Type.Object(
  {
    deleted: Type.Literal(true),
    stale_dependents: Type.Array(StaleDependent),
  },
  {
    additionalProperties: false,
  },
)

const Grant = Type.Object(
  {
    id: Type.String(),
    key_id: Type.String(),
    project_id: Type.String(),
    alias: Nullable(Type.String()),
    source: StringEnum(grantSourceValues),
  },
  {
    title: 'Grant',
    additionalProperties: false,
  },
)

const RevokedValue = extend(SecretValue, {
  warnings: Warnings,
})

const keysReplies = replies({
  200: KeysOutcome,
  202: ApprovalDetail,
})

type PatchInput = {
  set?: KeyItem[]
  unset?: string[]
  apply?: boolean
  allow_unresolved?: boolean
}

export const keyRoutes = (kit: Kit) => {
  const { db, keyring } = kit.deps
  const list = (rows: (typeof key.$inferSelect)[], fields?: string) => ({
    items: projectAll(kit.views.key, rows, kit.fields(fields)),
    next_cursor: null,
  })

  const staleFor = (projectId: string | null) => staleDependents(db, projectId)

  const applyStale = (call: Call, dependents: StaleDependentRow[]) => {
    const deployments: string[] = []
    const waiting: Static<typeof ApprovalWithChanges>[] = []

    for (const dependent of dependents) {
      const ctx = appById(db, dependent.app_id)

      if (!can(call.principal, ctx.target, 'deploy')) {
        continue
      }

      const changes = new ChangeSet()

      changes.deploy(ctx.app.id, 'key_change', {
        reason: `${dependent.keys.join(', ')} changed`,
        supersede: true,
      })
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
        deployments.push(...result.deployments)
      } else {
        waiting.push(
          select(kit.views.approval, result.approval, kit.fields('changes')) as Static<
            typeof ApprovalWithChanges
          >,
        )
      }
    }

    return {
      deployments,
      approvals: waiting,
    }
  }

  const finish = (
    call: Call,
    set: { status?: number | string },
    result: CommitResult,
    input: PatchInput,
    projectId: string | null,
    ids: () => string[],
  ) => {
    if (!result.applied) {
      return kit.approvalBody(result, set)
    }

    const stale_dependents = staleFor(projectId)
    const appliedStale = input.apply
      ? applyStale(call, stale_dependents)
      : {
          deployments: [],
          approvals: [],
        }
    const keys = ids()
      .map((id) => db.select().from(key).where(eq(key.id, id)).get())
      .filter((row): row is typeof key.$inferSelect => row !== undefined)
      .map((row) => select(kit.views.key, row, undefined))

    return {
      keys,
      stale_dependents,
      deployments: appliedStale.deployments,
      approvals: appliedStale.approvals,
    }
  }

  const patch = (
    call: Call,
    scope: KeyScope,
    targetRow: TargetRow | null,
    protect: boolean,
    input: PatchInput,
    set: { status?: number | string },
    projectId: string | null,
  ) => {
    const changes = new ChangeSet()

    planKeys(db, keyring, call.principal, changes, scope, input)

    if (changes.empty) {
      return {
        keys: [],
        stale_dependents: [],
        deployments: [],
        approvals: [],
      }
    }

    const result = commit(
      kit.deps,
      call,
      {
        target: targetRow,
        protect,
      },
      changes,
    )

    return finish(call, set, result, input, projectId, () =>
      result.applied
        ? [
            ...Object.values(result.refs),
            ...changes.changes
              .filter((c) => c.op === 'update')
              .map((c) => (c.op === 'update' ? c.id : '')),
          ].filter((id) => id.startsWith('key_'))
        : [],
    )
  }

  const pinCount = (secretValueId: string) =>
    db
      .select({
        id: deployment.id,
        env_snapshot: deployment.env_snapshot,
      })
      .from(deployment)
      .where(eq(deployment.status, 'active'))
      .all()
      .filter((d) =>
        ((d.env_snapshot as EnvSnapshot).entries ?? []).some((e) =>
          leaves(e.node).some((l) => l.kind === 'value' && l.secret_value_id === secretValueId),
        ),
      )
      .map((d) => d.id)

  const valueTargetQuery = t.Optional(
    input(
      StringEnum(targetKindValues, {
        description: 'production (default) or preview: the value every preview reads',
      }),
    ),
  )

  const projectScope = (projectRef: string, valueTarget: ValueTarget | undefined) => {
    const proj = projectByRef(db, projectRef)
    const chosen = valueTarget ?? 'production'

    return {
      proj,
      valueTarget: chosen,
      target: {
        project_id: proj.id,
        target: chosen === 'production' ? 'production' : 'previews',
      },
    }
  }

  return kit
    .router('keys', '/v1')
    .get(
      '/apps/:app/keys',
      ({ ctx, query }) => {
        return list(
          keysOf(db, {
            scope: 'app',
            id: ctx.app.id,
          })
            .orderBy(asc(key.name))
            .all(),
          query.fields,
        )
      },
      {
        app: {
          id: 'list_app_keys',
          summary: 'List the keys of an app; values are never listed',
          level: 'read',
        },
        query: t.Object(getQuery),
        response: replies({
          200: Page(Key),
        }),
      },
    )
    .get(
      '/projects/:project/keys',
      ({ ctx, query }) => {
        const proj = ctx.project
        let rows = keysOf(db, {
          scope: 'project',
          id: proj.id,
        })
          .orderBy(asc(key.name))
          .all()

        if (query.target) {
          const wanted = query.target

          rows = rows.filter((row) =>
            db
              .select({
                id: secret_value.id,
              })
              .from(secret_value)
              .where(and(eq(secret_value.key_id, row.id), eq(secret_value.target, wanted)))
              .get(),
          )
        }

        return list(rows, query.fields)
      },
      {
        project: {
          id: 'list_project_keys',
          summary: 'List project keys',
          level: 'read',
          cli: {
            path: ['keys', 'list'],
          },
        },
        query: t.Object({
          ...getQuery,
          target: valueTargetQuery,
        }),
        response: replies({
          200: Page(Key),
        }),
      },
    )
    .get(
      '/global-keys',
      ({ query }) => {
        return list(
          keysOf(db, {
            scope: 'global',
          })
            .orderBy(asc(key.name))
            .all(),
          query.fields,
        )
      },
      {
        operation: {
          id: 'list_global_keys',
          summary: 'List global keys',
          level: 'instance read',
        },
        query: t.Object(getQuery),
        response: replies({
          200: Page(Key),
        }),
      },
    )
    .get(
      '/keys/:id',
      ({ ctx, query }) => {
        return select(kit.views.key, ctx.key, kit.fields(query.fields))
      },
      {
        key: {
          id: 'get_key',
          summary: 'Get a key; never its value',
          level: 'read',
        },
        query: t.Object(getQuery),
        response: replies({
          200: Key,
        }),
      },
    )
    .get(
      '/keys/:id/versions',
      ({ ctx, query }) => {
        const rows = db
          .select()
          .from(secret_value)
          .where(
            and(
              eq(secret_value.key_id, ctx.key.id),
              query.target === undefined ? undefined : eq(secret_value.target, query.target),
              query.revoked === undefined
                ? undefined
                : query.revoked
                  ? isNotNull(secret_value.revoked_at)
                  : isNull(secret_value.revoked_at),
            ),
          )
          .orderBy(desc(secret_value.version))
          .all()

        return {
          items: projectAll(kit.views.secretValue, rows, kit.fields(query.fields)),
          next_cursor: null,
        }
      },
      {
        key: {
          id: 'list_key_versions',
          summary: 'List the versions of a key; never their values',
          level: 'read',
        },
        query: t.Object({
          ...getQuery,
          target: valueTargetQuery,
          revoked: t.Optional(
            t.BooleanString({
              description: 'Only revoked versions, or with false only live ones',
            }),
          ),
        }),
        response: replies({
          200: Page(SecretValue),
        }),
      },
    )
    .patch(
      '/apps/:app/keys',
      async ({ ctx, request, body, set }) => {
        const call = await kit.call(request)
        const { target: valueTarget, ...input } = body

        return patch(
          call,
          {
            scope: 'app',
            parent: ctx.app.id,
            appId: ctx.app.id,
            valueTarget: valueTarget ?? 'production',
            target: ctx.target,
          },
          ctx.target_row,
          isProduction(ctx.target_row),
          input,
          set,
          ctx.project.id,
        )
      },
      {
        app: {
          id: 'set_app_keys',
          summary: 'Set and unset app keys',
          level: 'deploy',
        },
        body: t.Object(
          {
            target: valueTargetQuery,
            ...KeysPatch,
          },
          {
            additionalProperties: false,
          },
        ),
        response: keysReplies,
      },
    )
    .patch(
      '/projects/:project/keys',
      async ({ request, params, body, set }) => {
        const call = await kit.call(request)
        const { target: chosen, ...input } = body
        const { proj, valueTarget, target } = projectScope(params.project, chosen)

        return patch(
          call,
          {
            scope: 'project',
            parent: proj.id,
            valueTarget,
            target,
          },
          productionOf(db, proj.id),
          valueTarget === 'production',
          input,
          set,
          proj.id,
        )
      },
      {
        operation: {
          id: 'set_project_keys',
          summary:
            "Set and unset project keys: production's values, which wait for approval, or the preview values every preview reads",
          level: 'admin',
          target: ({ params, body }: TargetInput) =>
            projectScope(params.project!, (body as { target?: ValueTarget }).target).target,
        },
        body: t.Object(
          {
            target: valueTargetQuery,
            ...KeysPatch,
          },
          {
            additionalProperties: false,
          },
        ),
        response: keysReplies,
      },
    )
    .patch(
      '/global-keys',
      async ({ request, body, set }) => {
        const call = await kit.call(request)
        const protect = readSetting(db, 'platform.protected') && !call.principal.human

        return patch(
          call,
          {
            scope: 'global',
            target: {
              project_id: '*',
              target: '*',
            },
          },
          null,
          protect,
          body,
          set,
          null,
        )
      },
      {
        operation: {
          id: 'set_global_keys',
          summary: 'Set and unset global keys',
          level: 'instance admin',
        },
        body: t.Object(KeysPatch, {
          additionalProperties: false,
        }),
        response: keysReplies,
      },
    )
    .delete(
      '/keys/:id',
      async ({ ctx, request, set }) => {
        const call = await kit.call(request)
        const changes = new ChangeSet()
        let place: TargetRow | null = null
        let scope: KeyScope

        if (ctx.key.scope === 'app') {
          const svc = appById(db, ctx.key.app_id!)

          place = svc.target_row
          scope = {
            scope: 'app',
            parent: svc.app.id,
            appId: svc.app.id,
            valueTarget: 'production',
            target: svc.target,
          }
        } else if (ctx.key.scope === 'project') {
          place = productionOf(db, ctx.key.project_id!)
          scope = {
            scope: 'project',
            parent: ctx.key.project_id!,
            valueTarget: 'production',
            target: ctx.target,
          }
        } else {
          scope = {
            scope: 'global',
            target: ctx.target,
          }
        }

        planKeys(db, keyring, call.principal, changes, scope, {
          unset: [ctx.key.name],
        })
        const protect = place
          ? isProduction(place)
          : ctx.key.scope === 'global' &&
            readSetting(db, 'platform.protected') &&
            !call.principal.human
        const result = commit(
          kit.deps,
          call,
          {
            target: place,
            protect,
          },
          changes,
        )

        if (!result.applied) {
          return kit.approvalBody(result, set)
        }

        return {
          deleted: true as const,
          stale_dependents: staleFor(ctx.key.project_id),
        }
      },
      {
        key: {
          id: 'delete_key',
          summary: 'Delete a key',
          level: 'deploy',
        },
        response: replies({
          200: DeletedWithStale,
          202: ApprovalDetail,
        }),
      },
    )
    .post(
      '/keys/:id/apply',
      async ({ request, params }) => {
        const call = await kit.call(request)
        const ctx = keyById(db, params.id)
        const apps = new Set(dependentsOf(db, ctx.key).map((dep) => dep.app_id))

        if (ctx.key.app_id) {
          apps.add(ctx.key.app_id)
        }

        const dependents = staleDependents(db, ctx.key.project_id, apps)
        const result = applyStale(call, dependents)

        return {
          deployments: result.deployments,
          approvals: result.approvals,
        }
      },
      {
        operation: {
          id: 'apply_key_changes',
          summary: 'Redeploy every stale dependent of a key',
          level: 'any',
          cli: {
            path: ['keys', 'apply'],
          },
        },
        response: replies({
          200: Applied,
        }),
      },
    )
    .post(
      '/secret-values/:id/revoke',
      async ({ ctx, request, body }) => {
        const call = await kit.call(request)
        const pinnedBy = pinCount(ctx.secretValue.id)

        if (pinnedBy.length && !body?.force) {
          fail(
            'SECRET_VERSION_IN_USE',
            `Version ${ctx.secretValue.version} of ${ctx.key.name} is pinned by active deployments.`,
            'Deploy a newer version first, or send force = true; a restart of those apps will then fail.',
            {
              deployments: pinnedBy,
            },
          )
        }

        db.update(secret_value)
          .set({
            revoked_at: new Date(),
          })
          .where(eq(secret_value.id, ctx.secretValue.id))
          .run()
        refreshStale(db)
        audit(
          db,
          call,
          'secret.revoke',
          {
            entity: 'secret_value',
            id: ctx.secretValue.id,
          },
          {
            after: {
              key_id: ctx.key.id,
              version: ctx.secretValue.version,
              force: Boolean(body?.force),
            },
          },
        )
        const row = db
          .select()
          .from(secret_value)
          .where(eq(secret_value.id, ctx.secretValue.id))
          .get()!

        return {
          ...select(kit.views.secretValue, row, undefined),
          warnings: pinnedBy.length
            ? [
                {
                  code: 'STALE_SECRET_VERSIONS',
                  explanation: `Restarting ${pinnedBy.join(', ')} will fail.`,
                },
              ]
            : [],
        }
      },
      {
        secret_value: {
          id: 'revoke_secret_version',
          summary: 'Revoke a secret version',
          level: 'admin',
          mcp: {
            destructive: true,
          },
        },
        body: t.Optional(
          t.Object(
            {
              force: t.Optional(
                t.Boolean({
                  description:
                    'Revoke a version current deployments still use; their next restart fails (default false)',
                }),
              ),
            },
            {
              additionalProperties: false,
            },
          ),
        ),
        response: replies({
          200: RevokedValue,
        }),
      },
    )
    .post(
      '/secret-values/:id/restore',
      async ({ ctx, request }) => {
        const call = await kit.call(request)

        db.update(secret_value)
          .set({
            revoked_at: null,
          })
          .where(eq(secret_value.id, ctx.secretValue.id))
          .run()
        refreshStale(db)
        audit(
          db,
          call,
          'secret.restore',
          {
            entity: 'secret_value',
            id: ctx.secretValue.id,
          },
          {
            after: {
              key_id: ctx.key.id,
              version: ctx.secretValue.version,
            },
          },
        )

        return select(
          kit.views.secretValue,
          db.select().from(secret_value).where(eq(secret_value.id, ctx.secretValue.id)).get()!,
          undefined,
        )
      },
      {
        secret_value: {
          id: 'restore_secret_version',
          summary: 'Undo a revocation',
          level: 'admin',
          mcp: false,
        },
        response: replies({
          200: SecretValue,
        }),
      },
    )
    .get(
      '/apps/:app/keys/resolved',
      async ({ ctx, request, query }) => {
        const call = await kit.call(request)

        return resolvedView(kit, call, ctx, {
          admin: can(call.principal, ctx.target, 'admin'),
          compareWith: query.deployment,
        }) as Static<typeof Resolved>
      },
      {
        app: {
          id: 'get_resolved_keys',
          summary: 'The resolved keys of the next deployment; sealed values never appear',
          level: 'read',
        },
        query: t.Object({
          deployment: t.Optional(
            t.String({
              description: 'Compare against this deployment instead of the current one',
            }),
          ),
        }),
        response: replies({
          200: Resolved,
        }),
      },
    )
    .get(
      '/keys/:id/grants',
      ({ params }) => {
        const ctx = keyById(db, params.id)
        const rows = db
          .select()
          .from(grant)
          .where(eq(grant.key_id, ctx.key.id))
          .orderBy(desc(grant.id))
          .all()

        return {
          items: rows.map((g) => ({
            id: g.id,
            key_id: g.key_id,
            project_id: g.project_id,
            alias: g.alias,
            source: g.source,
          })),
          next_cursor: null,
        }
      },
      {
        operation: {
          id: 'list_grants',
          summary: 'List the grants of a global key',
          level: 'instance read',
        },
        response: replies({
          200: Page(Grant),
        }),
      },
    )
    .post(
      '/keys/:id/grants',
      async ({ request, params, body, set }) => {
        const call = await kit.call(request)
        const ctx = keyById(db, params.id)

        if (ctx.key.scope !== 'global') {
          fail('VALIDATION_FAILED', 'Only global keys are granted.', undefined, {
            issues: [
              {
                path: '/id',
                message: `key is ${ctx.key.scope}`,
              },
            ],
          })
        }

        const proj =
          db.select().from(project).where(eq(project.id, body.project_id)).get() ??
          notFound('project', body.project_id)
        const name = body.alias ?? ctx.key.name
        const taken = db
          .select({
            alias: grant.alias,
            name: key.name,
          })
          .from(grant)
          .innerJoin(key, eq(key.id, grant.key_id))
          .where(eq(grant.project_id, proj.id))
          .all()
          .some((g) => (g.alias ?? g.name) === name)

        if (taken) {
          fail(
            'NAME_TAKEN',
            `Project ${proj.name} already holds a grant named ${name}.`,
            undefined,
            {
              alias: name,
            },
          )
        }

        const id = db
          .insert(grant)
          .values({
            key_id: ctx.key.id,
            project_id: proj.id,
            alias: body.alias ?? null,
            source: 'manual',
          })
          .returning({
            id: grant.id,
          })
          .get().id

        refreshStale(db)
        audit(
          db,
          call,
          'grant.create',
          {
            entity: 'grant',
            id,
          },
          {
            after: {
              key_id: ctx.key.id,
              project_id: proj.id,
              alias: body.alias ?? null,
            },
          },
        )
        set.status = 201

        return {
          id,
          key_id: ctx.key.id,
          project_id: proj.id,
          alias: body.alias ?? null,
          source: 'manual' as const,
        }
      },
      {
        operation: {
          id: 'grant_key',
          summary: 'Grant a global key to a project',
          level: 'instance admin',
        },
        body: t.Object(
          {
            project_id: t.String({
              description: 'The project to grant the key to',
            }),
            alias: t.Optional(
              t.String({
                pattern: keyNamePattern,
                description: 'The key inside the project, when the global key would collide',
              }),
            ),
          },
          {
            additionalProperties: false,
          },
        ),
        response: replies({
          201: Grant,
        }),
      },
    )
    .delete(
      '/grants/:id',
      async ({ request, params }) => {
        const call = await kit.call(request)
        const row =
          db.select().from(grant).where(eq(grant.id, params.id)).get() ??
          notFound('grant', params.id)

        db.delete(grant).where(eq(grant.id, row.id)).run()
        refreshStale(db)
        audit(
          db,
          call,
          'grant.delete',
          {
            entity: 'grant',
            id: row.id,
          },
          {
            before: {
              key_id: row.key_id,
              project_id: row.project_id,
              alias: row.alias,
            },
          },
        )

        return {
          deleted: true as const,
          stale_dependents: staleFor(row.project_id),
        }
      },
      {
        operation: {
          id: 'revoke_grant',
          summary: 'Revoke a grant',
          level: 'instance admin',
        },
        response: replies({
          200: DeletedWithStale,
        }),
      },
    )
}
