import { createHash, randomBytes } from 'node:crypto'
import { isIPv4 } from 'node:net'

import { Type } from '@sinclair/typebox'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { t } from 'elysia'

import { enrollTokenPrefix, slugPattern, stationStatusValues } from '@stationly/protocol'

import type { Db } from '../../db/client.ts'
import { newId } from '../../db/ids.ts'
import { sandbox, service, station, token } from '../../db/schema.ts'
import { readSetting } from '../../db/settings.ts'
import { runtimeRefusal } from '../../sandboxes/runtime.ts'
import { ChangeSet, commit } from '../changes.ts'
import { audit } from '../context.ts'
import { fail, invalid } from '../errors.ts'
import { project as select } from '../fields.ts'
import type { Kit } from '../kit.ts'
import { stationByRef } from '../lookup.ts'
import { before, collect, filterOne, getQuery, listQuery } from '../pagination.ts'
import { Page, replies, Staged, Station } from '../shapes.ts'
import { drainRefusal, stationFields } from '../station-fields.ts'

const intermittent = t.Optional(
  t.Boolean({
    description: 'The station sleeps at times: asleep instead of offline when heartbeats stop',
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
    station: Station,
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

type StationStatus = (typeof station.$inferSelect)['status']

export const stationRoutes = (kit: Kit) => {
  const { db } = kit.deps

  return kit
    .router('stations', '/v1')
    .get(
      '/stations',
      ({ query }) => {
        const page = collect(
          (cursor, size) =>
            db
              .select()
              .from(station)
              .where(
                and(
                  query.status ? eq(station.status, query.status as StationStatus) : undefined,
                  query.revoked ? undefined : isNull(station.revoked_at),
                  before(station.id, cursor),
                ),
              )
              .orderBy(desc(station.id))
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
          id: 'list_stations',
          summary: 'List stations; removed stations only with revoked = true',
          level: 'instance read',
        },
        query: t.Object({
          ...listQuery,
          status: filterOne(stationStatusValues),
          revoked: t.Optional(
            t.BooleanString({
              description: 'Include removed stations',
            }),
          ),
        }),
        response: replies({
          200: Page(Station),
        }),
      },
    )
    .get(
      '/stations/:station',
      ({ params, query }) => {
        return select(kit.views.station, stationByRef(db, params.station), kit.fields(query.fields))
      },
      {
        operation: {
          id: 'get_station',
          summary: 'Get a station by id or name',
          level: 'instance read',
        },
        query: t.Object(getQuery),
        response: replies({
          200: Station,
        }),
      },
    )
    .patch(
      '/stations/:station',
      async ({ request, params, body, set }) => {
        const call = await kit.call(request)
        const row = stationByRef(db, params.station)

        if (row.revoked_at) {
          fail('VALIDATION_FAILED', `Station ${row.name} was removed.`, undefined, {
            issues: [
              {
                path: '/station',
                message: 'station is revoked',
              },
            ],
          })
        }

        const issues: { path: string; message: string }[] = []

        if (!Object.keys(body).length) {
          issues.push({
            path: '/',
            message:
              'send at least one of public_address, concurrency_cap, draining, intermittent, sandbox_limits, default_sandbox_runtime',
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
          body.default_sandbox_runtime === undefined
            ? null
            : runtimeRefusal(row, body.default_sandbox_runtime)

        if (runtimeProblem) {
          issues.push({
            path: '/default_sandbox_runtime',
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
          sandbox_limits: row.sandbox_limits,
          default_sandbox_runtime: row.default_sandbox_runtime,
        }
        const wantedLimits =
          body.sandbox_limits === undefined
            ? undefined
            : {
                ...row.sandbox_limits,
                ...body.sandbox_limits,
              }
        const changes = new ChangeSet()
        const before: Record<string, unknown> = {}
        const after: Record<string, unknown> = {}

        for (const field of stationFields) {
          const wanted = field === 'sandbox_limits' ? wantedLimits : body[field]

          if (wanted === undefined || JSON.stringify(wanted) === JSON.stringify(current[field])) {
            continue
          }

          changes.update('station', row.id, `/${field}`, current[field], wanted)
          before[field] = current[field]
          after[field] = wanted
        }

        const shown = kit.fields(
          'public_address,intermittent,sandbox_limits,default_sandbox_runtime,sandbox_runtime_advice',
        )

        if (changes.empty) {
          return select(kit.views.station, row, shown)
        }

        const protect = readSetting(db, 'platform.protected') && !call.principal.human
        const result = commit(
          kit.deps,
          call,
          {
            environment: null,
            protect,
          },
          changes,
        )

        if (!result.applied) {
          return kit.stagedBody(result, set)
        }

        audit(
          db,
          call,
          'station.update',
          {
            entity: 'station',
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
          db.select().from(station).where(eq(station.id, row.id)).get()!,
          shown,
        )
      },
      {
        operation: {
          id: 'update_station',
          summary:
            'Change a station: public_address, concurrency_cap, draining (no new deployments are placed on it), intermittent, sandbox_limits and default_sandbox_runtime; sleep_schedule is phase 2',
          level: 'instance admin',
        },
        body: t.Object(
          {
            public_address: t.Optional(
              t.String({
                description: 'The IPv4 address domains and TCP exposures reach the station on',
              }),
            ),
            concurrency_cap: t.Optional(
              t.Integer({
                minimum: 1,
                description: 'Deployments the station runs at once',
              }),
            ),
            draining: t.Optional(
              t.Boolean({
                description: 'Place no new deployments on it; running services stay',
              }),
            ),
            intermittent: intermittent,
            sandbox_limits: t.Optional(
              t.Object(
                {
                  max_sandboxes: t.Optional(
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
            default_sandbox_runtime: t.Optional(
              t.Nullable(
                t.String({
                  description:
                    'a runtime the station offers in capabilities.sandboxes.runtimes, or null to follow the recommendation from its host probe',
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
          200: Station,
          202: Staged,
        }),
      },
    )
    .delete(
      '/stations/:station',
      async ({ request, params }) => {
        const call = await kit.call(request)
        const row = stationByRef(db, params.station)

        if (row.revoked_at) {
          return {
            deleted: true as const,
            revoked_at: row.revoked_at.toISOString(),
          }
        }

        const services = db
          .select({
            id: service.id,
            name: service.name,
          })
          .from(service)
          .where(eq(service.station_id, row.id))
          .all()
        const boxes = db
          .select({
            id: sandbox.id,
            name: sandbox.name,
          })
          .from(sandbox)
          .where(eq(sandbox.station_id, row.id))
          .all()

        if (services.length || boxes.length) {
          fail(
            'DELETE_HAS_DEPENDENTS',
            `Station ${row.name} still runs ${services.length} services and ${boxes.length} sandboxes.`,
            'Move or delete its services and delete its sandboxes first.',
            {
              dependents: [
                ...services.map((s) => ({
                  entity: 'service',
                  ...s,
                })),
                ...boxes.map((b) => ({
                  entity: 'sandbox',
                  ...b,
                })),
              ],
            },
          )
        }

        const revokedAt = new Date()

        db.update(station)
          .set({
            revoked_at: revokedAt,
            status: 'offline',
          })
          .where(eq(station.id, row.id))
          .run()
        audit(
          db,
          call,
          'station.remove',
          {
            entity: 'station',
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
          id: 'remove_station',
          summary: 'Remove a station: its key is revoked and kept, so it is told STATION_REVOKED',
          level: 'instance admin',
        },
        response: replies({
          200: Removed,
        }),
      },
    )
    .post(
      '/stations',
      async ({ request, body, set }) => {
        const call = await kit.call(request)

        if (
          db
            .select({
              id: station.id,
            })
            .from(station)
            .where(eq(station.name, body.name))
            .get()
        ) {
          fail('NAME_TAKEN', `A station named ${body.name} exists.`, undefined, {
            name: body.name,
          })
        }

        const secret = `${enrollTokenPrefix}${randomBytes(32).toString('base64url')}`
        const expiresAt = new Date(Date.now() + enrollTokenSeconds * 1000)
        const stationId = newId('station')
        const tokenId = newId('token')

        db.transaction((tx) => {
          const tdb = tx as unknown as Db

          tdb
            .insert(station)
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
              kind: 'station_enroll',
              scopes: [],
              expires_at: expiresAt,
              secret_sha256: enrollTokenSha256(secret),
              station_id: stationId,
            })
            .run()
          audit(
            tdb,
            call,
            'station.create',
            {
              entity: 'station',
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
          station: select(
            kit.views.station,
            db.select().from(station).where(eq(station.id, stationId)).get()!,
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
          id: 'enroll_station',
          summary:
            'Create a station in enrolling state and a one-time enrollment token (15 minutes)',
          level: 'instance admin',
          cli: {
            args: ['name'],
          },
        },
        body: t.Object(
          {
            name: t.String({
              pattern: slugPattern,
              description: 'The station name',
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
