import { Type } from '@sinclair/typebox'
import { and, eq, inArray } from 'drizzle-orm'
import { t } from 'elysia'

import { runActiveStatuses } from '@stationly/protocol'

import { newId } from '../../db/ids.ts'
import { run } from '../../db/schema.ts'
import { StationRequestError } from '../../station/server.ts'
import { requireHuman } from '../access.ts'
import { ChangeSet, commit } from '../changes.ts'
import { audit } from '../context.ts'
import { requireConnected } from '../deployments.ts'
import { runDiagnosis } from '../diagnosis.ts'
import { ApiError, fail } from '../errors.ts'
import { project as select } from '../fields.ts'
import type { Kit } from '../kit.ts'
import { isProduction } from '../lookup.ts'
import { getQuery } from '../pagination.ts'
import {
  listRuns,
  machineRunOutput,
  runListQuery,
  runRow,
  terminalRun,
  waitForRun,
} from '../runs.ts'
import { ApprovalDetail, Diagnosis, extend, Page, replies, Run } from '../shapes.ts'

const Shell = extend(Run, {
  tty: Type.Boolean(),
  attach_url: Type.String(),
})

const Waited = extend(Run, {
  done: Type.Boolean(),
})

export const stationError = (error: unknown): never => {
  if (error instanceof StationRequestError) {
    const code =
      error.code === 'RUN_DEPLOYMENT_UNKNOWN'
        ? 'NO_CURRENT_DEPLOYMENT'
        : ['SERVER_OFFLINE', 'SERVER_VERSION_SKEW', 'NOT_FOUND', 'VALIDATION_FAILED'].includes(
              error.code,
            )
          ? error.code
          : 'SERVER_OFFLINE'

    throw new ApiError(code as 'SERVER_OFFLINE', error.message, undefined, {
      station_code: error.code,
      ...error.details,
    })
  }

  throw error
}

export const runRoutes = (kit: Kit) => {
  const { db, stations } = kit.deps
  const rowOf = (id: string) => runRow(db, id)

  return kit
    .router('runs', '/v1')
    .get('/apps/:app/runs', ({ ctx, query }) => listRuns(kit, eq(run.app_id, ctx.app.id), query), {
      app: {
        id: 'list_runs',
        summary: 'List the runs of an app',
        level: 'read',
      },
      query: runListQuery,
      response: replies({
        200: Page(Run),
      }),
    })
    .get(
      '/runs/:id',
      async ({ request, params, query }) => {
        const r = rowOf(params.id)
        const row = query.wait_s ? await waitForRun(db, r.id, query.wait_s, request.signal) : r
        const done = terminalRun.has(row.status)
        const shown = {
          ...select(kit.views.run, row, kit.fields(query.fields)),
          done,
        }

        return row.machine_id && done
          ? {
              ...shown,
              output: await machineRunOutput(kit, row, await kit.call(request)),
            }
          : shown
      },
      {
        run: {
          id: 'wait_for_run',
          summary: 'Get a run with done; wait_s keeps waiting up to 10 s for it to finish',
          level: 'read',
          mcp: {
            poll: true,
          },
          cli: {
            path: ['runs', 'get'],
            render: 'run',
          },
        },
        query: t.Object({
          ...getQuery,
          wait_s: t.Optional(
            t.Numeric({
              minimum: 0,
              maximum: 10,
            }),
          ),
        }),
        response: replies({
          200: Waited,
        }),
      },
    )
    .post(
      '/apps/:app/runs',
      async ({ ctx, request, body, set }) => {
        const call = await kit.call(request)

        if (!ctx.app.current_deployment_id) {
          fail(
            'NO_CURRENT_DEPLOYMENT',
            `${ctx.app.name} has no current deployment to run the command in.`,
            'Deploy the app first.',
          )
        }

        const protect = isProduction(ctx.target_row) && !call.principal.human

        if (!protect) {
          requireConnected(kit.deps, ctx.app.server_id)
        }

        const changes = new ChangeSet()
        const ref = changes.add('run', ctx.app.id, {
          kind: 'one_off',
          command: body.command,
        })
        const result = commit(
          kit.deps,
          call,
          {
            target: ctx.target_row,
            protect,
          },
          changes,
        )

        if (!result.applied) {
          return kit.approvalBody(result, set)
        }

        const id = result.refs[ref]!

        audit(
          db,
          call,
          'run.create',
          {
            entity: 'run',
            id,
          },
          {
            after: {
              command: body.command,
              deployment_id: ctx.app.current_deployment_id,
            },
          },
        )
        stations.reconcile(ctx.app.server_id)
        set.status = 201
        const row = await waitForRun(db, id, body.wait_s ?? 10, request.signal)

        return select(kit.views.run, row, kit.fields('failure'))
      },
      {
        app: {
          id: 'run_command',
          summary: "Run a one-off command in the app's current image and environment variables",
          level: 'deploy',
          cli: false,
        },
        body: t.Object(
          {
            command: t.Array(t.String(), {
              minItems: 1,
            }),
            wait_s: t.Optional(
              t.Integer({
                minimum: 0,
                maximum: 10,
              }),
            ),
          },
          {
            additionalProperties: false,
          },
        ),
        response: replies({
          201: Run,
          202: ApprovalDetail,
        }),
      },
    )
    .post(
      '/apps/:app/shells',
      async ({ ctx, request, body, set }) => {
        const call = await kit.call(request)

        if (isProduction(ctx.target_row)) {
          requireHuman(call.principal, 'A shell in production', ctx.target)
        }

        if (!ctx.app.current_deployment_id) {
          fail(
            'NO_CURRENT_DEPLOYMENT',
            `${ctx.app.name} has no current deployment to open a shell in.`,
            'Deploy the app first.',
          )
        }

        requireConnected(kit.deps, ctx.app.server_id)
        const id = newId('run')

        db.insert(run)
          .values({
            id,
            app_id: ctx.app.id,
            deployment_id: ctx.app.current_deployment_id,
            kind: 'shell',
            command: body.command ?? ['/bin/sh'],
            status: 'queued',
            log_ref: `logs/${ctx.app.id}/${ctx.app.current_deployment_id}/${id}`,
            tty: body.tty ?? true,
            actor: call.principal.actor,
          })
          .run()
        audit(
          db,
          call,
          'run.shell',
          {
            entity: 'run',
            id,
          },
          {
            after: {
              command: body.command ?? ['/bin/sh'],
              tty: body.tty ?? true,
            },
          },
        )
        set.status = 201

        return {
          ...select(kit.views.run, rowOf(id), undefined),
          tty: body.tty ?? true,
          attach_url: `/v1/runs/${id}/attach`,
        }
      },
      {
        app: {
          id: 'open_shell',
          summary: 'Create a shell run; attach to it over the WebSocket at attach_url',
          level: 'deploy',
          mcp: false,
          cli: false,
        },
        body: t.Object(
          {
            command: t.Optional(
              t.Array(t.String(), {
                minItems: 1,
              }),
            ),
            tty: t.Optional(t.Boolean()),
          },
          {
            additionalProperties: false,
          },
        ),
        response: replies({
          201: Shell,
        }),
      },
    )
    .post(
      '/runs/:id/cancel',
      async ({ ctx, request }) => {
        const call = await kit.call(request)
        const r = ctx.run

        if (terminalRun.has(r.status)) {
          fail('VALIDATION_FAILED', `Run ${r.id} is already ${r.status}.`, undefined, {
            issues: [
              {
                path: '/status',
                message: r.status,
              },
            ],
          })
        }

        if (stations.isConnected(ctx.server_id)) {
          await stations
            .ask(ctx.server_id, 'run.cancel', {
              run_id: r.id,
            })
            .catch(stationError)
        } else if (r.status !== 'queued') {
          fail(
            'SERVER_OFFLINE',
            `Server ${ctx.server_id} is not connected, so the running run cannot be stopped.`,
          )
        }

        db.update(run)
          .set({
            status: 'cancelled',
            finished_at: new Date(),
          })
          .where(and(eq(run.id, r.id), inArray(run.status, [...runActiveStatuses])))
          .run()
        audit(
          db,
          call,
          'run.cancel',
          {
            entity: 'run',
            id: r.id,
          },
          {
            before: {
              status: r.status,
            },
            after: {
              status: 'cancelled',
            },
          },
        )

        return select(kit.views.run, await waitForRun(db, r.id, 2, request.signal), undefined)
      },
      {
        run: {
          id: 'cancel_run',
          summary: 'Cancel a queued or running run; never needs approval',
          level: 'deploy',
        },
        response: replies({
          200: Run,
        }),
      },
    )
    .get(
      '/runs/:id/diagnosis',
      async ({ request, params }) => {
        const call = await kit.call(request)
        const r = rowOf(params.id)
        const redact = r.machine_id
          ? kit.machineRedaction([r.machine_id], call.principal.actor, call.request_id)
          : kit.redaction(
              r.deployment_id ? [r.deployment_id] : [],
              call.principal.actor,
              call.request_id,
            )

        return (
          runDiagnosis(r, redact) ??
          fail(
            'NOT_FOUND',
            `Run ${r.id} is ${r.status}; only failed runs have a diagnosis.`,
            undefined,
            {
              status: r.status,
            },
          )
        )
      },
      {
        run: {
          id: 'get_run_diagnosis',
          summary: 'The diagnosis of a failed run',
          level: 'read',
          cli: {
            path: ['runs', 'diagnosis'],
          },
        },
        response: replies({
          200: Diagnosis,
        }),
      },
    )
}
