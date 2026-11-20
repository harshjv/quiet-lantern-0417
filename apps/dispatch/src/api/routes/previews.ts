import { Type } from '@sinclair/typebox'
import { and, asc, desc, eq } from 'drizzle-orm'
import { t } from 'elysia'

import { slugPattern } from '@stationly/protocol'

import type { Db } from '../../db/client.ts'
import { newId } from '../../db/ids.ts'
import { app, app_port, deployment, target, volume, type PreviewOrigin } from '../../db/schema.ts'
import { DomainError } from '../../errors.ts'
import { decryptValue, headValue, variablesOf } from '../../secrets/values.ts'
import { setVariable, type VariableWrite } from '../../secrets/variables.ts'
import { seesTarget } from '../access.ts'
import { ChangeSet, commit, requireNoMachines } from '../changes.ts'
import { audit, emit, type Call } from '../context.ts'
import { createDeploymentRecord } from '../deployments.ts'
import { createApp, createAppPort, createVolume } from '../entities.ts'
import { fail } from '../errors.ts'
import { project as select } from '../fields.ts'
import { warning, type Kit } from '../kit.ts'
import { productionOf, projectByRef, scopeOf, type ProjectRow, type TargetRow } from '../lookup.ts'
import { before, collect, getQuery, listQuery } from '../pagination.ts'
import type { TargetInput } from '../route-meta.ts'
import {
  DeletedRetaining,
  Deployment,
  extend,
  Page,
  Preview,
  replies,
  Warnings,
} from '../shapes.ts'
import { settleVariableWrites } from '../stale.ts'

const ttlText = 'Seconds until the preview is deleted; omit for a preview that never expires'

const valueTargets = ['production', 'preview'] as const

const PreviewCreated = extend(Preview, {
  deployments: Type.Array(Deployment),
  warnings: Warnings,
})

const expiry = (ttl: number | null | undefined) =>
  ttl === undefined || ttl === null ? null : new Date(Date.now() + ttl * 1000)

export const createPreview = (
  kit: { deps: Pick<Kit['deps'], 'db' | 'keyring'> },
  call: Call,
  proj: ProjectRow,
  input: { name: string; origin: PreviewOrigin; expires_at: Date | null; deploy: boolean },
) => {
  const db = kit.deps.db

  if (
    db
      .select({
        id: target.id,
      })
      .from(target)
      .where(and(eq(target.project_id, proj.id), eq(target.name, input.name)))
      .get()
  ) {
    fail(
      'NAME_TAKEN',
      `Project ${proj.name} already has a preview named ${input.name}.`,
      undefined,
      {
        name: input.name,
      },
    )
  }

  const id = newId('target')

  return db.transaction(() => {
    db.insert(target)
      .values({
        id,
        project_id: proj.id,
        kind: 'preview',
        name: input.name,
        origin: input.origin,
        expires_at: input.expires_at,
      })
      .run()
    const created = db.select().from(target).where(eq(target.id, id)).get()!

    audit(
      db,
      call,
      'preview.create',
      {
        entity: 'preview',
        id,
      },
      {
        after: {
          name: input.name,
          project_id: proj.id,
          origin: input.origin,
        },
      },
    )
    emit(db, 'preview.created', {
      entity: 'preview',
      id,
      project_id: proj.id,
    })

    return {
      preview: created,
      ...cloneInto(kit, call, proj, productionOf(db, proj.id), created, input.deploy),
    }
  })
}

export const cloneInto = (
  kit: { deps: Pick<Kit['deps'], 'db' | 'keyring'> },
  call: Call,
  proj: ProjectRow,
  source: TargetRow,
  into: TargetRow,
  deploy: boolean,
) => {
  const db = kit.deps.db
  const warnings: { code: string; explanation: string }[] = []
  const copied: string[] = []
  const decrypted: string[] = []
  const writes: VariableWrite[] = []
  const apps = db.select().from(app).where(eq(app.target_id, source.id)).orderBy(asc(app.id)).all()
  const copyable = (v: { kind: string }, head: Parameters<typeof decryptValue>[1]) => {
    const value = decryptValue(kit.deps.keyring, head)

    return v.kind === 'secret' ? value : value.replaceAll('${{', () => '$${{')
  }

  db.transaction((tx) => {
    const tdb = tx as unknown as Db
    const idMap = new Map<string, string>()

    for (const svc of apps) {
      const {
        id: _id,
        created_at: _c,
        updated_at: _u,
        current_deployment_id: _d,
        target_id: _t,
        status: _s,
        status_reason: _sr,
        stale: _st,
        exports: _x,
        ...rest
      } = svc
      const id = createApp(tdb, {
        ...rest,
        target_id: into.id,
        desired_state: 'running',
      })

      idMap.set(svc.id, id)

      for (const port of tdb.select().from(app_port).where(eq(app_port.app_id, svc.id)).all()) {
        createAppPort(tdb, id, port)
      }

      for (const vol of tdb
        .select()
        .from(volume)
        .where(and(eq(volume.app_id, svc.id), eq(volume.owner, 'service')))
        .all()) {
        createVolume(
          tdb,
          {
            id,
            server_id: svc.server_id,
            project_id: proj.id,
          },
          vol.mount_path,
        )
      }

      copied.push(id)
    }

    for (const svc of apps) {
      for (const v of variablesOf(tdb, {
        scope: 'app',
        id: svc.id,
      }).all()) {
        const values = valueTargets
          .filter((t) => v.kind !== 'secret' || t === 'preview')
          .flatMap((t) => {
            const head = v.reference === null ? headValue(tdb, v.id, t) : undefined

            return head
              ? [
                  {
                    target: t,
                    head,
                  },
                ]
              : []
          })
        const write = (value: string, valueTarget: 'production' | 'preview', empty: boolean) => {
          const result = setVariable(tdb, kit.deps.keyring, {
            scope: 'app',
            app_id: idMap.get(svc.id)!,
            name: v.name,
            value,
            target: valueTarget,
            secret: v.kind === 'secret',
            empty,
            injection: v.injection,
            build: v.build,
            allow_unresolved: true,
            actor: call.principal.actor,
            request_id: call.request_id,
          })

          if (result.write) {
            writes.push(result.write)
          }
        }

        if (v.reference !== null) {
          write(v.reference, 'production', false)
          continue
        }

        if (!values.length) {
          if (v.kind === 'secret') {
            write('', 'production', true)
          }

          continue
        }

        for (const { target: valueTarget, head } of values) {
          decrypted.push(head.id)
          write(copyable(v, head), valueTarget, false)
        }
      }
    }

    settleVariableWrites(tdb, writes)

    if (decrypted.length) {
      audit(
        tdb,
        call,
        'secret.decrypt',
        {
          entity: 'preview',
          id: into.id,
        },
        {
          purpose: 'export',
          after: {
            secret_value_ids: decrypted,
            source_id: source.id,
          },
        },
      )
    }
  })
  const deployments: string[] = []

  if (deploy) {
    for (const id of copied) {
      try {
        deployments.push(
          createDeploymentRecord(db, {
            app_id: id,
            trigger: 'manual',
            actor: call.principal.actor,
            supersede: false,
          }).id,
        )
      } catch (error) {
        if (!(error instanceof DomainError)) {
          throw error
        }

        warnings.push(
          warning(error.code as string, `App ${id} was cloned but not deployed: ${error.message}`),
        )
      }
    }
  }

  return {
    warnings,
    deployments,
  }
}

export const previewRoutes = (kit: Kit) => {
  const { db } = kit.deps

  return kit
    .router('previews', '/v1')
    .get(
      '/projects/:project/previews',
      async ({ request, params, query }) => {
        const principal = await kit.principal(request)
        const proj = projectByRef(db, params.project)
        const page = collect(
          (cursor, size) =>
            db
              .select()
              .from(target)
              .where(
                and(
                  eq(target.project_id, proj.id),
                  eq(target.kind, 'preview'),
                  before(target.id, cursor),
                ),
              )
              .orderBy(desc(target.id))
              .limit(size)
              .all(),
          query,
          (row) => seesTarget(principal, scopeOf(row)),
        )

        return {
          items: page.rows.map((row) => select(kit.views.preview, row, kit.fields(query.fields))),
          next_cursor: page.next_cursor,
        }
      },
      {
        operation: {
          id: 'list_previews',
          summary: 'List the previews of a project',
          level: 'any',
        },
        query: t.Object(listQuery),
        response: replies({
          200: Page(Preview),
        }),
      },
    )
    .get(
      '/previews/:preview',
      ({ ctx, query }) => select(kit.views.preview, ctx.target_row, kit.fields(query.fields)),
      {
        preview: {
          id: 'describe_preview',
          summary: 'Get a preview',
          level: 'read',
          mcp: {
            always_load: true,
          },
        },
        query: t.Object(getQuery),
        response: replies({
          200: Preview,
        }),
      },
    )
    .post(
      '/projects/:project/previews',
      async ({ params, request, body, set }) => {
        const call = await kit.call(request)
        const made = createPreview(kit, call, projectByRef(db, params.project), {
          name: body.name,
          origin: {
            type: 'named',
          },
          expires_at: expiry(body.ttl_seconds),
          deploy: body.deploy_on_create ?? true,
        })

        set.status = 201

        return {
          ...select(kit.views.preview, made.preview, kit.fields('apps')),
          deployments: made.deployments.map((id) =>
            select(
              kit.views.deployment,
              db.select().from(deployment).where(eq(deployment.id, id)).get()!,
              undefined,
            ),
          ),
          warnings: made.warnings,
        }
      },
      {
        body: t.Object(
          {
            name: t.String({
              pattern: slugPattern,
              description: 'The preview name, such as staging',
            }),
            ttl_seconds: t.Optional(
              t.Integer({
                minimum: 60,
                description: ttlText,
              }),
            ),
            deploy_on_create: t.Optional(
              t.Boolean({
                description: "Deploy the copies of production's apps at once (default true)",
              }),
            ),
          },
          {
            additionalProperties: false,
          },
        ),
        operation: {
          id: 'create_preview',
          summary: "Create a preview: a copy of production's apps, never its secret values",
          level: 'deploy',
          target: ({ params }: TargetInput) => ({
            project_id: projectByRef(db, params.project!).id,
            target: 'previews',
          }),
          cli: {
            args: ['name'],
          },
        },
        response: replies({
          201: PreviewCreated,
        }),
      },
    )
    .patch(
      '/previews/:preview',
      async ({ ctx, request, body }) => {
        const call = await kit.call(request)
        const expires_at = expiry(body.ttl_seconds)

        db.update(target)
          .set({
            expires_at,
          })
          .where(eq(target.id, ctx.target_row.id))
          .run()
        audit(
          db,
          call,
          'preview.update',
          {
            entity: 'preview',
            id: ctx.target_row.id,
          },
          {
            before: {
              expires_at: ctx.target_row.expires_at?.toISOString() ?? null,
            },
            after: {
              expires_at: expires_at?.toISOString() ?? null,
            },
          },
        )

        return select(
          kit.views.preview,
          db.select().from(target).where(eq(target.id, ctx.target_row.id)).get()!,
          undefined,
        )
      },
      {
        body: t.Object(
          {
            ttl_seconds: t.Union(
              [
                t.Integer({
                  minimum: 60,
                }),
                t.Null(),
              ],
              {
                description: ttlText,
              },
            ),
          },
          {
            additionalProperties: false,
          },
        ),
        preview: {
          id: 'update_preview',
          summary: 'Set when a preview expires',
          level: 'deploy',
        },
        response: replies({
          200: Preview,
        }),
      },
    )
    .delete(
      '/previews/:preview',
      async ({ ctx, request }) => {
        const call = await kit.call(request)

        requireNoMachines(db, ctx.target_row)
        const changes = new ChangeSet()

        changes.remove(
          'preview',
          ctx.target_row.id,
          select(kit.views.preview, ctx.target_row, undefined),
        )
        const result = commit(
          kit.deps,
          call,
          {
            target: ctx.target_row,
            protect: false,
          },
          changes,
        )

        if (!result.applied) {
          return fail('INTERNAL_ERROR', 'A preview change never waits for approval.')
        }

        audit(
          db,
          call,
          'preview.delete',
          {
            entity: 'preview',
            id: ctx.target_row.id,
          },
          {
            before: {
              name: ctx.target_row.name,
            },
          },
        )
        emit(db, 'preview.deleted', {
          entity: 'preview',
          id: ctx.target_row.id,
          project_id: ctx.project.id,
        })
        kit.deps.stations.reconcile()

        return {
          deleted: true as const,
          volumes_retained_until: result.retained_until?.toISOString() ?? null,
        }
      },
      {
        preview: {
          id: 'delete_preview',
          summary: 'Delete a preview, its apps and its network',
          level: 'deploy',
        },
        response: replies({
          200: DeletedRetaining,
        }),
      },
    )
}
