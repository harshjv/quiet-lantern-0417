import { and, asc, desc, eq, isNull } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import type { Principal } from '../../auth/principal.ts'
import type { Db } from '../../db/client.ts'
import { newId } from '../../db/ids.ts'
import { audit, emit, type Call } from '../context.ts'
import { deployment, environment, secret_value, service, service_port, variable, volume } from '../../db/schema.ts'
import { SecretsError } from '../../secrets/errors.ts'
import { setVariable, type VariableWrite } from '../../secrets/variables.ts'
import { settleVariableWrites } from '../stale.ts'
import { requireHuman, requireLevel, seesEnvironment } from '../access.ts'
import { ChangeSet, commit, exportNames, requireNoSandboxes } from '../changes.ts'
import { createDeploymentRecord } from '../deployments.ts'
import { ensureNetwork, ensureVirtualIp } from '../ipam.ts'
import { ApiError, fail } from '../errors.ts'
import { project as select } from '../fields.ts'
import { slugPattern, warning, type Kit } from '../kit.ts'
import { environmentById, environmentInProject, projectByRef, type EnvironmentRow, type ProjectRow } from '../lookup.ts'
import { before, collect, getQuery, listQuery } from '../pagination.ts'
import { Type } from '@sinclair/typebox'
import { DeletedRetaining, Deployment, Environment, extend, models, Page, replies, Staged, Warnings } from '../shapes.ts'

const EnvironmentCreated = extend(Environment, { deployments: Type.Array(Deployment), warnings: Warnings })

const decryptValue = (kit: { deps: Pick<Kit['deps'], 'keyring'> }, row: typeof secret_value.$inferSelect) => kit.deps.keyring.decrypt(row.id, row.data_key_id, row.ciphertext)

const headOf = (db: Db, variableId: string, environmentId: string | null) =>
  db
    .select()
    .from(secret_value)
    .where(
      and(
        eq(secret_value.variable_id, variableId),
        environmentId === null ? isNull(secret_value.environment_id) : eq(secret_value.environment_id, environmentId),
        isNull(secret_value.revoked_at)
      )
    )
    .orderBy(desc(secret_value.version))
    .get()

export const cloneInto = (kit: { deps: Pick<Kit['deps'], 'db' | 'keyring'> }, call: Call, proj: ProjectRow, source: EnvironmentRow, target: EnvironmentRow, deploy: boolean) => {
  const db = kit.deps.db
  const warnings: { code: string; explanation: string }[] = []
  const copied: string[] = []
  const decrypted: string[] = []
  const writes: VariableWrite[] = []
  const services = db.select().from(service).where(eq(service.environment_id, source.id)).orderBy(asc(service.id)).all()
  db.transaction(tx => {
    const tdb = tx as unknown as Db
    const idMap = new Map<string, string>()
    for (const svc of services) {
      const id = newId('service')
      idMap.set(svc.id, id)
      const { id: _id, created_at: _c, updated_at: _u, current_deployment_id: _d, environment_id: _e, status: _s, stale: _st, ...rest } = svc
      tdb.insert(service).values({ ...rest, id, environment_id: target.id, exports: exportNames(svc.kind), status: 'amber', desired_state: 'running' }).run()
      ensureNetwork(tdb, target.id, svc.station_id)
      ensureVirtualIp(tdb, id, target.id)
      for (const port of tdb.select().from(service_port).where(eq(service_port.service_id, svc.id)).all()) {
        tdb.insert(service_port).values({ id: newId('service_port'), service_id: id, port: port.port, protocol: port.protocol, grpc: port.grpc }).run()
      }
      for (const vol of tdb.select().from(volume).where(and(eq(volume.service_id, svc.id), eq(volume.owner, 'service'))).all()) {
        const volumeId = newId('volume')
        tdb.insert(volume)
          .values({ id: volumeId, owner: 'service', service_id: id, project_id: proj.id, mount_path: vol.mount_path, station_id: vol.station_id, docker_name: `or-vol-${volumeId.slice(4).toLowerCase()}` })
          .run()
      }
      copied.push(id)
    }
    for (const svc of services) {
      for (const v of tdb.select().from(variable).where(and(eq(variable.scope, 'service'), eq(variable.service_id, svc.id))).all()) {
        let value = v.reference ?? ''
        if (v.reference === null) {
          const head = headOf(tdb, v.id, null)
          if (!head) continue
          decrypted.push(head.id)
          value = v.kind === 'sealed' ? decryptValue(kit, head) : decryptValue(kit, head).replaceAll('${{', () => '$${{')
        }
        const result = setVariable(tdb, kit.deps.keyring, {
          scope: 'service',
          service_id: idMap.get(svc.id)!,
          key: v.key,
          value,
          sealed: v.kind === 'sealed',
          injection: v.injection,
          build: v.build,
          allow_unresolved: true,
          actor: call.principal.actor,
          request_id: call.request_id
        })
        if (result.write) writes.push(result.write)
      }
    }
    if (!source.protected) {
      for (const v of tdb.select().from(variable).where(and(eq(variable.scope, 'project'), eq(variable.project_id, proj.id))).all()) {
        const head = headOf(tdb, v.id, source.id)
        if (!head) continue
        decrypted.push(head.id)
        const result = setVariable(tdb, kit.deps.keyring, {
          scope: 'project',
          project_id: proj.id,
          environment_id: target.id,
          key: v.key,
          value: v.kind === 'sealed' ? decryptValue(kit, head) : decryptValue(kit, head).replaceAll('${{', () => '$${{'),
          sealed: v.kind === 'sealed',
          injection: v.injection,
          build: v.build,
          actor: call.principal.actor,
          request_id: call.request_id
        })
        if (result.write) writes.push(result.write)
      }
    }
    settleVariableWrites(tdb, writes)
    if (decrypted.length) audit(tdb, call, 'secret.decrypt', { entity: 'environment', id: target.id }, { purpose: 'export', after: { secret_value_ids: decrypted, source_environment_id: source.id } })
  })
  const deployments: string[] = []
  if (deploy) {
    for (const id of copied) {
      try {
        deployments.push(createDeploymentRecord(db, { service_id: id, trigger: 'manual', actor: call.principal.actor, supersede: false }).id)
      } catch (error) {
        if (!(error instanceof ApiError || error instanceof SecretsError)) throw error
        warnings.push(warning(error.code, `Service ${id} was cloned but not deployed: ${error.message}`))
      }
    }
  }
  return { warnings, deployments }
}

const environmentTarget = (row: EnvironmentRow) => ({ project_id: row.project_id, environment_id: row.id })

const requireEnvironmentWrite = (principal: Principal, row: EnvironmentRow, ephemeralLevel: 'deploy' | 'admin') =>
  requireLevel(principal, environmentTarget(row), row.ephemeral ? ephemeralLevel : 'admin')

export const environmentRoutes = (kit: Kit) => {
  const { db } = kit.deps
  const tags = ['environments']

  return new Elysia({ prefix: '/v1', normalize: false }).use(models())
    .get(
      '/projects/:project/environments',
      async ({ request, params, query }) => {
        const principal = await kit.principal(request)
        const proj = projectByRef(db, params.project)
        const page = collect(
          (cursor, size) =>
            db
              .select()
              .from(environment)
              .where(
                and(
                  eq(environment.project_id, proj.id),
                  query.ephemeral === undefined ? undefined : eq(environment.ephemeral, query.ephemeral),
                  query.protected === undefined ? undefined : eq(environment.protected, query.protected),
                  before(environment.id, cursor)
                )
              )
              .orderBy(desc(environment.id))
              .limit(size)
              .all(),
          query,
          row => seesEnvironment(principal, environmentTarget(row))
        )
        return { items: page.rows.map(row => select(kit.views.environment, row, kit.fields(query.fields))), next_cursor: page.next_cursor }
      },
      {
        params: t.Object({ project: t.String() }),
        query: t.Object({ ...listQuery, ephemeral: t.Optional(t.BooleanString()), protected: t.Optional(t.BooleanString()) }),
        response: replies({ 200: Page(Environment) }),
        detail: { summary: 'List the environments of a project', tags }
      }
    )
    .get(
      '/environments/:environment',
      async ({ request, params, query }) => {
        const principal = await kit.principal(request)
        const ctx = environmentById(db, params.environment)
        requireLevel(principal, ctx.target, 'read')
        return select(kit.views.environment, ctx.environment, kit.fields(query.fields))
      },
      { params: t.Object({ environment: t.String() }), query: t.Object(getQuery), response: replies({ 200: Environment }), detail: { summary: 'Get an environment', tags } }
    )
    .post(
      '/projects/:project/environments',
      async ({ request, params, body, set }) => {
        const call = await kit.call(request)
        const proj = projectByRef(db, params.project)
        const ephemeral = body.ephemeral ?? false
        requireLevel(call.principal, { project_id: proj.id, environment_id: '*' }, ephemeral ? 'deploy' : 'admin')
        if (body.protected) requireHuman(call.principal, 'Creating a protected environment', { protected: true })
        if (ephemeral && body.ttl_seconds === undefined) fail('VALIDATION_FAILED', 'ttl_seconds is required for an ephemeral environment.', undefined, { issues: [{ path: '/ttl_seconds', message: 'required when ephemeral' }] })
        if (db.select({ id: environment.id }).from(environment).where(and(eq(environment.project_id, proj.id), eq(environment.name, body.name))).get()) {
          fail('NAME_TAKEN', `Project ${proj.name} already has an environment named ${body.name}.`, undefined, { name: body.name })
        }
        const source = body.source_environment_id ? environmentInProject(db, proj, body.source_environment_id) : null
        if (source) requireLevel(call.principal, environmentTarget(source), 'read')
        const id = newId('environment')
        db.insert(environment)
          .values({
            id,
            project_id: proj.id,
            name: body.name,
            protected: body.protected ?? false,
            ephemeral,
            source_environment_id: source?.id ?? null,
            ttl_seconds: body.ttl_seconds ?? null
          })
          .run()
        const created = db.select().from(environment).where(eq(environment.id, id)).get()!
        audit(db, call, 'environment.create', { entity: 'environment', id }, { after: { name: body.name, project_id: proj.id, source_environment_id: source?.id ?? null, protected: created.protected, ephemeral } })
        emit(db, 'environment.created', { entity: 'environment', id, project_id: proj.id })
        const cloned = source ? cloneInto(kit, call, proj, source, created, body.deploy_on_create ?? true) : { warnings: [], deployments: [] }
        set.status = 201
        return {
          ...select(kit.views.environment, db.select().from(environment).where(eq(environment.id, id)).get()!, kit.fields('services')),
          deployments: cloned.deployments.map(id => select(kit.views.deployment, db.select().from(deployment).where(eq(deployment.id, id)).get()!, undefined)),
          warnings: cloned.warnings
        }
      },
      {
        params: t.Object({ project: t.String() }),
        body: t.Object(
          {
            name: t.String({ pattern: slugPattern }),
            source_environment_id: t.Optional(t.String()),
            ephemeral: t.Optional(t.Boolean()),
            ttl_seconds: t.Optional(t.Integer({ minimum: 60 })),
            deploy_on_create: t.Optional(t.Boolean()),
            protected: t.Optional(t.Boolean())
          },
          { additionalProperties: false }
        ),
        response: replies({ 201: EnvironmentCreated }),
        detail: { summary: 'Create an environment, empty or as a clone of source_environment_id', tags }
      }
    )
    .patch(
      '/environments/:environment',
      async ({ request, params, body }) => {
        const call = await kit.call(request)
        const ctx = environmentById(db, params.environment)
        requireLevel(call.principal, ctx.target, 'admin')
        if (body.protected !== undefined && body.protected !== ctx.environment.protected) {
          requireHuman(call.principal, 'Changing environment.protected', { ...ctx.target, level: 'admin' })
        }
        db.update(environment).set(body).where(eq(environment.id, ctx.environment.id)).run()
        audit(db, call, 'environment.update', { entity: 'environment', id: ctx.environment.id }, { before: { protected: ctx.environment.protected, ttl_seconds: ctx.environment.ttl_seconds }, after: body })
        return select(kit.views.environment, db.select().from(environment).where(eq(environment.id, ctx.environment.id)).get()!, undefined)
      },
      {
        params: t.Object({ environment: t.String() }),
        body: t.Object({ protected: t.Optional(t.Boolean()), ttl_seconds: t.Optional(t.Union([t.Integer({ minimum: 60 }), t.Null()])) }, { additionalProperties: false }),
        response: replies({ 200: Environment }),
        detail: { summary: 'Update protected or ttl_seconds', tags }
      }
    )
    .delete(
      '/environments/:environment',
      async ({ request, params, set }) => {
        const call = await kit.call(request)
        const ctx = environmentById(db, params.environment)
        requireEnvironmentWrite(call.principal, ctx.environment, 'deploy')
        if (ctx.project.default_environment_id === ctx.environment.id) {
          fail('ENVIRONMENT_IS_DEFAULT', `${ctx.environment.name} is the default environment of ${ctx.project.name}.`, 'Set another default_environment_id on the project first.')
        }
        requireNoSandboxes(db, ctx.environment)
        const changes = new ChangeSet()
        changes.remove('environment', ctx.environment.id, select(kit.views.environment, ctx.environment, undefined))
        const result = commit(kit.deps, call, { environment: ctx.environment, protect: ctx.environment.protected }, changes)
        if (!result.applied) return kit.stagedBody(result, set)
        audit(db, call, 'environment.delete', { entity: 'environment', id: ctx.environment.id }, { before: { name: ctx.environment.name } })
        emit(db, 'environment.deleted', { entity: 'environment', id: ctx.environment.id, project_id: ctx.project.id })
        kit.deps.stations.reconcile()
        return { deleted: true as const, volumes_retained_until: result.retained_until?.toISOString() ?? null }
      },
      { params: t.Object({ environment: t.String() }), response: replies({ 200: DeletedRetaining, 202: Staged }), detail: { summary: 'Delete an environment; staged when protected', tags } }
    )
}
