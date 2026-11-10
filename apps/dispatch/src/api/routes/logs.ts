import { Type } from '@sinclair/typebox'
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import { Elysia, t } from 'elysia'

import { messages, type MessageBody } from '@stationly/protocol'

import { deployment, sandbox, service, station } from '../../db/schema.ts'
import type { StreamHandle } from '../../station/server.ts'
import { requireInstance, requireLevel } from '../access.ts'
import { fail, invalid } from '../errors.ts'
import { parseTime, type Kit } from '../kit.ts'
import {
  buildById,
  deploymentById,
  environmentById,
  runById,
  sandboxById,
  serviceById,
  stationByRef,
} from '../lookup.ts'
import { models, replies } from '../shapes.ts'
import { createSse } from '../sse.ts'

import { stationError } from './runs.ts'

const StationLogPage = messages['logs.page'].body

const LogPage = Type.Object(
  {
    untrusted: Type.Object({
      source: Type.String(),
      lines: StationLogPage.properties.lines,
    }),
    next_cursor: StationLogPage.properties.next_cursor,
    truncated: StationLogPage.properties.truncated,
  },
  {
    additionalProperties: false,
  },
)
const MetricSample = messages['metrics.sample.result'].body.properties.samples.items

type Selector = MessageBody<'logs.query'>
type LogLine = MessageBody<'logs.page'>['lines'][number]

const maxTail = 5000
const redactionDeployments = 20

const logQuery = t.Object({
  service: t.Optional(t.String()),
  deployment: t.Optional(t.String()),
  build: t.Optional(t.String()),
  run: t.Optional(t.String()),
  sandbox: t.Optional(t.String()),
  component: t.Optional(
    t.Union([
      t.Literal('stationd'),
      t.Literal('depot'),
      t.Literal('gateway'),
      t.Literal('buildkit'),
    ]),
  ),
  station: t.Optional(t.String()),
  role: t.Optional(
    t.Union([
      t.Literal('service'),
      t.Literal('guard'),
      t.Literal('coupler'),
      t.Literal('init'),
      t.Literal('runtime'),
    ]),
  ),
  since: t.Optional(t.String()),
  until: t.Optional(t.String()),
  level: t.Optional(t.String()),
  grep: t.Optional(t.String()),
  tail: t.Optional(
    t.Numeric({
      minimum: 1,
      maximum: maxTail,
    }),
  ),
  cursor: t.Optional(t.String()),
  follow: t.Optional(t.BooleanString()),
})

export const logRoutes = (kit: Kit) => {
  const { db, stations } = kit.deps

  const resolve = async (request: Request, query: typeof logQuery.static) => {
    const call = await kit.call(request)
    const chosen = (
      ['service', 'deployment', 'build', 'run', 'sandbox', 'component'] as const
    ).filter((k) => query[k] !== undefined)
    if (chosen.length !== 1)
      invalid([
        {
          path: '/',
          message: `exactly one of service, deployment, build, run, sandbox, component is required (got ${chosen.length})`,
        },
      ])
    const base = {
      ...(query.since
        ? {
            since: parseTime(query.since, '/since')!.toISOString(),
          }
        : {}),
      ...(query.until
        ? {
            until: parseTime(query.until, '/until')!.toISOString(),
          }
        : {}),
      ...(query.grep
        ? {
            grep: query.grep,
          }
        : {}),
      ...(query.level
        ? {
            level: query.level,
          }
        : {}),
      ...(query.cursor
        ? {
            cursor: query.cursor,
          }
        : {}),
      tail: query.tail ?? 50,
    }
    if (
      query.role &&
      (query.role === 'init' || query.role === 'runtime') !== (query.sandbox !== undefined)
    )
      invalid([
        {
          path: '/role',
          message:
            'init and runtime narrow sandbox logs; service, guard and coupler narrow service logs',
        },
      ])
    if (
      query.role &&
      query.service === undefined &&
      query.deployment === undefined &&
      query.sandbox === undefined
    )
      invalid([
        {
          path: '/role',
          message: 'role narrows runtime logs; pass it with service, deployment or sandbox',
        },
      ])
    const runtime = {
      source: 'runtime' as const,
      ...(query.role
        ? {
            role: query.role,
          }
        : {}),
      ...base,
    }
    if (query.grep?.startsWith('re:')) {
      try {
        new RegExp(query.grep.slice(3))
      } catch (error) {
        invalid([
          {
            path: '/grep',
            message: `not a regular expression: ${(error as Error).message}`,
          },
        ])
      }
    }
    if (query.station !== undefined && query.component === undefined)
      invalid([
        {
          path: '/station',
          message: 'station selects where component logs are read; pass it with component',
        },
      ])
    if (query.component !== undefined) {
      requireInstance(call.principal, 'read')
      const stationId = query.station
        ? stationByRef(db, query.station).id
        : (db
            .select({
              id: station.id,
            })
            .from(station)
            .where(and(isNull(station.revoked_at), eq(station.hosts_dispatch, true)))
            .get()?.id ??
          db
            .select({
              id: station.id,
            })
            .from(station)
            .where(isNull(station.revoked_at))
            .get()?.id)
      if (!stationId) fail('NOT_FOUND', 'No station holds component logs yet.')
      return {
        call,
        stationId: stationId!,
        selector: {
          source: 'system',
          component: query.component,
          ...base,
        } as Selector,
        deployments: [] as string[],
        sandboxId: undefined as string | undefined,
      }
    }
    if (query.sandbox !== undefined) {
      const ctx = sandboxById(db, query.sandbox)
      requireLevel(call.principal, ctx.target, 'read')
      return {
        call,
        stationId: ctx.sandbox.station_id,
        selector: {
          source: 'sandbox',
          sandbox_id: ctx.sandbox.id,
          role: query.role ?? 'init',
          ...base,
        } as Selector,
        deployments: [] as string[],
        sandboxId: ctx.sandbox.id as string | undefined,
      }
    }
    if (query.service !== undefined) {
      const ctx = serviceById(db, query.service)
      requireLevel(call.principal, ctx.target, 'read')
      const deps = db
        .select({
          id: deployment.id,
        })
        .from(deployment)
        .where(and(eq(deployment.service_id, ctx.service.id), isNotNull(deployment.started_at)))
        .orderBy(desc(deployment.id))
        .limit(redactionDeployments)
        .all()
        .map((d) => d.id)
      return {
        call,
        stationId: ctx.service.station_id,
        selector: {
          service_id: ctx.service.id,
          ...runtime,
        } as Selector,
        deployments: deps,
        sandboxId: undefined as string | undefined,
      }
    }
    if (query.deployment !== undefined) {
      const ctx = deploymentById(db, query.deployment)
      requireLevel(call.principal, ctx.target, 'read')
      return {
        call,
        stationId: ctx.service.station_id,
        selector: {
          deployment_id: ctx.deployment.id,
          ...runtime,
        } as Selector,
        deployments: [ctx.deployment.id],
        sandboxId: undefined as string | undefined,
      }
    }
    if (query.build !== undefined) {
      const ctx = buildById(db, query.build)
      requireLevel(call.principal, ctx.target, 'read')
      return {
        call,
        stationId: ctx.service.station_id,
        selector: {
          source: 'build',
          build_id: ctx.build.id,
          ...base,
        } as Selector,
        deployments: [ctx.build.deployment_id],
        sandboxId: undefined as string | undefined,
      }
    }
    const { run: r, ...owner } = runById(db, query.run!)
    requireLevel(call.principal, owner.target, 'read')
    return {
      call,
      stationId: owner.station_id,
      selector: {
        source: 'run',
        run_id: r.id,
        ...base,
      } as Selector,
      deployments: r.deployment_id ? [r.deployment_id] : [],
      sandboxId: r.sandbox_id ?? undefined,
    }
  }

  const firstPage = async (request: Request, query: typeof logQuery.static) => {
    const { call, stationId, selector, deployments, sandboxId } = await resolve(request, query)
    const redact = sandboxId
      ? kit.sandboxRedaction([sandboxId], call.principal.actor, call.request_id)
      : kit.redaction(deployments, call.principal.actor, call.request_id)
    const shown = (line: LogLine): LogLine => ({
      at: line.at,
      role: line.role,
      stream: line.stream,
      level: line.level,
      text: redact(line.text),
      cursor: line.cursor,
    })
    const resumeFrom = request.headers.get('last-event-id') ?? undefined
    const pageSelector = resumeFrom
      ? {
          ...selector,
          cursor: resumeFrom,
        }
      : selector
    const reply = await stations
      .ask(stationId, 'logs.query', pageSelector, {
        timeoutMs: 10_000,
      })
      .catch(stationError)
    const page = reply.body as MessageBody<'logs.page'>
    return {
      stationId,
      selector,
      shown,
      page,
      lines: page.lines.map(shown),
    }
  }

  const sourceOf = (query: typeof logQuery.static) =>
    query.component
      ? `${query.component} component log`
      : query.sandbox
        ? 'sandbox log'
        : query.build
          ? 'build log'
          : query.run
            ? 'run log'
            : 'runtime log'

  const pageLogs = async (request: Request, query: typeof logQuery.static) => {
    const { page, lines } = await firstPage(request, query)
    return {
      untrusted: {
        source: sourceOf(query),
        lines,
      },
      next_cursor: page.next_cursor,
      truncated: page.truncated,
    }
  }

  const followLogs = async (request: Request, query: typeof logQuery.static): Promise<Response> => {
    const { stationId, selector, shown, page, lines } = await firstPage(request, query)
    const sse = createSse(request.signal)
    let handle: StreamHandle | null = null
    let owed = 0
    let chain = Promise.resolve()
    const credit = (bytes: number) => (handle ? handle.credit(bytes) : (owed += bytes))
    sse.onClose(() => handle?.cancel())
    void (async () => {
      for (const line of lines) await sse.send('log', line, line.cursor)
      if (page.truncated)
        await sse.send('truncated', {
          truncated: true,
        })
      const followFrom = {
        ...selector,
        ...(page.next_cursor
          ? {
              cursor: page.next_cursor,
            }
          : {}),
        tail: maxTail,
      }
      try {
        handle = await stations.openStream(stationId, 'logs.follow', followFrom, {
          onData: (items, bytes) => {
            chain = chain.then(async () => {
              for (const item of items as LogLine[]) await sse.send('log', shown(item), item.cursor)
              credit(bytes)
            })
          },
          onEnd: (reason) => {
            chain = chain
              .then(() =>
                sse.send('end', {
                  reason,
                }),
              )
              .then(() => sse.close())
          },
        })
        if (owed) handle.credit(owed)
        if (sse.closed()) handle.cancel()
      } catch (error) {
        await sse.send('error', {
          code: (error as { code?: string }).code ?? 'STATION_OFFLINE',
          explanation: (error as Error).message,
        })
        sse.close()
      }
    })()
    return sse.response
  }

  return new Elysia({
    prefix: '/v1',
    normalize: false,
  })
    .use(models())
    .use(kit.operations)
    .get(
      '/logs',
      async ({ request, query }) =>
        query.follow ? ((await followLogs(request, query)) as never) : pageLogs(request, query),
      {
        operation: {
          id: 'get_logs',
          level: 'any',
        },
        query: logQuery,
        response: replies({
          200: LogPage,
        }),
        detail: {
          summary: 'Read logs for one selector; follow = true streams new lines as SSE',
          tags: ['logs'],
        },
      },
    )
    .get(
      '/services/:service/metrics',
      async ({ params }) => {
        const ctx = serviceById(db, params.service)
        const reply = await stations
          .ask(
            ctx.service.station_id,
            'metrics.sample',
            {
              service_ids: [ctx.service.id],
            },
            {
              capability: 'metrics.v1',
            },
          )
          .catch(stationError)
        const sample = (reply.body as MessageBody<'metrics.sample.result'>).samples.find(
          (s) => s.service_id === ctx.service.id,
        )
        if (!sample)
          fail(
            'NOT_FOUND',
            `${ctx.service.name} has no running container reporting metrics.`,
            'Start or deploy the service, then read metrics again.',
            {
              service_id: ctx.service.id,
              status: ctx.service.status,
            },
          )
        return sample!
      },
      {
        operation: {
          id: 'get_metrics',
          level: 'read',
        },
        params: t.Object({
          service: t.String(),
        }),
        response: replies({
          200: MetricSample,
        }),
        detail: {
          summary: 'Latest live metrics sample of a service',
          tags: ['metrics'],
        },
      },
    )
    .get(
      '/environments/:environment/metrics',
      ({ request, params }) => {
        const ctx = environmentById(db, params.environment)
        const running = db
          .select({
            id: service.id,
            station_id: service.station_id,
          })
          .from(service)
          .where(
            and(
              eq(service.environment_id, ctx.environment.id),
              eq(service.desired_state, 'running'),
              isNotNull(service.current_deployment_id),
              inArray(service.kind, ['web', 'worker']),
            ),
          )
          .all()
        const boxes = db
          .select({
            id: sandbox.id,
            station_id: sandbox.station_id,
          })
          .from(sandbox)
          .where(and(eq(sandbox.environment_id, ctx.environment.id), eq(sandbox.status, 'running')))
          .all()
        const byStation = new Map<string, { services: string[]; sandboxes: string[] }>()
        const entry = (stationId: string) =>
          byStation.get(stationId) ??
          byStation
            .set(stationId, {
              services: [],
              sandboxes: [],
            })
            .get(stationId)!
        for (const s of running) entry(s.station_id).services.push(s.id)
        for (const b of boxes) entry(b.station_id).sandboxes.push(b.id)
        const sse = createSse(request.signal)
        const handles: StreamHandle[] = []
        sse.onClose(() => handles.forEach((h) => h.cancel()))
        void (async () => {
          let chain = Promise.resolve()
          for (const [stationId, ids] of byStation) {
            try {
              let handle: StreamHandle | null = null
              let owed = 0
              const opened = await stations.openStream(
                stationId,
                'metrics.subscribe',
                {
                  service_ids: ids.services,
                  sandbox_ids: ids.sandboxes,
                },
                {
                  onData: (items, bytes) => {
                    chain = chain.then(async () => {
                      for (const item of items) await sse.send('metrics', item)
                      if (handle) handle.credit(bytes)
                      else owed += bytes
                    })
                  },
                  onEnd: (reason) =>
                    void sse.send('end', {
                      station_id: stationId,
                      reason,
                    }),
                },
              )
              handle = opened
              if (owed) opened.credit(owed)
              handles.push(opened)
              if (sse.closed()) opened.cancel()
            } catch (error) {
              await sse.send('error', {
                station_id: stationId,
                code: (error as { code?: string }).code ?? 'STATION_OFFLINE',
                explanation: (error as Error).message,
              })
            }
          }
          if (!byStation.size)
            await sse.send('empty', {
              explanation: 'no running service or sandbox in this environment',
            })
        })()
        return sse.response
      },
      {
        operation: {
          id: 'stream_metrics',
          level: 'read',
          mcp: false,
        },
        params: t.Object({
          environment: t.String(),
        }),
        detail: {
          summary: 'SSE: one metrics sample per running service every 5 s',
          tags: ['metrics'],
        },
      },
    )
}
