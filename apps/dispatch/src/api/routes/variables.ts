import { Type, type Static } from '@sinclair/typebox'
import { and, asc, desc, eq, isNotNull, isNull } from 'drizzle-orm'
import { t } from 'elysia'

import {
  environmentVariableNamePattern,
  grantSourceValues,
  idPrefixes,
  Nullable,
  StringEnum,
  targetKindValues,
} from '@stationly/protocol'

import { deployment, environment_variable, grant, project, secret_value } from '../../db/schema.ts'
import { readSetting } from '../../db/settings.ts'
import type { EnvSnapshot } from '../../secrets/deploy.ts'
import { leaves } from '../../secrets/resolve.ts'
import { variablesOf, type ValueTarget } from '../../secrets/values.ts'
import { can } from '../access.ts'
import { ChangeSet, commit, type CommitResult } from '../changes.ts'
import { audit, type Call } from '../context.ts'
import { fail, notFound } from '../errors.ts'
import { projectAll, project as select } from '../fields.ts'
import type { Kit } from '../kit.ts'
import {
  appById,
  isProduction,
  productionOf,
  projectByRef,
  variableById,
  type TargetRow,
} from '../lookup.ts'
import { getQuery } from '../pagination.ts'
import { Resolved, resolvedView } from '../resolved.ts'
import type { TargetInput } from '../route-meta.ts'
import { EnvironmentVariablesPatch, input } from '../schemas.ts'
import {
  Approval,
  ApprovalDetail,
  Change,
  component,
  EnvironmentVariable,
  extend,
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
import {
  dependentsOf,
  planVariables,
  type VariableItem,
  type VariableScope,
} from '../variable-changes.ts'

const StaleDependent = Type.Object(
  {
    app_id: Type.String(),
    project_id: Type.String(),
    preview_id: Nullable(Type.String()),
    environment_variables: Type.Array(Type.String()),
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

const EnvironmentVariablesOutcome = component(
  'EnvironmentVariablesOutcome',
  Type.Object(
    {
      environment_variables: Type.Array(EnvironmentVariable),
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
    environment_variable_id: Type.String(),
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

const variablesReplies = replies({
  200: EnvironmentVariablesOutcome,
  202: ApprovalDetail,
})

type PatchInput = {
  set?: VariableItem[]
  unset?: string[]
  apply?: boolean
  allow_unresolved?: boolean
}

export const variableRoutes = (kit: Kit) => {
  const { db, keyring } = kit.deps
  const list = (rows: (typeof environment_variable.$inferSelect)[], fields?: string) => ({
    items: projectAll(kit.views.variable, rows, kit.fields(fields)),
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

      changes.deploy(ctx.app.id, 'environment_variable_change', {
        reason: `${dependent.environment_variables.join(', ')} changed`,
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
    const variables = ids()
      .map((id) =>
        db.select().from(environment_variable).where(eq(environment_variable.id, id)).get(),
      )
      .filter((row): row is typeof environment_variable.$inferSelect => row !== undefined)
      .map((row) => select(kit.views.variable, row, undefined))

    return {
      environment_variables: variables,
      stale_dependents,
      deployments: appliedStale.deployments,
      approvals: appliedStale.approvals,
    }
  }

  const patch = (
    call: Call,
    scope: VariableScope,
    targetRow: TargetRow | null,
    protect: boolean,
    input: PatchInput,
    set: { status?: number | string },
    projectId: string | null,
  ) => {
    const changes = new ChangeSet()

    planVariables(db, keyring, call.principal, changes, scope, input)

    if (changes.empty) {
      return {
        environment_variables: [],
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
          ].filter((id) => id.startsWith(`${idPrefixes.environment_variable}_`))
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
    .router('environment-variables', '/v1')
    .get(
      '/apps/:app/environment-variables',
      ({ ctx, query }) => {
        return list(
          variablesOf(db, {
            scope: 'app',
            id: ctx.app.id,
          })
            .orderBy(asc(environment_variable.name))
            .all(),
          query.fields,
        )
      },
      {
        app: {
          id: 'list_app_environment_variables',
          summary: 'List the environment variables of an app; values are never listed',
          level: 'read',
        },
        query: t.Object(getQuery),
        response: replies({
          200: Page(EnvironmentVariable),
        }),
      },
    )
    .get(
      '/projects/:project/environment-variables',
      ({ ctx, query }) => {
        const proj = ctx.project
        let rows = variablesOf(db, {
          scope: 'project',
          id: proj.id,
        })
          .orderBy(asc(environment_variable.name))
          .all()

        if (query.target) {
          const wanted = query.target

          rows = rows.filter((row) =>
            db
              .select({
                id: secret_value.id,
              })
              .from(secret_value)
              .where(
                and(
                  eq(secret_value.environment_variable_id, row.id),
                  eq(secret_value.target, wanted),
                ),
              )
              .get(),
          )
        }

        return list(rows, query.fields)
      },
      {
        project: {
          id: 'list_project_environment_variables',
          summary:
            'List project environment variables; an app reads one only through a reference such as ${{project.NAME}}',
          level: 'read',
          cli: {
            path: ['env', 'list'],
          },
        },
        query: t.Object({
          ...getQuery,
          target: valueTargetQuery,
        }),
        response: replies({
          200: Page(EnvironmentVariable),
        }),
      },
    )
    .get(
      '/global-environment-variables',
      ({ query }) => {
        return list(
          variablesOf(db, {
            scope: 'global',
          })
            .orderBy(asc(environment_variable.name))
            .all(),
          query.fields,
        )
      },
      {
        operation: {
          id: 'list_global_environment_variables',
          summary: 'List global environment variables',
          level: 'instance read',
        },
        query: t.Object(getQuery),
        response: replies({
          200: Page(EnvironmentVariable),
        }),
      },
    )
    .get(
      '/environment-variables/:id',
      ({ ctx, query }) => {
        return select(kit.views.variable, ctx.variable, kit.fields(query.fields))
      },
      {
        environment_variable: {
          id: 'get_environment_variable',
          summary: 'Get an environment variable; never its value',
          level: 'read',
        },
        query: t.Object(getQuery),
        response: replies({
          200: EnvironmentVariable,
        }),
      },
    )
    .get(
      '/environment-variables/:id/versions',
      ({ ctx, query }) => {
        const rows = db
          .select()
          .from(secret_value)
          .where(
            and(
              eq(secret_value.environment_variable_id, ctx.variable.id),
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
        environment_variable: {
          id: 'list_environment_variable_versions',
          summary: 'List the versions of an environment variable; never their values',
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
      '/apps/:app/environment-variables',
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
          id: 'set_app_environment_variables',
          summary: 'Set and unset app environment variables',
          level: 'deploy',
        },
        body: t.Object(
          {
            target: valueTargetQuery,
            ...EnvironmentVariablesPatch,
          },
          {
            additionalProperties: false,
          },
        ),
        response: variablesReplies,
      },
    )
    .patch(
      '/projects/:project/environment-variables',
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
          id: 'set_project_environment_variables',
          summary:
            "Set and unset project environment variables: production's values, which wait for approval, or the preview values every preview reads. An app gets a project environment variable only through a reference such as ${{project.NAME}}",
          level: 'admin',
          target: ({ params, body }: TargetInput) =>
            projectScope(params.project!, (body as { target?: ValueTarget }).target).target,
        },
        body: t.Object(
          {
            target: valueTargetQuery,
            ...EnvironmentVariablesPatch,
          },
          {
            additionalProperties: false,
          },
        ),
        response: variablesReplies,
      },
    )
    .patch(
      '/global-environment-variables',
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
          id: 'set_global_environment_variables',
          summary: 'Set and unset global environment variables',
          level: 'instance admin',
        },
        body: t.Object(EnvironmentVariablesPatch, {
          additionalProperties: false,
        }),
        response: variablesReplies,
      },
    )
    .delete(
      '/environment-variables/:id',
      async ({ ctx, request, set }) => {
        const call = await kit.call(request)
        const changes = new ChangeSet()
        let place: TargetRow | null = null
        let scope: VariableScope

        if (ctx.variable.scope === 'app') {
          const svc = appById(db, ctx.variable.app_id!)

          place = svc.target_row
          scope = {
            scope: 'app',
            parent: svc.app.id,
            appId: svc.app.id,
            valueTarget: 'production',
            target: svc.target,
          }
        } else if (ctx.variable.scope === 'project') {
          place = productionOf(db, ctx.variable.project_id!)
          scope = {
            scope: 'project',
            parent: ctx.variable.project_id!,
            valueTarget: 'production',
            target: ctx.target,
          }
        } else {
          scope = {
            scope: 'global',
            target: ctx.target,
          }
        }

        planVariables(db, keyring, call.principal, changes, scope, {
          unset: [ctx.variable.name],
        })
        const protect = place
          ? isProduction(place)
          : ctx.variable.scope === 'global' &&
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
          stale_dependents: staleFor(ctx.variable.project_id),
        }
      },
      {
        environment_variable: {
          id: 'delete_environment_variable',
          summary: 'Delete an environment variable',
          level: 'deploy',
        },
        response: replies({
          200: DeletedWithStale,
          202: ApprovalDetail,
        }),
      },
    )
    .post(
      '/environment-variables/:id/apply',
      async ({ request, params }) => {
        const call = await kit.call(request)
        const ctx = variableById(db, params.id)
        const apps = new Set(dependentsOf(db, ctx.variable).map((dep) => dep.app_id))

        if (ctx.variable.app_id) {
          apps.add(ctx.variable.app_id)
        }

        const dependents = staleDependents(db, ctx.variable.project_id, apps)
        const result = applyStale(call, dependents)

        return {
          deployments: result.deployments,
          approvals: result.approvals,
        }
      },
      {
        operation: {
          id: 'apply_environment_variable_changes',
          summary: 'Redeploy every stale dependent of an environment variable',
          level: 'any',
          cli: {
            path: ['env', 'apply'],
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
            `Version ${ctx.secretValue.version} of ${ctx.variable.name} is pinned by active deployments.`,
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
              environment_variable_id: ctx.variable.id,
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
              environment_variable_id: ctx.variable.id,
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
      '/apps/:app/environment-variables/resolved',
      async ({ ctx, request, query }) => {
        const call = await kit.call(request)

        return resolvedView(kit, call, ctx, {
          admin: can(call.principal, ctx.target, 'admin'),
          compareWith: query.deployment,
        }) as Static<typeof Resolved>
      },
      {
        app: {
          id: 'get_resolved_environment_variables',
          summary:
            'The resolved environment variables of the next deployment; secret values never appear',
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
      '/environment-variables/:id/grants',
      ({ params }) => {
        const ctx = variableById(db, params.id)
        const rows = db
          .select()
          .from(grant)
          .where(eq(grant.environment_variable_id, ctx.variable.id))
          .orderBy(desc(grant.id))
          .all()

        return {
          items: rows.map((g) => ({
            id: g.id,
            environment_variable_id: g.environment_variable_id,
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
          summary: 'List the grants of a global environment variable',
          level: 'instance read',
        },
        response: replies({
          200: Page(Grant),
        }),
      },
    )
    .post(
      '/environment-variables/:id/grants',
      async ({ request, params, body, set }) => {
        const call = await kit.call(request)
        const ctx = variableById(db, params.id)

        if (ctx.variable.scope !== 'global') {
          fail('VALIDATION_FAILED', 'Only global environment variables are granted.', undefined, {
            issues: [
              {
                path: '/id',
                message: `environment variable is ${ctx.variable.scope}`,
              },
            ],
          })
        }

        const proj =
          db.select().from(project).where(eq(project.id, body.project_id)).get() ??
          notFound('project', body.project_id)
        const name = body.alias ?? ctx.variable.name
        const taken = db
          .select({
            alias: grant.alias,
            name: environment_variable.name,
          })
          .from(grant)
          .innerJoin(
            environment_variable,
            eq(environment_variable.id, grant.environment_variable_id),
          )
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
            environment_variable_id: ctx.variable.id,
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
              environment_variable_id: ctx.variable.id,
              project_id: proj.id,
              alias: body.alias ?? null,
            },
          },
        )
        set.status = 201

        return {
          id,
          environment_variable_id: ctx.variable.id,
          project_id: proj.id,
          alias: body.alias ?? null,
          source: 'manual' as const,
        }
      },
      {
        operation: {
          id: 'grant_environment_variable',
          summary: 'Grant a global environment variable to a project',
          level: 'instance admin',
        },
        body: t.Object(
          {
            project_id: t.String({
              description: 'The project to grant the environment variable to',
            }),
            alias: t.Optional(
              t.String({
                pattern: environmentVariableNamePattern,
                description:
                  "The name inside the project, when the global environment variable's name would collide",
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
              environment_variable_id: row.environment_variable_id,
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
