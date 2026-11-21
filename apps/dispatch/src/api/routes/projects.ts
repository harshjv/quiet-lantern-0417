import { and, desc, eq, inArray, max, ne } from 'drizzle-orm'
import { t } from 'elysia'

import { slugPattern } from '@stationly/protocol'

import { newId } from '../../db/ids.ts'
import {
  app,
  approval,
  environment_variable,
  grant,
  ipam_allocation,
  machine,
  project,
  secret_value,
  target,
  task,
  vex_statement,
  virtual_ip,
  volume,
} from '../../db/schema.ts'
import { requestDeletion } from '../../sandboxes/lifecycle.ts'
import { seesProject } from '../access.ts'
import { supersedeWaiting } from '../changes.ts'
import { audit } from '../context.ts'
import { fail } from '../errors.ts'
import { project as select } from '../fields.ts'
import type { Kit } from '../kit.ts'
import { before, collect, getQuery, listQuery } from '../pagination.ts'
import { Deleted, Page, Project, replies } from '../shapes.ts'

const workshopUidStart = 2_000_000
const workshopUidStride = 65_537

export const projectRoutes = (kit: Kit) => {
  const { db } = kit.deps

  return kit
    .router('projects', '/v1')
    .get(
      '/projects',
      async ({ request, query }) => {
        const principal = await kit.principal(request)
        const page = collect(
          (cursor, size) =>
            db
              .select()
              .from(project)
              .where(
                and(
                  query.name ? eq(project.name, query.name) : undefined,
                  before(project.id, cursor),
                ),
              )
              .orderBy(desc(project.id))
              .limit(size)
              .all(),
          query,
          (row) => seesProject(principal, row.id),
        )

        return {
          items: page.rows.map((row) => select(kit.views.project, row, kit.fields(query.fields))),
          next_cursor: page.next_cursor,
        }
      },
      {
        operation: {
          id: 'list_projects',
          summary: 'List projects visible to the caller',
          level: 'any',
        },
        query: t.Object({
          ...listQuery,
          name: t.Optional(
            t.String({
              description: 'Only the project with this name',
            }),
          ),
        }),
        response: replies({
          200: Page(Project),
        }),
      },
    )
    .get(
      '/projects/:project',
      ({ ctx, query }) => select(kit.views.project, ctx.project, kit.fields(query.fields)),
      {
        project: {
          id: 'get_project',
          summary: 'Get a project by id or name',
          level: 'read',
        },
        query: t.Object(getQuery),
        response: replies({
          200: Project,
        }),
      },
    )
    .post(
      '/projects',
      async ({ request, body, set }) => {
        const call = await kit.call(request)

        if (
          db
            .select({
              id: project.id,
            })
            .from(project)
            .where(eq(project.name, body.name))
            .get()
        ) {
          fail('NAME_TAKEN', `A project named ${body.name} exists.`, undefined, {
            name: body.name,
          })
        }

        const projectId = newId('project')
        const productionId = newId('target')
        const created = db.transaction((tx) => {
          const top = tx
            .select({
              base: max(project.workshop_uid_base),
            })
            .from(project)
            .get()?.base

          tx.insert(project)
            .values({
              id: projectId,
              name: body.name,
              workshop_uid_base:
                top === null || top === undefined ? workshopUidStart : top + workshopUidStride,
            })
            .run()
          tx.insert(target)
            .values({
              id: productionId,
              project_id: projectId,
              kind: 'production',
              name: 'production',
              origin: null,
            })
            .run()
          audit(
            tx,
            call,
            'project.create',
            {
              entity: 'project',
              id: projectId,
            },
            {
              after: {
                name: body.name,
              },
            },
          )

          return tx.select().from(project).where(eq(project.id, projectId)).get()!
        })

        set.status = 201

        return select(kit.views.project, created, kit.fields('apps'))
      },
      {
        body: t.Object(
          {
            name: t.String({
              pattern: slugPattern,
              description: 'The project name',
            }),
          },
          {
            additionalProperties: false,
          },
        ),
        operation: {
          id: 'create_project',
          summary: 'Create a project; its production comes with it',
          level: 'admin',
          cli: {
            args: ['name'],
          },
        },
        response: replies({
          201: Project,
        }),
      },
    )
    .patch(
      '/projects/:project',
      async ({ ctx, request, body }) => {
        const call = await kit.call(request)
        const row = ctx.project

        const beforeRow = select(kit.views.project, row, kit.fields('*'))

        db.update(project).set(body).where(eq(project.id, row.id)).run()
        const updated = db.select().from(project).where(eq(project.id, row.id)).get()!

        audit(
          db,
          call,
          'project.update',
          {
            entity: 'project',
            id: row.id,
          },
          {
            before: beforeRow,
            after: body,
          },
        )

        return select(kit.views.project, updated, undefined)
      },
      {
        body: t.Object(
          {
            manifest_path: t.Optional(
              t.Union([t.String(), t.Null()], {
                description: 'The path of the Manifest in the connected repository',
              }),
            ),
            build_cache_bytes: t.Optional(
              t.Integer({
                minimum: 0,
                description: 'The Workshop build cache limit',
              }),
            ),
            image_retention_count: t.Optional(
              t.Integer({
                minimum: 1,
                description: 'Images kept per app in Depot, besides those of active deployments',
              }),
            ),
            base_image_auto_rebuild: t.Optional(
              t.Boolean({
                description: 'Rebuild and deploy when a base image digest moves',
              }),
            ),
            pull_request_previews: t.Optional(
              t.Boolean({
                description: 'A pull request on the project gets a preview',
              }),
            ),
          },
          {
            additionalProperties: false,
          },
        ),
        project: {
          id: 'update_project',
          summary: 'Update a project',
          level: 'admin',
        },
        response: replies({
          200: Project,
        }),
      },
    )
    .delete(
      '/projects/:project',
      async ({ ctx, request }) => {
        const call = await kit.call(request)
        const row = ctx.project

        if (row.shared) {
          fail('DELETE_HAS_DEPENDENTS', 'The Shared project cannot be deleted.')
        }

        const others = db
          .select({
            id: target.id,
            name: target.name,
          })
          .from(target)
          .where(and(eq(target.project_id, row.id), eq(target.kind, 'preview')))
          .all()
        const envIds = db
          .select({
            id: target.id,
          })
          .from(target)
          .where(eq(target.project_id, row.id))
          .all()
          .map((e) => e.id)
        const apps = envIds.length
          ? db
              .select({
                id: app.id,
                name: app.name,
              })
              .from(app)
              .where(inArray(app.target_id, envIds))
              .all()
          : []
        const tasks = db
          .select({
            id: task.id,
            name: task.title,
          })
          .from(task)
          .where(eq(task.project_id, row.id))
          .all()

        if (others.length || apps.length || tasks.length) {
          fail(
            'DELETE_HAS_DEPENDENTS',
            `Project ${row.name} still has previews, apps or tasks.`,
            'Delete every preview, every app and every task first.',
            {
              dependents: [
                ...others.map((e) => ({
                  entity: 'preview',
                  id: e.id,
                  name: e.name,
                })),
                ...apps.map((s) => ({
                  entity: 'app',
                  id: s.id,
                  name: s.name,
                })),
                ...tasks.map((t) => ({
                  entity: 'task',
                  id: t.id,
                  name: t.name,
                })),
              ],
            },
          )
        }

        const computers = envIds.length
          ? db
              .select()
              .from(machine)
              .where(and(inArray(machine.target_id, envIds), ne(machine.status, 'deleting')))
              .all()
          : []

        db.transaction((tx) => {
          for (const box of computers) {
            requestDeletion(tx, box, {
              actor: call.principal.actor,
              reason: 'user',
            })
          }

          const vars = tx
            .select({
              id: environment_variable.id,
            })
            .from(environment_variable)
            .where(eq(environment_variable.project_id, row.id))
            .all()
            .map((v) => v.id)

          if (vars.length) {
            tx.delete(grant).where(inArray(grant.environment_variable_id, vars)).run()
            tx.delete(secret_value).where(inArray(secret_value.environment_variable_id, vars)).run()
            tx.delete(environment_variable).where(inArray(environment_variable.id, vars)).run()
          }

          tx.delete(grant).where(eq(grant.project_id, row.id)).run()
          tx.delete(vex_statement).where(eq(vex_statement.project_id, row.id)).run()

          supersedeWaiting(tx, eq(approval.project_id, row.id))

          if (envIds.length) {
            tx.delete(ipam_allocation).where(inArray(ipam_allocation.target_id, envIds)).run()
            tx.delete(virtual_ip).where(inArray(virtual_ip.target_id, envIds)).run()
            tx.delete(target).where(inArray(target.id, envIds)).run()
          }

          tx.update(volume)
            .set({
              project_id: null,
            })
            .where(eq(volume.project_id, row.id))
            .run()
          tx.delete(project).where(eq(project.id, row.id)).run()
          audit(
            tx,
            call,
            'project.delete',
            {
              entity: 'project',
              id: row.id,
            },
            {
              before: {
                name: row.name,
              },
            },
          )
        })

        for (const server of new Set(computers.map((box) => box.server_id))) {
          kit.deps.stations.reconcile(server)
        }

        return {
          deleted: true as const,
        }
      },
      {
        project: {
          id: 'delete_project',
          summary: 'Delete an empty project',
          level: 'admin',
        },
        response: replies({
          200: Deleted,
        }),
      },
    )
}
