import { and, desc, eq, gte, inArray } from 'drizzle-orm'
import { Type } from '@sinclair/typebox'
import { Elysia, t } from 'elysia'
import { newId } from '../../db/ids.ts'
import { run } from '../../db/schema.ts'
import { StationRequestError } from '../../station/server.ts'
import { requireHuman, requireLevel } from '../access.ts'
import { audit } from '../context.ts'
import { ChangeSet, commit } from '../changes.ts'
import { requireStationReady } from '../deployments.ts'
import { runDiagnosis } from '../diagnosis.ts'
import { ApiError, fail, notFound } from '../errors.ts'
import { project as select } from '../fields.ts'
import { csv, parseTime, type Kit } from '../kit.ts'
import { runOwner, serviceById } from '../lookup.ts'
import { before, collect, getQuery, listQuery } from '../pagination.ts'
import { Diagnosis, extend, models, Page, replies, Run, Staged } from '../shapes.ts'
import { sandboxRunOutput } from '../sandbox-runs.ts'

const Shell = extend(Run, { tty: Type.Boolean(), attach_url: Type.String() })

type RunRow = typeof run.$inferSelect
type RunStatus = RunRow['status']

const terminal = new Set<RunStatus>(['succeeded', 'failed', 'skipped', 'cancelled'])
const pollMs = 200

export const stationError = (error: unknown): never => {
  if (error instanceof StationRequestError) {
    const code = error.code === 'RUN_DEPLOYMENT_UNKNOWN' ? 'NO_CURRENT_DEPLOYMENT' : ['STATION_OFFLINE', 'STATION_VERSION_SKEW', 'NOT_FOUND', 'VALIDATION_FAILED'].includes(error.code) ? error.code : 'STATION_OFFLINE'
    throw new ApiError(code as 'STATION_OFFLINE', error.message, undefined, { station_code: error.code, ...error.details })
  }
  throw error
}

export const runRoutes = (kit: Kit) => {
  const { db, stations } = kit.deps
  const tags = ['runs']
  const rowOf = (id: string) => db.select().from(run).where(eq(run.id, id)).get() ?? notFound('run', id)
  const contextOf = (r: RunRow) => runOwner(db, r)

  const waitFor = async (id: string, seconds: number, signal: AbortSignal) => {
    const deadline = Date.now() + Math.min(seconds, 10) * 1000
    let row = rowOf(id)
    while (!terminal.has(row.status) && Date.now() < deadline && !signal.aborted) {
      await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))))
      row = rowOf(id)
    }
    return row
  }

  const requireConnected = (stationId: string) => {
    requireStationReady(db, stationId, { placement: false })
    if (!stations.isConnected(stationId)) fail('STATION_OFFLINE', `Station ${stationId} is not connected to Dispatch.`, undefined, { station_id: stationId })
  }

  return new Elysia({ prefix: '/v1', normalize: false }).use(models())
    .get(
      '/services/:service/runs',
      async ({ request, params, query }) => {
        const principal = await kit.principal(request)
        const ctx = serviceById(db, params.service)
        requireLevel(principal, ctx.target, 'read')
        const since = parseTime(query.since, '/since')
        const kinds = csv(query.kind)
        const statuses = csv(query.status)
        const page = collect(
          (cursor, size) =>
            db
              .select()
              .from(run)
              .where(
                and(
                  eq(run.service_id, ctx.service.id),
                  kinds ? inArray(run.kind, kinds as RunRow['kind'][]) : undefined,
                  statuses ? inArray(run.status, statuses as RunStatus[]) : undefined,
                  since ? gte(run.created_at, since) : undefined,
                  before(run.id, cursor)
                )
              )
              .orderBy(desc(run.id))
              .limit(size)
              .all(),
          query
        )
        return { items: page.rows.map(row => select(kit.views.run, row, kit.fields(query.fields))), next_cursor: page.next_cursor }
      },
      {
        params: t.Object({ service: t.String() }),
        query: t.Object({ ...listQuery, kind: t.Optional(t.String()), status: t.Optional(t.String()), since: t.Optional(t.String()) }),
        response: replies({ 200: Page(Run) }),
        detail: { summary: 'List the runs of a service', tags }
      }
    )
    .get(
      '/runs/:id',
      async ({ request, params, query }) => {
        const principal = await kit.principal(request)
        const r = rowOf(params.id)
        requireLevel(principal, contextOf(r).target, 'read')
        const row = query.wait_s ? await waitFor(r.id, query.wait_s, request.signal) : r
        const shown = select(kit.views.run, row, kit.fields(query.fields))
        return row.sandbox_id && terminal.has(row.status) ? { ...shown, output: await sandboxRunOutput(kit, row, await kit.call(request)) } : shown
      },
      {
        params: t.Object({ id: t.String() }),
        query: t.Object({ ...getQuery, wait_s: t.Optional(t.Numeric({ minimum: 0, maximum: 10 })) }),
        response: replies({ 200: Run }),
        detail: { summary: 'Get a run; wait_s keeps waiting up to 10 s for it to finish', tags }
      }
    )
    .post(
      '/services/:service/runs',
      async ({ request, params, body, set }) => {
        const call = await kit.call(request)
        const ctx = serviceById(db, params.service)
        requireLevel(call.principal, ctx.target, 'deploy')
        if (!ctx.service.current_deployment_id) fail('NO_CURRENT_DEPLOYMENT', `${ctx.service.name} has no current deployment to run the command in.`, 'Deploy the service first.')
        const staged = ctx.environment.protected && !call.principal.human
        if (!staged) requireConnected(ctx.service.station_id)
        const changes = new ChangeSet()
        const ref = changes.add('run', ctx.service.id, { kind: 'one_off', command: body.command })
        const result = commit(kit.deps, call, { environment: ctx.environment, protect: staged }, changes)
        if (!result.applied) return kit.stagedBody(result, set)
        const id = result.refs[ref]!
        audit(db, call, 'run.create', { entity: 'run', id }, { after: { command: body.command, deployment_id: ctx.service.current_deployment_id } })
        stations.reconcile(ctx.service.station_id)
        set.status = 201
        const row = await waitFor(id, body.wait_s ?? 10, request.signal)
        return select(kit.views.run, row, kit.fields('failure'))
      },
      {
        params: t.Object({ service: t.String() }),
        body: t.Object({ command: t.Array(t.String(), { minItems: 1 }), wait_s: t.Optional(t.Integer({ minimum: 0, maximum: 10 })) }, { additionalProperties: false }),
        response: replies({ 201: Run, 202: Staged }),
        detail: { summary: "Run a one-off command in the service's current image and variables", tags }
      }
    )
    .post(
      '/services/:service/shells',
      async ({ request, params, body, set }) => {
        const call = await kit.call(request)
        const ctx = serviceById(db, params.service)
        requireLevel(call.principal, ctx.target, 'deploy')
        if (ctx.environment.protected) requireHuman(call.principal, 'A shell in a protected environment', { environment_id: ctx.environment.id })
        if (!ctx.service.current_deployment_id) fail('NO_CURRENT_DEPLOYMENT', `${ctx.service.name} has no current deployment to open a shell in.`, 'Deploy the service first.')
        requireConnected(ctx.service.station_id)
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
            actor: call.principal.actor
          })
          .run()
        audit(db, call, 'run.shell', { entity: 'run', id }, { after: { command: body.command ?? ['/bin/sh'], tty: body.tty ?? true } })
        set.status = 201
        return { ...select(kit.views.run, rowOf(id), undefined), tty: body.tty ?? true, attach_url: `/v1/runs/${id}/attach` }
      },
      {
        params: t.Object({ service: t.String() }),
        body: t.Object({ command: t.Optional(t.Array(t.String(), { minItems: 1 })), tty: t.Optional(t.Boolean()) }, { additionalProperties: false }),
        response: replies({ 201: Shell }),
        detail: { summary: 'Create a shell run; attach to it over the WebSocket at attach_url', tags }
      }
    )
    .post(
      '/runs/:id/cancel',
      async ({ request, params }) => {
        const call = await kit.call(request)
        const r = rowOf(params.id)
        const ctx = contextOf(r)
        requireLevel(call.principal, ctx.target, 'deploy')
        if (terminal.has(r.status)) fail('VALIDATION_FAILED', `Run ${r.id} is already ${r.status}.`, undefined, { issues: [{ path: '/status', message: r.status }] })
        if (stations.isConnected(ctx.station_id)) await stations.ask(ctx.station_id, 'run.cancel', { run_id: r.id }).catch(stationError)
        else if (r.status !== 'queued') fail('STATION_OFFLINE', `Station ${ctx.station_id} is not connected, so the running run cannot be stopped.`)
        db.update(run).set({ status: 'cancelled', finished_at: new Date() }).where(and(eq(run.id, r.id), inArray(run.status, ['queued', 'running']))).run()
        audit(db, call, 'run.cancel', { entity: 'run', id: r.id }, { before: { status: r.status }, after: { status: 'cancelled' } })
        return select(kit.views.run, await waitFor(r.id, 2, request.signal), undefined)
      },
      { params: t.Object({ id: t.String() }), response: replies({ 200: Run }), detail: { summary: 'Cancel a queued or running run; never staged', tags } }
    )
    .get(
      '/runs/:id/diagnosis',
      async ({ request, params }) => {
        const call = await kit.call(request)
        const r = rowOf(params.id)
        requireLevel(call.principal, contextOf(r).target, 'read')
        const redact = r.sandbox_id ? kit.sandboxRedaction([r.sandbox_id], call.principal.actor, call.request_id) : kit.redaction(r.deployment_id ? [r.deployment_id] : [], call.principal.actor, call.request_id)
        return runDiagnosis(r, redact) ?? fail('NOT_FOUND', `Run ${r.id} is ${r.status}; only failed runs have a diagnosis.`, undefined, { status: r.status })
      },
      { params: t.Object({ id: t.String() }), response: replies({ 200: Diagnosis }), detail: { summary: 'The diagnosis of a failed run', tags } }
    )
}
