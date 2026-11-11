import { and, desc, eq, inArray, max, ne } from 'drizzle-orm'
import { t } from 'elysia'

import { slugPattern } from '@stationly/protocol'

import { newId } from '../../db/ids.ts'
import {
  environment,
  grant,
  project,
  sandbox,
  secret_value,
  service,
  staged_change,
  staged_value,
  variable,
  vex_statement,
  volume,
} from '../../db/schema.ts'
import { seesProject } from '../access.ts'
import { removeEnvironment } from '../changes.ts'
import { audit, emit } from '../context.ts'
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
        const environmentId = newId('environment')
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
              default_environment_id: environmentId,
              workshop_uid_base:
                top === null || top === undefined ? workshopUidStart : top + workshopUidStride,
              pr_environments: {
                enabled: false,
                source_environment_id: null,
              },
            })
            .run()
          tx.insert(environment)
            .values({
              id: environmentId,
              project_id: projectId,
              name: body.default_environment_name ?? 'production',
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
                default_environment_id: environmentId,
              },
            },
          )
          emit(tx, 'environment.created', {
            entity: 'environment',
            id: environmentId,
            project_id: projectId,
          })

          return tx.select().from(project).where(eq(project.id, projectId)).get()!
        })

        set.status = 201

        return select(kit.views.project, created, kit.fields('environments'))
      },
      {
        body: t.Object(
          {
            name: t.String({
              pattern: slugPattern,
              description: 'The project name',
            }),
            default_environment_name: t.Optional(
              t.String({
                pattern: slugPattern,
                description: 'The name of the environment created with it (default production)',
              }),
            ),
          },
          {
            additionalProperties: false,
          },
        ),
        operation: {
          id: 'create_project',
          summary: 'Create a project with its default environment',
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

        if (body.default_environment_id) {
          const env = db
            .select()
            .from(environment)
            .where(eq(environment.id, body.default_environment_id))
            .get()

          if (!env || env.project_id !== row.id) {
            fail(
              'VALIDATION_FAILED',
              'default_environment_id must name an environment of this project.',
              undefined,
              {
                issues: [
                  {
                    path: '/default_environment_id',
                    message: 'not in this project',
                  },
                ],
              },
            )
          }
        }

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
            default_environment_id: t.Optional(
              t.String({
                description: 'The environment commands use when none is given',
              }),
            ),
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
                description:
                  'Images kept per service in Depot, besides those of active deployments',
              }),
            ),
            base_image_auto_rebuild: t.Optional(
              t.Boolean({
                description: 'Rebuild and deploy when a base image digest moves',
              }),
            ),
            pr_environments: t.Optional(
              t.Object(
                {
                  enabled: t.Boolean(),
                  source_environment_id: t.Union([t.String(), t.Null()]),
                },
                {
                  description: 'Pull request environments: enabled, and the environment they clone',
                },
              ),
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
            id: environment.id,
            name: environment.name,
          })
          .from(environment)
          .where(
            and(eq(environment.project_id, row.id), ne(environment.id, row.default_environment_id)),
          )
          .all()
        const envIds = db
          .select({
            id: environment.id,
          })
          .from(environment)
          .where(eq(environment.project_id, row.id))
          .all()
          .map((e) => e.id)
        const services = envIds.length
          ? db
              .select({
                id: service.id,
                name: service.name,
              })
              .from(service)
              .where(inArray(service.environment_id, envIds))
              .all()
          : []
        const boxes = envIds.length
          ? db
              .select({
                id: sandbox.id,
                name: sandbox.name,
              })
              .from(sandbox)
              .where(and(inArray(sandbox.environment_id, envIds), ne(sandbox.status, 'deleting')))
              .all()
          : []

        if (others.length || services.length || boxes.length) {
          fail(
            'DELETE_HAS_DEPENDENTS',
            `Project ${row.name} still has environments, services or sandboxes.`,
            'Delete every service, every sandbox and every environment other than the default first.',
            {
              dependents: [
                ...others.map((e) => ({
                  entity: 'environment',
                  id: e.id,
                  name: e.name,
                })),
                ...services.map((s) => ({
                  entity: 'service',
                  id: s.id,
                  name: s.name,
                })),
                ...boxes.map((b) => ({
                  entity: 'sandbox',
                  id: b.id,
                  name: b.name,
                })),
              ],
            },
          )
        }

        db.transaction((tx) => {
          const vars = tx
            .select({
              id: variable.id,
            })
            .from(variable)
            .where(eq(variable.project_id, row.id))
            .all()
            .map((v) => v.id)

          if (vars.length) {
            tx.delete(grant).where(inArray(grant.variable_id, vars)).run()
            tx.delete(secret_value).where(inArray(secret_value.variable_id, vars)).run()
            tx.delete(variable).where(inArray(variable.id, vars)).run()
          }

          tx.delete(grant).where(eq(grant.project_id, row.id)).run()
          tx.delete(vex_statement).where(eq(vex_statement.project_id, row.id)).run()

          if (envIds.length) {
            const pending = tx
              .select({
                id: staged_change.id,
              })
              .from(staged_change)
              .where(
                and(
                  inArray(staged_change.environment_id, envIds),
                  eq(staged_change.status, 'staged'),
                ),
              )
              .all()
              .map((s) => s.id)

            if (pending.length) {
              tx.delete(staged_value).where(inArray(staged_value.staged_change_id, pending)).run()
              tx.update(staged_change)
                .set({
                  status: 'superseded',
                })
                .where(inArray(staged_change.id, pending))
                .run()
            }

            for (const id of envIds) {
              removeEnvironment(tx, id)
            }
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

          for (const id of envIds) {
            emit(tx, 'environment.deleted', {
              entity: 'environment',
              id,
              project_id: row.id,
            })
          }
        })

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
