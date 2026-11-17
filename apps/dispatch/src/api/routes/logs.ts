import { Type } from '@sinclair/typebox'
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import { t } from 'elysia'

import { logRoleValues, messages, StringEnum, type MessageBody } from '@stationly/protocol'

import { app, deployment, machine, server } from '../../db/schema.ts'
import type { StreamHandle } from '../../station/server.ts'
import { requireInstance, requireLevel } from '../access.ts'
import { placeName } from '../changes.ts'
import { fail, invalid } from '../errors.ts'
import { parseTime, type Kit } from '../kit.ts'
import {
  appById,
  buildById,
  deploymentById,
  machineById,
  runById,
  stationByRef,
} from '../lookup.ts'
import { previewQuery, since, until } from '../pagination.ts'
import { input } from '../schemas.ts'
import { replies } from '../shapes.ts'
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
const {
  service_id: wireAppId,
  sandbox_id: wireMachineId,
  ...sampleFields
} = messages['metrics.sample.result'].body.properties.samples.items.properties
const MetricSample = Type.Object(
  {
    ...sampleFields,
    app_id: wireAppId,
    machine_id: wireMachineId,
  },
  {
    title: 'MetricSample',
  },
)

type WireMetricSample = MessageBody<'metrics.sample.result'>['samples'][number]

const apiSample = ({ service_id, sandbox_id, ...rest }: WireMetricSample) => ({
  ...rest,
  ...(service_id
    ? {
        app_id: service_id,
      }
    : {}),
  ...(sandbox_id
    ? {
        machine_id: sandbox_id,
      }
    : {}),
})

type Selector = MessageBody<'logs.query'>
type LogLine = MessageBody<'logs.page'>['lines'][number]

const maxTail = 5000
const defaultTail = 50
const redactionDeployments = 20

const selector = (description: string) =>
  t.Optional(
    t.String({
      description: `${description}; exactly one selector is required`,
    }),
  )

const logQuery = t.Object({
  app: selector('Logs of this app'),
  deployment: selector('Logs of this deployment id'),
  build: selector('Logs of this build id'),
  run: selector('Logs of this run id'),
  machine: selector('Logs of this machine'),
  component: t.Optional(
    t.Union(
      [t.Literal('stationd'), t.Literal('depot'), t.Literal('gateway'), t.Literal('buildkit')],
      {
        description:
          'Logs of this platform component, with server; exactly one selector is required',
      },
    ),
  ),
  server: t.Optional(
    t.String({
      description: 'The server of a component, by id or name',
    }),
  ),
  role: t.Optional(
    input(
      StringEnum(logRoleValues, {
        description: 'Only lines of this container role of an app or deployment',
      }),
    ),
  ),
  since,
  until,
  level: t.Optional(
    t.String({
      description: 'Only lines of this parsed level, such as error; lines without a level pass',
    }),
  ),
  grep: t.Optional(
    t.String({
      description: 'A case-insensitive substring, or a regular expression after re:',
    }),
  ),
  tail: t.Optional(
    t.Numeric({
      minimum: 1,
      maximum: maxTail,
      description: `The last N lines (default ${defaultTail}, at most ${maxTail})`,
    }),
  ),
  cursor: t.Optional(
    t.String({
      description: 'The next_cursor of a previous response, to read on from there',
    }),
  ),
  follow: t.Optional(t.BooleanString()),
})

export const logRoutes = (kit: Kit) => {
  const { db, stations } = kit.deps

  const resolve = async (request: Request, query: typeof logQuery.static) => {
    const call = await kit.call(request)
    const chosen = (['app', 'deployment', 'build', 'run', 'machine', 'component'] as const).filter(
      (k) => query[k] !== undefined,
    )

    if (chosen.length !== 1) {
      invalid([
        {
          path: '/',
          message: `exactly one of app, deployment, build, run, machine, component is required (got ${chosen.length})`,
        },
      ])
    }

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
      tail: query.tail ?? defaultTail,
    }

    if (
      query.role &&
      (query.role === 'init' || query.role === 'runtime') !== (query.machine !== undefined)
    ) {
      invalid([
        {
          path: '/role',
          message: 'init and runtime narrow machine logs; app, guard and coupler narrow app logs',
        },
      ])
    }

    if (
      query.role &&
      query.app === undefined &&
      query.deployment === undefined &&
      query.machine === undefined
    ) {
      invalid([
        {
          path: '/role',
          message: 'role narrows runtime logs; pass it with app, deployment or machine',
        },
      ])
    }

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

    if (query.server !== undefined && query.component === undefined) {
      invalid([
        {
          path: '/server',
          message: 'server selects where component logs are read; pass it with component',
        },
      ])
    }

    if (query.component !== undefined) {
      requireInstance(call.principal, 'read')
      const stationId = query.server
        ? stationByRef(db, query.server).id
        : (db
            .select({
              id: server.id,
            })
            .from(server)
            .where(and(isNull(server.revoked_at), eq(server.hosts_dispatch, true)))
            .get()?.id ??
          db
            .select({
              id: server.id,
            })
            .from(server)
            .where(isNull(server.revoked_at))
            .get()?.id)

      if (!stationId) {
        fail('NOT_FOUND', 'No server holds component logs yet.')
      }

      return {
        call,
        stationId: stationId!,
        selector: {
          source: 'system',
          component: query.component,
          ...base,
        } as Selector,
        deployments: [] as string[],
        machineId: undefined as string | undefined,
      }
    }

    if (query.machine !== undefined) {
      const ctx = machineById(db, query.machine)

      requireLevel(call.principal, ctx.target, 'read')

      return {
        call,
        stationId: ctx.machine.server_id,
        selector: {
          source: 'sandbox',
          sandbox_id: ctx.machine.id,
          role: query.role ?? 'init',
          ...base,
        } as Selector,
        deployments: [] as string[],
        machineId: ctx.machine.id as string | undefined,
      }
    }

    if (query.app !== undefined) {
      const ctx = appById(db, query.app)

      requireLevel(call.principal, ctx.target, 'read')
      const deps = db
        .select({
          id: deployment.id,
        })
        .from(deployment)
        .where(and(eq(deployment.app_id, ctx.app.id), isNotNull(deployment.started_at)))
        .orderBy(desc(deployment.id))
        .limit(redactionDeployments)
        .all()
        .map((d) => d.id)

      return {
        call,
        stationId: ctx.app.server_id,
        selector: {
          service_id: ctx.app.id,
          ...runtime,
        } as Selector,
        deployments: deps,
        machineId: undefined as string | undefined,
      }
    }

    if (query.deployment !== undefined) {
      const ctx = deploymentById(db, query.deployment)

      requireLevel(call.principal, ctx.target, 'read')

      return {
        call,
        stationId: ctx.app.server_id,
        selector: {
          deployment_id: ctx.deployment.id,
          ...runtime,
        } as Selector,
        deployments: [ctx.deployment.id],
        machineId: undefined as string | undefined,
      }
    }

    if (query.build !== undefined) {
      const ctx = buildById(db, query.build)

      requireLevel(call.principal, ctx.target, 'read')

      return {
        call,
        stationId: ctx.app.server_id,
        selector: {
          source: 'build',
          build_id: ctx.build.id,
          ...base,
        } as Selector,
        deployments: [ctx.build.deployment_id],
        machineId: undefined as string | undefined,
      }
    }

    const { run: r, ...owner } = runById(db, query.run!)

    requireLevel(call.principal, owner.target, 'read')

    return {
      call,
      stationId: owner.server_id,
      selector: {
        source: 'run',
        run_id: r.id,
        ...base,
      } as Selector,
      deployments: r.deployment_id ? [r.deployment_id] : [],
      machineId: r.machine_id ?? undefined,
    }
  }

  const firstPage = async (request: Request, query: typeof logQuery.static) => {
    const { call, stationId, selector, deployments, machineId } = await resolve(request, query)
    const redact = machineId
      ? kit.machineRedaction([machineId], call.principal.actor, call.request_id)
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
    const page = reply.body

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
      : query.machine
        ? 'machine log'
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
      for (const line of lines) {
        await sse.send('log', line, line.cursor)
      }

      if (page.truncated) {
        await sse.send('truncated', {
          truncated: true,
        })
      }

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
              for (const item of items as LogLine[]) {
                await sse.send('log', shown(item), item.cursor)
              }

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

        if (owed) {
          handle.credit(owed)
        }

        if (sse.closed()) {
          handle.cancel()
        }
      } catch (error) {
        await sse.send('error', {
          code: (error as { code?: string }).code ?? 'SERVER_OFFLINE',
          explanation: (error as Error).message,
        })
        sse.close()
      }
    })()

    return sse.response
  }

  return kit
    .router('logs', '/v1')
    .get(
      '/logs',
      async ({ request, query }) =>
        query.follow ? ((await followLogs(request, query)) as never) : pageLogs(request, query),
      {
        operation: {
          id: 'get_logs',
          summary: 'Read logs for one selector; follow = true streams new lines as SSE',
          level: 'any',
          cli: {
            path: ['logs'],
            render: 'logs',
            exclusive: ['app', 'deployment', 'build', 'run', 'machine', 'component'],
          },
          stream: true,
        },
        query: logQuery,
        response: replies({
          200: LogPage,
        }),
      },
    )
    .get(
      '/apps/:app/metrics',
      async ({ ctx }) => {
        const reply = await stations
          .ask(ctx.app.server_id, 'metrics.sample', {
            service_ids: [ctx.app.id],
          })
          .catch(stationError)
        const sample = reply.body.samples.find((s) => s.service_id === ctx.app.id)

        if (!sample) {
          fail(
            'NOT_FOUND',
            `${ctx.app.name} has no running container reporting metrics.`,
            'Start or deploy the app, then read metrics again.',
            {
              app_id: ctx.app.id,
              status: ctx.app.status,
            },
          )
        }

        return apiSample(sample!)
      },
      {
        app: {
          id: 'get_metrics',
          summary: 'Latest live metrics sample of an app',
          level: 'read',
        },
        response: replies({
          200: MetricSample,
        }),
        detail: {
          tags: ['metrics'],
        },
      },
    )
    .get(
      '/projects/:project/metrics',
      ({ ctx, request }) => {
        const running = db
          .select({
            id: app.id,
            server_id: app.server_id,
          })
          .from(app)
          .where(
            and(
              eq(app.target_id, ctx.target_row.id),
              eq(app.desired_state, 'running'),
              isNotNull(app.current_deployment_id),
              inArray(app.kind, ['web', 'worker']),
            ),
          )
          .all()
        const boxes = db
          .select({
            id: machine.id,
            server_id: machine.server_id,
          })
          .from(machine)
          .where(and(eq(machine.target_id, ctx.target_row.id), eq(machine.status, 'running')))
          .all()
        const byStation = new Map<string, { apps: string[]; machines: string[] }>()
        const entry = (stationId: string) =>
          byStation.get(stationId) ??
          byStation
            .set(stationId, {
              apps: [],
              machines: [],
            })
            .get(stationId)!

        for (const s of running) {
          entry(s.server_id).apps.push(s.id)
        }

        for (const b of boxes) {
          entry(b.server_id).machines.push(b.id)
        }

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
                  service_ids: ids.apps,
                  sandbox_ids: ids.machines,
                },
                {
                  onData: (items, bytes) => {
                    chain = chain.then(async () => {
                      for (const item of items) {
                        await sse.send('metrics', apiSample(item as WireMetricSample))
                      }

                      if (handle) {
                        handle.credit(bytes)
                      } else {
                        owed += bytes
                      }
                    })
                  },
                  onEnd: (reason) =>
                    void sse.send('end', {
                      server_id: stationId,
                      reason,
                    }),
                },
              )

              handle = opened

              if (owed) {
                opened.credit(owed)
              }

              handles.push(opened)

              if (sse.closed()) {
                opened.cancel()
              }
            } catch (error) {
              await sse.send('error', {
                server_id: stationId,
                code: (error as { code?: string }).code ?? 'SERVER_OFFLINE',
                explanation: (error as Error).message,
              })
            }
          }

          if (!byStation.size) {
            await sse.send('empty', {
              explanation: `no running app or machine in ${placeName(ctx.target_row)}`,
            })
          }
        })()

        return sse.response
      },
      {
        place: {
          id: 'stream_metrics',
          summary: 'SSE: one metrics sample per running app of production or a preview every 5 s',
          level: 'read',
          mcp: false,
          cli: {
            render: 'metrics',
          },
          stream: true,
        },
        query: t.Object(previewQuery),
        detail: {
          tags: ['metrics'],
        },
      },
    )
}
