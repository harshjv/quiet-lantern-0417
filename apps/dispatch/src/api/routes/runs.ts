import { Type } from '@sinclair/typebox'
import { and, eq, inArray } from 'drizzle-orm'
import { Elysia, t } from 'elysia'

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
import { runById, serviceById } from '../lookup.ts'
import { getQuery } from '../pagination.ts'
import {
  listRuns,
  runListQuery,
  runRow,
  sandboxRunOutput,
  terminalRun,
  waitForRun,
} from '../runs.ts'
import { Diagnosis, extend, models, Page, replies, Run, Staged } from '../shapes.ts'

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
        : ['STATION_OFFLINE', 'STATION_VERSION_SKEW', 'NOT_FOUND', 'VALIDATION_FAILED'].includes(
              error.code,
            )
          ? error.code
          : 'STATION_OFFLINE'
    throw new ApiError(code as 'STATION_OFFLINE', error.message, undefined, {
      station_code: error.code,
      ...error.details,
    })
  }
  throw error
}

export const runRoutes = (kit: Kit) => {
  const { db, stations } = kit.deps
  const tags = ['runs']
  const rowOf = (id: string) => runRow(db, id)

  return new Elysia({
    prefix: '/v1',
    normalize: false,
  })
    .use(models())
    .use(kit.operations)
    .get(
      '/services/:service/runs',
      ({ params, query }) =>
        listRuns(kit, eq(run.service_id, serviceById(db, params.service).service.id), query),
      {
        operation: {
          id: 'list_runs',
          level: 'read',
        },
        params: t.Object({
          service: t.String(),
        }),
        query: runListQuery,
        response: replies({
          200: Page(Run),
        }),
        detail: {
          summary: 'List the runs of a service',
          tags,
        },
      },
    )
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
        return row.sandbox_id && done
          ? {
              ...shown,
              output: await sandboxRunOutput(kit, row, await kit.call(request)),
            }
          : shown
      },
      {
        operation: {
          id: 'wait_for_run',
          level: 'read',
          mcp: {
            poll: true,
          },
        },
        params: t.Object({
          id: t.String(),
        }),
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
        detail: {
          summary: 'Get a run with done; wait_s keeps waiting up to 10 s for it to finish',
          tags,
        },
      },
    )
    .post(
      '/services/:service/runs',
      async ({ request, params, body, set }) => {
        const call = await kit.call(request)
        const ctx = serviceById(db, params.service)
        if (!ctx.service.current_deployment_id)
          fail(
            'NO_CURRENT_DEPLOYMENT',
            `${ctx.service.name} has no current deployment to run the command in.`,
            'Deploy the service first.',
          )
        const staged = ctx.environment.protected && !call.principal.human
        if (!staged) requireConnected(kit.deps, ctx.service.station_id)
        const changes = new ChangeSet()
        const ref = changes.add('run', ctx.service.id, {
          kind: 'one_off',
          command: body.command,
        })
        const result = commit(
          kit.deps,
          call,
          {
            environment: ctx.environment,
            protect: staged,
          },
          changes,
        )
        if (!result.applied) return kit.stagedBody(result, set)
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
              deployment_id: ctx.service.current_deployment_id,
            },
          },
        )
        stations.reconcile(ctx.service.station_id)
        set.status = 201
        const row = await waitForRun(db, id, body.wait_s ?? 10, request.signal)
        return select(kit.views.run, row, kit.fields('failure'))
      },
      {
        operation: {
          id: 'run_command',
          level: 'deploy',
        },
        params: t.Object({
          service: t.String(),
        }),
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
          202: Staged,
        }),
        detail: {
          summary: "Run a one-off command in the service's current image and variables",
          tags,
        },
      },
    )
    .post(
      '/services/:service/shells',
      async ({ request, params, body, set }) => {
        const call = await kit.call(request)
        const ctx = serviceById(db, params.service)
        if (ctx.environment.protected)
          requireHuman(call.principal, 'A shell in a protected environment', {
            environment_id: ctx.environment.id,
          })
        if (!ctx.service.current_deployment_id)
          fail(
            'NO_CURRENT_DEPLOYMENT',
            `${ctx.service.name} has no current deployment to open a shell in.`,
            'Deploy the service first.',
          )
        requireConnected(kit.deps, ctx.service.station_id)
        const id = newId('run')
        db.insert(run)
          .values({
            id,
            service_id: ctx.service.id,
            deployment_id: ctx.service.current_deployment_id,
            kind: 'shell',
            command: body.command ?? ['/bin/sh'],
            status: 'queued',
            log_ref: `logs/${ctx.service.id}/${ctx.service.current_deployment_id}/${id}`,
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
        operation: {
          id: 'open_shell',
          level: 'deploy',
          mcp: false,
          cli: false,
        },
        params: t.Object({
          service: t.String(),
        }),
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
        detail: {
          summary: 'Create a shell run; attach to it over the WebSocket at attach_url',
          tags,
        },
      },
    )
    .post(
      '/runs/:id/cancel',
      async ({ request, params }) => {
        const call = await kit.call(request)
        const { run: r, ...ctx } = runById(db, params.id)
        if (terminalRun.has(r.status))
          fail('VALIDATION_FAILED', `Run ${r.id} is already ${r.status}.`, undefined, {
            issues: [
              {
                path: '/status',
                message: r.status,
              },
            ],
          })
        if (stations.isConnected(ctx.station_id))
          await stations
            .ask(ctx.station_id, 'run.cancel', {
              run_id: r.id,
            })
            .catch(stationError)
        else if (r.status !== 'queued')
          fail(
            'STATION_OFFLINE',
            `Station ${ctx.station_id} is not connected, so the running run cannot be stopped.`,
          )
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
        operation: {
          id: 'cancel_run',
          level: 'deploy',
        },
        params: t.Object({
          id: t.String(),
        }),
        response: replies({
          200: Run,
        }),
        detail: {
          summary: 'Cancel a queued or running run; never staged',
          tags,
        },
      },
    )
    .get(
      '/runs/:id/diagnosis',
      async ({ request, params }) => {
        const call = await kit.call(request)
        const r = rowOf(params.id)
        const redact = r.sandbox_id
          ? kit.sandboxRedaction([r.sandbox_id], call.principal.actor, call.request_id)
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
        operation: {
          id: 'get_run_diagnosis',
          level: 'read',
        },
        params: t.Object({
          id: t.String(),
        }),
        response: replies({
          200: Diagnosis,
        }),
        detail: {
          summary: 'The diagnosis of a failed run',
          tags,
        },
      },
    )
}
