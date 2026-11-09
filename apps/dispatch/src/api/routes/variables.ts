import { and, asc, desc, eq, isNotNull, isNull } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import { deployment, grant, project, secret_value, variable } from '../../db/schema.ts'
import type { EnvSnapshot } from '../../secrets/deploy.ts'
import { leaves } from '../../secrets/resolve.ts'
import { can, requireInstance, requireLevel } from '../access.ts'
import { audit, type Call } from '../context.ts'
import { ChangeSet, commit, type CommitResult } from '../changes.ts'
import { fail, notFound } from '../errors.ts'
import { project as select, projectAll } from '../fields.ts'
import type { Kit } from '../kit.ts'
import { environmentInProject, projectByRef, serviceById, variableById, type EnvironmentRow } from '../lookup.ts'
import { getQuery } from '../pagination.ts'
import { Resolved, resolvedView } from '../resolved.ts'
import { Change, component, extend, models, Page, replies, SecretValue, Staged, StagedChange, Variable, Warnings } from '../shapes.ts'
import { Nullable, StringEnum } from '@stationly/protocol'
import { Type, type Static } from '@sinclair/typebox'
import { VariablesPatch } from '../schemas.ts'
import { readSetting } from '../settings.ts'
import { dependentsOf, planVariables, type VariableItem, type VariableScope } from '../variable-changes.ts'
import { refreshStale, staleDependents, type StaleDependent as StaleDependentRow } from '../stale.ts'

const StaleDependent = Type.Object(
  { service_id: Type.String(), environment_id: Type.String(), protected: Type.Boolean(), keys: Type.Array(Type.String()) },
  { additionalProperties: false }
)

const StagedWithChanges = extend(StagedChange, { changes: Type.Array(Change) })

const applied = { deployments: Type.Array(Type.String()), staged_changes: Type.Array(StagedWithChanges) }

const Applied = Type.Object(applied, { additionalProperties: false })

const VariablesOutcome = component('VariablesOutcome', Type.Object({ variables: Type.Array(Variable), stale_dependents: Type.Array(StaleDependent), ...applied }, { additionalProperties: false }))

const DeletedWithStale = Type.Object({ deleted: Type.Literal(true), stale_dependents: Type.Array(StaleDependent) }, { additionalProperties: false })

const Grant = Type.Object(
  { id: Type.String(), variable_id: Type.String(), project_id: Type.String(), alias: Nullable(Type.String()), source: StringEnum(['manual', 'attachment']) },
  { title: 'Grant', additionalProperties: false }
)

const RevokedValue = extend(SecretValue, { warnings: Warnings })

const variablesReplies = replies({ 200: VariablesOutcome, 202: Staged })

type PatchInput = { set?: VariableItem[]; unset?: string[]; apply?: boolean; allow_unresolved?: boolean }

export const variableRoutes = (kit: Kit) => {
  const { db, keyring } = kit.deps
  const tags = ['variables']
  const list = (rows: (typeof variable.$inferSelect)[], fields?: string) => ({ items: projectAll(kit.views.variable, rows, kit.fields(fields)), next_cursor: null })

  const staleFor = (projectId: string | null) => staleDependents(db, projectId)

  const applyStale = (call: Call, dependents: StaleDependentRow[]) => {
    const deployments: string[] = []
    const staged: Static<typeof StagedWithChanges>[] = []
    for (const dependent of dependents) {
      const ctx = serviceById(db, dependent.service_id)
      if (!can(call.principal, ctx.target, 'deploy')) continue
      const changes = new ChangeSet()
      changes.deploy(ctx.service.id, 'variable_change', { reason: `${dependent.keys.join(', ')} changed`, supersede: true })
      const result = commit(kit.deps, call, { environment: ctx.environment, protect: ctx.environment.protected }, changes)
      if (result.applied) deployments.push(...result.deployments)
      else staged.push(select(kit.views.staged, result.staged, kit.fields('changes')) as Static<typeof StagedWithChanges>)
    }
    return { deployments, staged_changes: staged }
  }

  const finish = (call: Call, set: { status?: number | string }, result: CommitResult, input: PatchInput, projectId: string | null, ids: () => string[]) => {
    if (!result.applied) return kit.stagedBody(result, set)
    const stale_dependents = staleFor(projectId)
    const appliedStale = input.apply ? applyStale(call, stale_dependents) : { deployments: [], staged_changes: [] }
    const variables = ids()
      .map(id => db.select().from(variable).where(eq(variable.id, id)).get())
      .filter((row): row is typeof variable.$inferSelect => row !== undefined)
      .map(row => select(kit.views.variable, row, undefined))
    return { variables, stale_dependents, deployments: appliedStale.deployments, staged_changes: appliedStale.staged_changes }
  }

  const patch = (call: Call, scope: VariableScope, environmentRow: EnvironmentRow | null, protect: boolean, input: PatchInput, set: { status?: number | string }, projectId: string | null) => {
    const changes = new ChangeSet()
    planVariables(db, keyring, call.principal, changes, scope, input)
    if (changes.empty) return { variables: [], stale_dependents: [], deployments: [], staged_changes: [] }
    const result = commit(kit.deps, call, { environment: environmentRow, protect }, changes)
    return finish(call, set, result, input, projectId, () =>
      result.applied
        ? [...Object.values(result.refs), ...changes.changes.filter(c => c.op === 'update').map(c => (c.op === 'update' ? c.id : ''))].filter(id => id.startsWith('var_'))
        : []
    )
  }

  const pinCount = (secretValueId: string) =>
    db
      .select({ id: deployment.id, env_snapshot: deployment.env_snapshot })
      .from(deployment)
      .where(eq(deployment.status, 'active'))
      .all()
      .filter(d => ((d.env_snapshot as EnvSnapshot).entries ?? []).some(e => leaves(e.node).some(l => l.kind === 'value' && l.secret_value_id === secretValueId)))
      .map(d => d.id)

  const secretValueContext = (id: string) => {
    const row = db.select().from(secret_value).where(eq(secret_value.id, id)).get() ?? notFound('secret_value', id)
    const owner = variableById(db, row.variable_id)
    const target = row.environment_id && owner.variable.scope === 'project' ? { project_id: owner.variable.project_id!, environment_id: row.environment_id } : owner.target
    return { row, variable: owner.variable, target }
  }

  const requireVariableRead = (principal: Parameters<typeof requireLevel>[0], scope: string, target: { project_id: string; environment_id: string }) => {
    if (scope === 'global') requireInstance(principal, 'read')
    else if (scope === 'project') {
      if (!principal.scopes.some(s => s.project_id === '*' || s.project_id === target.project_id)) requireLevel(principal, target, 'read')
    } else requireLevel(principal, target, 'read')
  }

  return new Elysia({ prefix: '/v1', normalize: false }).use(models())
    .get(
      '/services/:service/variables',
      async ({ request, params, query }) => {
        const principal = await kit.principal(request)
        const ctx = serviceById(db, params.service)
        requireLevel(principal, ctx.target, 'read')
        return list(db.select().from(variable).where(and(eq(variable.scope, 'service'), eq(variable.service_id, ctx.service.id))).orderBy(asc(variable.key)).all(), query.fields)
      },
      { params: t.Object({ service: t.String() }), query: t.Object(getQuery), response: replies({ 200: Page(Variable) }), detail: { summary: 'List the variables of a service; values are never listed', tags } }
    )
    .get(
      '/projects/:project/variables',
      async ({ request, params, query }) => {
        const principal = await kit.principal(request)
        const proj = projectByRef(db, params.project)
        requireVariableRead(principal, 'project', { project_id: proj.id, environment_id: '*' })
        let rows = db.select().from(variable).where(and(eq(variable.scope, 'project'), eq(variable.project_id, proj.id))).orderBy(asc(variable.key)).all()
        if (query.environment) {
          const envId = query.environment === 'default' ? null : environmentInProject(db, proj, query.environment).id
          rows = rows.filter(row =>
            db
              .select({ id: secret_value.id })
              .from(secret_value)
              .where(and(eq(secret_value.variable_id, row.id), envId === null ? isNull(secret_value.environment_id) : eq(secret_value.environment_id, envId)))
              .get()
          )
        }
        return list(rows, query.fields)
      },
      { params: t.Object({ project: t.String() }), query: t.Object({ ...getQuery, environment: t.Optional(t.String()) }), response: replies({ 200: Page(Variable) }), detail: { summary: 'List project variables', tags } }
    )
    .get(
      '/global-variables',
      async ({ request, query }) => {
        requireInstance(await kit.principal(request), 'read')
        return list(db.select().from(variable).where(eq(variable.scope, 'global')).orderBy(asc(variable.key)).all(), query.fields)
      },
      { query: t.Object(getQuery), response: replies({ 200: Page(Variable) }), detail: { summary: 'List global variables', tags } }
    )
    .get(
      '/variables/:id',
      async ({ request, params, query }) => {
        const principal = await kit.principal(request)
        const ctx = variableById(db, params.id)
        requireVariableRead(principal, ctx.variable.scope, ctx.target)
        return select(kit.views.variable, ctx.variable, kit.fields(query.fields))
      },
      { params: t.Object({ id: t.String() }), query: t.Object(getQuery), response: replies({ 200: Variable }), detail: { summary: 'Get a variable; never its value', tags } }
    )
    .get(
      '/variables/:id/versions',
      async ({ request, params, query }) => {
        const principal = await kit.principal(request)
        const ctx = variableById(db, params.id)
        requireVariableRead(principal, ctx.variable.scope, ctx.target)
        const envId =
          query.environment === undefined
            ? undefined
            : query.environment === 'default'
              ? null
              : ctx.variable.project_id
                ? environmentInProject(db, projectByRef(db, ctx.variable.project_id), query.environment).id
                : notFound('environment', query.environment)
        const rows = db
          .select()
          .from(secret_value)
          .where(
            and(
              eq(secret_value.variable_id, ctx.variable.id),
              envId === undefined ? undefined : envId === null ? isNull(secret_value.environment_id) : eq(secret_value.environment_id, envId),
              query.revoked === undefined ? undefined : query.revoked ? isNotNull(secret_value.revoked_at) : isNull(secret_value.revoked_at)
            )
          )
          .orderBy(desc(secret_value.version))
          .all()
        return { items: projectAll(kit.views.secretValue, rows, kit.fields(query.fields)), next_cursor: null }
      },
      {
        params: t.Object({ id: t.String() }),
        query: t.Object({ ...getQuery, environment: t.Optional(t.String()), revoked: t.Optional(t.BooleanString()) }),
        response: replies({ 200: Page(SecretValue) }),
        detail: { summary: 'List the versions of a variable; never their values', tags }
      }
    )
    .patch(
      '/services/:service/variables',
      async ({ request, params, body, set }) => {
        const call = await kit.call(request)
        const ctx = serviceById(db, params.service)
        requireLevel(call.principal, ctx.target, 'deploy')
        return patch(call, { scope: 'service', parent: ctx.service.id, serviceId: ctx.service.id, target: ctx.target }, ctx.environment, ctx.environment.protected, body, set, ctx.project.id)
      },
      { params: t.Object({ service: t.String() }), body: t.Object(VariablesPatch, { additionalProperties: false }), response: variablesReplies, detail: { summary: 'Set and unset service variables', tags } }
    )
    .patch(
      '/projects/:project/variables',
      async ({ request, params, body, set }) => {
        const call = await kit.call(request)
        const proj = projectByRef(db, params.project)
        const env = body.environment === 'default' ? null : environmentInProject(db, proj, body.environment)
        const target = { project_id: proj.id, environment_id: env?.id ?? '*' }
        requireLevel(call.principal, target, 'admin')
        const { environment: _e, ...input } = body
        return patch(call, { scope: 'project', parent: proj.id, environmentId: env?.id ?? null, target }, env, env?.protected ?? false, input, set, proj.id)
      },
      {
        params: t.Object({ project: t.String() }),
        body: t.Object({ environment: t.String(), ...VariablesPatch }, { additionalProperties: false }),
        response: variablesReplies,
        detail: { summary: 'Set and unset project variables for one environment or the default', tags }
      }
    )
    .patch(
      '/global-variables',
      async ({ request, body, set }) => {
        const call = await kit.call(request)
        requireInstance(call.principal, 'admin')
        const protect = Boolean(readSetting<boolean>(db, 'platform.protected')) && !call.principal.human
        return patch(call, { scope: 'global', target: { project_id: '*', environment_id: '*' } }, null, protect, body, set, null)
      },
      { body: t.Object(VariablesPatch, { additionalProperties: false }), response: variablesReplies, detail: { summary: 'Set and unset global variables', tags } }
    )
    .delete(
      '/variables/:id',
      async ({ request, params, set }) => {
        const call = await kit.call(request)
        const ctx = variableById(db, params.id)
        const changes = new ChangeSet()
        let env: EnvironmentRow | null = null
        let scope: VariableScope
        if (ctx.variable.scope === 'service') {
          const svc = serviceById(db, ctx.variable.service_id!)
          env = svc.environment
          scope = { scope: 'service', parent: svc.service.id, serviceId: svc.service.id, target: svc.target }
        } else if (ctx.variable.scope === 'project') {
          scope = { scope: 'project', parent: ctx.variable.project_id!, environmentId: null, target: ctx.target }
        } else scope = { scope: 'global', target: ctx.target }
        planVariables(db, keyring, call.principal, changes, scope, { unset: [ctx.variable.key] })
        const protect = ctx.variable.scope === 'service' ? Boolean(env?.protected) : ctx.variable.scope === 'global' && Boolean(readSetting<boolean>(db, 'platform.protected')) && !call.principal.human
        const result = commit(kit.deps, call, { environment: env, protect }, changes)
        if (!result.applied) return kit.stagedBody(result, set)
        return { deleted: true as const, stale_dependents: staleFor(ctx.variable.project_id) }
      },
      { params: t.Object({ id: t.String() }), response: replies({ 200: DeletedWithStale, 202: Staged }), detail: { summary: 'Delete a variable', tags } }
    )
    .post(
      '/variables/:id/apply',
      async ({ request, params }) => {
        const call = await kit.call(request)
        const ctx = variableById(db, params.id)
        const services = new Set(dependentsOf(db, ctx.variable).map(dep => dep.service_id))
        if (ctx.variable.service_id) services.add(ctx.variable.service_id)
        const dependents = staleDependents(db, ctx.variable.project_id, services)
        const result = applyStale(call, dependents)
        return { deployments: result.deployments, staged_changes: result.staged_changes }
      },
      { params: t.Object({ id: t.String() }), response: replies({ 200: Applied }), detail: { summary: 'Redeploy every stale dependent of a variable', tags } }
    )
    .post(
      '/secret-values/:id/revoke',
      async ({ request, params, body }) => {
        const call = await kit.call(request)
        const ctx = secretValueContext(params.id)
        if (ctx.variable.scope === 'global') requireInstance(call.principal, 'admin')
        else requireLevel(call.principal, ctx.target, 'admin')
        const pinnedBy = pinCount(ctx.row.id)
        if (pinnedBy.length && !body?.force) {
          fail('SECRET_VERSION_IN_USE', `Version ${ctx.row.version} of ${ctx.variable.key} is pinned by active deployments.`, 'Deploy a newer version first, or send force = true; a restart of those services will then fail.', {
            deployments: pinnedBy
          })
        }
        db.update(secret_value).set({ revoked_at: new Date() }).where(eq(secret_value.id, ctx.row.id)).run()
        refreshStale(db)
        audit(db, call, 'secret.revoke', { entity: 'secret_value', id: ctx.row.id }, { after: { variable_id: ctx.variable.id, version: ctx.row.version, force: Boolean(body?.force) } })
        const row = db.select().from(secret_value).where(eq(secret_value.id, ctx.row.id)).get()!
        return { ...select(kit.views.secretValue, row, undefined), warnings: pinnedBy.length ? [{ code: 'STALE_SECRET_VERSIONS', explanation: `Restarting ${pinnedBy.join(', ')} will fail.` }] : [] }
      },
      { params: t.Object({ id: t.String() }), body: t.Optional(t.Object({ force: t.Optional(t.Boolean()) }, { additionalProperties: false })), response: replies({ 200: RevokedValue }), detail: { summary: 'Revoke a secret version', tags } }
    )
    .post(
      '/secret-values/:id/restore',
      async ({ request, params }) => {
        const call = await kit.call(request)
        const ctx = secretValueContext(params.id)
        if (ctx.variable.scope === 'global') requireInstance(call.principal, 'admin')
        else requireLevel(call.principal, ctx.target, 'admin')
        db.update(secret_value).set({ revoked_at: null }).where(eq(secret_value.id, ctx.row.id)).run()
        refreshStale(db)
        audit(db, call, 'secret.restore', { entity: 'secret_value', id: ctx.row.id }, { after: { variable_id: ctx.variable.id, version: ctx.row.version } })
        return select(kit.views.secretValue, db.select().from(secret_value).where(eq(secret_value.id, ctx.row.id)).get()!, undefined)
      },
      { params: t.Object({ id: t.String() }), response: replies({ 200: SecretValue }), detail: { summary: 'Undo a revocation', tags } }
    )
    .get(
      '/services/:service/variables/resolved',
      async ({ request, params, query }) => {
        const call = await kit.call(request)
        const ctx = serviceById(db, params.service)
        requireLevel(call.principal, ctx.target, 'read')
        return resolvedView(kit, call, ctx, { admin: can(call.principal, ctx.target, 'admin'), compareWith: query.deployment }) as Static<typeof Resolved>
      },
      { params: t.Object({ service: t.String() }), query: t.Object({ deployment: t.Optional(t.String()) }), response: replies({ 200: Resolved }), detail: { summary: 'The resolved variables of the next deployment; sealed values never appear', tags } }
    )
    .get(
      '/variables/:id/grants',
      async ({ request, params }) => {
        requireInstance(await kit.principal(request), 'read')
        const ctx = variableById(db, params.id)
        const rows = db.select().from(grant).where(eq(grant.variable_id, ctx.variable.id)).orderBy(desc(grant.id)).all()
        return { items: rows.map(g => ({ id: g.id, variable_id: g.variable_id, project_id: g.project_id, alias: g.alias, source: g.source })), next_cursor: null }
      },
      { params: t.Object({ id: t.String() }), response: replies({ 200: Page(Grant) }), detail: { summary: 'List the grants of a global variable', tags } }
    )
    .post(
      '/variables/:id/grants',
      async ({ request, params, body, set }) => {
        const call = await kit.call(request)
        requireInstance(call.principal, 'admin')
        const ctx = variableById(db, params.id)
        if (ctx.variable.scope !== 'global') fail('VALIDATION_FAILED', 'Only global variables are granted.', undefined, { issues: [{ path: '/id', message: `variable is ${ctx.variable.scope}` }] })
        const proj = db.select().from(project).where(eq(project.id, body.project_id)).get() ?? notFound('project', body.project_id)
        const name = body.alias ?? ctx.variable.key
        const taken = db
          .select({ alias: grant.alias, key: variable.key })
          .from(grant)
          .innerJoin(variable, eq(variable.id, grant.variable_id))
          .where(eq(grant.project_id, proj.id))
          .all()
          .some(g => (g.alias ?? g.key) === name)
        if (taken) fail('NAME_TAKEN', `Project ${proj.name} already holds a grant named ${name}.`, undefined, { alias: name })
        const id = db
          .insert(grant)
          .values({ variable_id: ctx.variable.id, project_id: proj.id, alias: body.alias ?? null, source: 'manual' })
          .returning({ id: grant.id })
          .get().id
        refreshStale(db)
        audit(db, call, 'grant.create', { entity: 'grant', id }, { after: { variable_id: ctx.variable.id, project_id: proj.id, alias: body.alias ?? null } })
        set.status = 201
        return { id, variable_id: ctx.variable.id, project_id: proj.id, alias: body.alias ?? null, source: 'manual' as const }
      },
      {
        params: t.Object({ id: t.String() }),
        body: t.Object({ project_id: t.String(), alias: t.Optional(t.String({ pattern: '^[A-Z_][A-Z0-9_]*$' })) }, { additionalProperties: false }),
        response: replies({ 201: Grant }),
        detail: { summary: 'Grant a global variable to a project', tags }
      }
    )
    .delete(
      '/grants/:id',
      async ({ request, params }) => {
        const call = await kit.call(request)
        requireInstance(call.principal, 'admin')
        const row = db.select().from(grant).where(eq(grant.id, params.id)).get() ?? notFound('grant', params.id)
        db.delete(grant).where(eq(grant.id, row.id)).run()
        refreshStale(db)
        audit(db, call, 'grant.delete', { entity: 'grant', id: row.id }, { before: { variable_id: row.variable_id, project_id: row.project_id, alias: row.alias } })
        return { deleted: true as const, stale_dependents: staleFor(row.project_id) }
      },
      { params: t.Object({ id: t.String() }), response: replies({ 200: DeletedWithStale }), detail: { summary: 'Revoke a grant', tags } }
    )
}
