import { createHash, randomBytes } from 'node:crypto'
import { isIPv4 } from 'node:net'

import { Type } from '@sinclair/typebox'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { t } from 'elysia'

import { enrollTokenPrefix, serverStatusValues, slugPattern } from '@stationly/protocol'

import type { Db } from '../../db/client.ts'
import { newId } from '../../db/ids.ts'
import { app, machine, server, token } from '../../db/schema.ts'
import { readSetting } from '../../db/settings.ts'
import { runtimeRefusal } from '../../sandboxes/runtime.ts'
import { ChangeSet, commit } from '../changes.ts'
import { audit } from '../context.ts'
import { fail, invalid } from '../errors.ts'
import { project as select } from '../fields.ts'
import type { Kit } from '../kit.ts'
import { stationByRef } from '../lookup.ts'
import { before, collect, filterOne, getQuery, listQuery } from '../pagination.ts'
import { ApprovalDetail, Page, replies, Server } from '../shapes.ts'
import { drainRefusal, stationFields } from '../station-fields.ts'

const intermittent = t.Optional(
  t.Boolean({
    description: 'The server sleeps at times: asleep instead of offline when heartbeats stop',
  }),
)

const Removed = Type.Object(
  {
    deleted: Type.Literal(true),
    revoked_at: Type.String(),
    disconnected: Type.Optional(Type.Boolean()),
  },
  {
    additionalProperties: false,
  },
)
const Enrollment = Type.Object(
  {
    server: Server,
    enroll_token: Type.String(),
    enroll_token_id: Type.String(),
    expires_at: Type.String(),
    command: Type.String(),
  },
  {
    additionalProperties: false,
  },
)

export const enrollTokenSeconds = 15 * 60
export const enrollTokenSha256 = (value: string) =>
  createHash('sha256').update(value, 'utf8').digest('hex')

type StationStatus = (typeof server.$inferSelect)['status']

export const stationRoutes = (kit: Kit) => {
  const { db } = kit.deps

  return kit
    .router('servers', '/v1')
    .get(
      '/servers',
      ({ query }) => {
        const page = collect(
          (cursor, size) =>
            db
              .select()
              .from(server)
              .where(
                and(
                  query.status ? eq(server.status, query.status as StationStatus) : undefined,
                  query.revoked ? undefined : isNull(server.revoked_at),
                  before(server.id, cursor),
                ),
              )
              .orderBy(desc(server.id))
              .limit(size)
              .all(),
          query,
        )

        return {
          items: page.rows.map((row) => select(kit.views.station, row, kit.fields(query.fields))),
          next_cursor: page.next_cursor,
        }
      },
      {
        operation: {
          id: 'list_servers',
          summary: 'List servers; removed servers only with revoked = true',
          level: 'instance read',
        },
        query: t.Object({
          ...listQuery,
          status: filterOne(serverStatusValues),
          revoked: t.Optional(
            t.BooleanString({
              description: 'Include removed servers',
            }),
          ),
        }),
        response: replies({
          200: Page(Server),
        }),
      },
    )
    .get(
      '/servers/:server',
      ({ params, query }) => {
        return select(kit.views.station, stationByRef(db, params.server), kit.fields(query.fields))
      },
      {
        operation: {
          id: 'get_server',
          summary: 'Get a server by id or name',
          level: 'instance read',
        },
        query: t.Object(getQuery),
        response: replies({
          200: Server,
        }),
      },
    )
    .patch(
      '/servers/:server',
      async ({ request, params, body, set }) => {
        const call = await kit.call(request)
        const row = stationByRef(db, params.server)

        if (row.revoked_at) {
          fail('VALIDATION_FAILED', `Server ${row.name} was removed.`, undefined, {
            issues: [
              {
                path: '/server',
                message: 'server is revoked',
              },
            ],
          })
        }

        const issues: { path: string; message: string }[] = []

        if (!Object.keys(body).length) {
          issues.push({
            path: '/',
            message:
              'send at least one of public_address, concurrency_cap, draining, intermittent, machine_limits, default_machine_runtime',
          })
        }

        if (body.sleep_schedule !== undefined) {
          issues.push({
            path: '/sleep_schedule',
            message: 'sleep schedules arrive in phase 2',
          })
        }

        if (body.public_address !== undefined && !isIPv4(body.public_address)) {
          issues.push({
            path: '/public_address',
            message: 'must be an IPv4 address in dotted-quad form',
          })
        }

        const refusal = body.draining === true ? drainRefusal(row) : null

        if (refusal) {
          issues.push({
            path: '/draining',
            message: refusal,
          })
        }

        const runtimeProblem =
          body.default_machine_runtime === undefined
            ? null
            : runtimeRefusal(row, body.default_machine_runtime)

        if (runtimeProblem) {
          issues.push({
            path: '/default_machine_runtime',
            message: runtimeProblem,
          })
        }

        if (issues.length) {
          invalid(issues)
        }

        const current = {
          public_address: row.public_address,
          concurrency_cap: row.concurrency_cap,
          draining: row.draining,
          intermittent: row.intermittent,
          machine_limits: row.machine_limits,
          default_machine_runtime: row.default_machine_runtime,
        }
        const wantedLimits =
          body.machine_limits === undefined
            ? undefined
            : {
                ...row.machine_limits,
                ...body.machine_limits,
              }
        const changes = new ChangeSet()
        const before: Record<string, unknown> = {}
        const after: Record<string, unknown> = {}

        for (const field of stationFields) {
          const wanted = field === 'machine_limits' ? wantedLimits : body[field]

          if (wanted === undefined || JSON.stringify(wanted) === JSON.stringify(current[field])) {
            continue
          }

          changes.update('server', row.id, `/${field}`, current[field], wanted)
          before[field] = current[field]
          after[field] = wanted
        }

        const shown = kit.fields(
          'public_address,intermittent,machine_limits,default_machine_runtime,machine_runtime_advice',
        )

        if (changes.empty) {
          return select(kit.views.station, row, shown)
        }

        const protect = readSetting(db, 'platform.protected') && !call.principal.human
        const result = commit(
          kit.deps,
          call,
          {
            target: null,
            protect,
          },
          changes,
        )

        if (!result.applied) {
          return kit.approvalBody(result, set)
        }

        audit(
          db,
          call,
          'server.update',
          {
            entity: 'server',
            id: row.id,
          },
          {
            before,
            after,
          },
        )

        if ('public_address' in after && row.hosts_dispatch) {
          kit.deps.auth.rebuild()
        }

        return select(
          kit.views.station,
          db.select().from(server).where(eq(server.id, row.id)).get()!,
          shown,
        )
      },
      {
        operation: {
          id: 'update_server',
          summary:
            'Change a server: public_address, concurrency_cap, draining (no new deployments are placed on it), intermittent, machine_limits and default_machine_runtime; sleep_schedule is phase 2',
          level: 'instance admin',
        },
        body: t.Object(
          {
            public_address: t.Optional(
              t.String({
                description: 'The IPv4 address domains and TCP exposures reach the server on',
              }),
            ),
            concurrency_cap: t.Optional(
              t.Integer({
                minimum: 1,
                description: 'Deployments the server runs at once',
              }),
            ),
            draining: t.Optional(
              t.Boolean({
                description: 'Place no new deployments on it; running apps stay',
              }),
            ),
            intermittent: intermittent,
            machine_limits: t.Optional(
              t.Object(
                {
                  max_machines: t.Optional(
                    t.Integer({
                      minimum: 0,
                    }),
                  ),
                  max_running: t.Optional(
                    t.Integer({
                      minimum: 0,
                    }),
                  ),
                  memory_bytes: t.Optional(
                    t.Union([
                      t.Integer({
                        minimum: 1,
                      }),
                      t.Null(),
                    ]),
                  ),
                  min_free_bytes: t.Optional(
                    t.Union([
                      t.Integer({
                        minimum: 0,
                      }),
                      t.Null(),
                    ]),
                  ),
                },
                {
                  additionalProperties: false,
                },
              ),
            ),
            default_machine_runtime: t.Optional(
              t.Nullable(
                t.String({
                  description:
                    'a runtime the server offers in capabilities.machines.runtimes, or null to follow the recommendation from its host probe',
                }),
              ),
            ),
            sleep_schedule: t.Optional(t.Any()),
          },
          {
            additionalProperties: false,
          },
        ),
        response: replies({
          200: Server,
          202: ApprovalDetail,
        }),
      },
    )
    .delete(
      '/servers/:server',
      async ({ request, params }) => {
        const call = await kit.call(request)
        const row = stationByRef(db, params.server)

        if (row.revoked_at) {
          return {
            deleted: true as const,
            revoked_at: row.revoked_at.toISOString(),
          }
        }

        const apps = db
          .select({
            id: app.id,
            name: app.name,
          })
          .from(app)
          .where(eq(app.server_id, row.id))
          .all()
        const boxes = db
          .select({
            id: machine.id,
            name: machine.name,
          })
          .from(machine)
          .where(eq(machine.server_id, row.id))
          .all()

        if (apps.length || boxes.length) {
          fail(
            'DELETE_HAS_DEPENDENTS',
            `Server ${row.name} still runs ${apps.length} apps and ${boxes.length} machines.`,
            'Move or delete its apps and delete its machines first.',
            {
              dependents: [
                ...apps.map((s) => ({
                  entity: 'app',
                  ...s,
                })),
                ...boxes.map((b) => ({
                  entity: 'machine',
                  ...b,
                })),
              ],
            },
          )
        }

        const revokedAt = new Date()

        db.update(server)
          .set({
            revoked_at: revokedAt,
            status: 'offline',
          })
          .where(eq(server.id, row.id))
          .run()
        audit(
          db,
          call,
          'server.remove',
          {
            entity: 'server',
            id: row.id,
          },
          {
            before: {
              status: row.status,
            },
            after: {
              revoked_at: revokedAt.toISOString(),
            },
          },
        )
        const disconnected = kit.deps.stations.revoke(row.id, revokedAt)

        return {
          deleted: true as const,
          revoked_at: revokedAt.toISOString(),
          disconnected,
        }
      },
      {
        operation: {
          id: 'remove_server',
          summary: 'Remove a server: its key is revoked and kept, so it is told STATION_REVOKED',
          level: 'instance admin',
        },
        response: replies({
          200: Removed,
        }),
      },
    )
    .post(
      '/servers',
      async ({ request, body, set }) => {
        const call = await kit.call(request)

        if (
          db
            .select({
              id: server.id,
            })
            .from(server)
            .where(eq(server.name, body.name))
            .get()
        ) {
          fail('NAME_TAKEN', `A server named ${body.name} exists.`, undefined, {
            name: body.name,
          })
        }

        const secret = `${enrollTokenPrefix}${randomBytes(32).toString('base64url')}`
        const expiresAt = new Date(Date.now() + enrollTokenSeconds * 1000)
        const stationId = newId('server')
        const tokenId = newId('token')

        db.transaction((tx) => {
          const tdb = tx as unknown as Db

          tdb
            .insert(server)
            .values({
              id: stationId,
              name: body.name,
              intermittent: body.intermittent ?? false,
              status: 'enrolling',
            })
            .run()
          tdb
            .insert(token)
            .values({
              id: tokenId,
              user_id: call.principal.user_id,
              name: `enroll/${body.name}`,
              kind: 'server_enroll',
              scopes: [],
              expires_at: expiresAt,
              secret_sha256: enrollTokenSha256(secret),
              server_id: stationId,
            })
            .run()
          audit(
            tdb,
            call,
            'server.create',
            {
              entity: 'server',
              id: stationId,
            },
            {
              after: {
                name: body.name,
                enroll_token_id: tokenId,
                expires_at: expiresAt.toISOString(),
              },
            },
          )
        })
        set.status = 201

        return {
          server: select(
            kit.views.station,
            db.select().from(server).where(eq(server.id, stationId)).get()!,
            undefined,
          ),
          enroll_token: secret,
          enroll_token_id: tokenId,
          expires_at: expiresAt.toISOString(),
          command: `stationd enroll ${secret} --dispatch-url ${kit.deps.auth.surface.apiOrigin}`,
        }
      },
      {
        operation: {
          id: 'enroll_server',
          summary:
            'Create a server in enrolling state and a one-time enrollment token (15 minutes)',
          level: 'instance admin',
          cli: {
            args: ['name'],
          },
        },
        body: t.Object(
          {
            name: t.String({
              pattern: slugPattern,
              description: 'The server name',
            }),
            intermittent,
          },
          {
            additionalProperties: false,
          },
        ),
        response: replies({
          201: Enrollment,
        }),
      },
    )
}
