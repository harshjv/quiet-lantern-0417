import { Type } from '@sinclair/typebox'
import { and, asc, desc, gt, type SQL } from 'drizzle-orm'
import { Elysia, t } from 'elysia'

import { Nullable } from '@stationly/protocol'

import type { Principal } from '../../auth/principal.ts'
import { idTime } from '../../db/ids.ts'
import { event } from '../../db/schema.ts'
import { eventBus } from '../../station/events.ts'
import { can } from '../access.ts'
import { fail } from '../errors.ts'
import { project as select } from '../fields.ts'
import { csv, type Kit } from '../kit.ts'
import { before, collect, maxLimit } from '../pagination.ts'
import { Event, models, replies } from '../shapes.ts'
import { createSse } from '../sse.ts'

const EventPage = Type.Object(
  {
    items: Type.Array(Event),
    next_cursor: Nullable(Type.String()),
    next_since: Nullable(Type.String()),
  },
  {
    additionalProperties: false,
  },
)

export const eventRetentionMs = 14 * 24 * 3600 * 1000
const eventIdPattern = /^evt_[0-9A-HJKMNP-TV-Z]{26}$/
const fallbackPollMs = 1000

type EventRow = typeof event.$inferSelect

type Filter = { types?: string[]; project?: string; environment?: string; service?: string }

export const typeMatches = (types: string[] | undefined, type: string) =>
  !types ||
  types.length === 0 ||
  types.some((t) => (t.endsWith('*') ? type.startsWith(t.slice(0, -1)) : t === type))

export const visibleTo = (principal: Principal, row: EventRow) => {
  const subject = row.subject as { project_id?: string; environment_id?: string }
  if (!subject.project_id)
    return can(
      principal,
      {
        project_id: '*',
        environment_id: '*',
      },
      'read',
    )
  return can(
    principal,
    {
      project_id: subject.project_id,
      environment_id: subject.environment_id ?? '*',
    },
    'read',
  )
}

const matches = (principal: Principal, filter: Filter) => (row: EventRow) => {
  const subject = row.subject as {
    project_id?: string
    environment_id?: string
    service_id?: string
    id: string
  }
  if (!typeMatches(filter.types, row.type)) return false
  if (filter.project && subject.project_id !== filter.project) return false
  if (filter.environment && subject.environment_id !== filter.environment) return false
  if (filter.service && subject.service_id !== filter.service && subject.id !== filter.service)
    return false
  return visibleTo(principal, row)
}

const eventQuery = t.Object({
  since: t.Optional(t.String()),
  types: t.Optional(t.String()),
  project: t.Optional(t.String()),
  environment: t.Optional(t.String()),
  service: t.Optional(t.String()),
  limit: t.Optional(
    t.Numeric({
      minimum: 1,
      maximum: maxLimit,
    }),
  ),
  cursor: t.Optional(t.String()),
  fields: t.Optional(t.String()),
})

type EventQuery = typeof eventQuery.static

const checkSince = (since: string) => {
  if (!eventIdPattern.test(since))
    fail('VALIDATION_FAILED', 'since must be an event id (evt_...) from this stream.', undefined, {
      issues: [
        {
          path: '/since',
          message: 'not an event id',
        },
      ],
    })
  const at = idTime(since)
  if (Date.now() - at > eventRetentionMs)
    fail(
      'EVENT_CURSOR_EXPIRED',
      `The cursor is from ${new Date(at).toISOString()}, older than the 14-day event retention.`,
      'Read the current state with describe_environment, then follow events without since.',
      {
        since,
        retained_from: new Date(Date.now() - eventRetentionMs).toISOString(),
      },
    )
  return since
}

export const eventRoutes = (kit: Kit) => {
  const { db } = kit.deps

  const after = (since: string, size: number, extra?: SQL) =>
    db
      .select()
      .from(event)
      .where(and(gt(event.id, since), extra))
      .orderBy(asc(event.id))
      .limit(size)
      .all()

  const prepare = async (request: Request, query: EventQuery) => {
    const principal = await kit.principal(request)
    const filter: Filter = {
      types: csv(query.types),
      project: query.project,
      environment: query.environment,
      service: query.service,
    }
    const resume = request.headers.get('last-event-id') ?? query.since
    return {
      keep: matches(principal, filter),
      fields: kit.fields(query.fields),
      since: resume ? checkSince(resume) : undefined,
    }
  }

  const list = async (request: Request, query: EventQuery) => {
    const { keep, fields, since } = await prepare(request, query)
    if (since) {
      const limit = query.limit ?? 50
      const items: EventRow[] = []
      let cursor = since
      while (items.length < limit) {
        const batch = after(cursor, maxLimit)
        if (!batch.length) break
        for (const row of batch) if (keep(row) && items.length < limit) items.push(row)
        cursor = batch.at(-1)!.id
        if (batch.length < maxLimit) break
      }
      return {
        items: items.map((row) => select(kit.views.event, row, fields)),
        next_cursor: null,
        next_since: items.at(-1)?.id ?? cursor,
      }
    }
    const page = collect(
      (cursor, size) =>
        db
          .select()
          .from(event)
          .where(before(event.id, cursor))
          .orderBy(desc(event.id))
          .limit(size)
          .all(),
      query,
      keep,
    )
    return {
      items: page.rows.map((row) => select(kit.views.event, row, fields)),
      next_cursor: page.next_cursor,
      next_since: page.rows[0]?.id ?? null,
    }
  }

  const stream = async (request: Request, query: EventQuery): Promise<Response> => {
    const { keep, fields, since } = await prepare(request, query)
    const sse = createSse(request.signal)
    let last =
      since ??
      db
        .select({
          id: event.id,
        })
        .from(event)
        .orderBy(desc(event.id))
        .limit(1)
        .get()?.id ??
      'evt_00000000000000000000000000'
    let draining = false
    let again = false
    const drain = async () => {
      if (draining) {
        again = true
        return
      }
      draining = true
      try {
        do {
          again = false
          for (;;) {
            const batch = after(last, maxLimit)
            if (!batch.length) break
            for (const row of batch) {
              last = row.id
              if (keep(row)) await sse.send(row.type, select(kit.views.event, row, fields), row.id)
              if (sse.closed()) return
            }
          }
        } while (again && !sse.closed())
      } finally {
        draining = false
      }
    }
    const wake = () => void drain()
    eventBus.on('event', wake)
    const poll = setInterval(wake, fallbackPollMs)
    sse.onClose(() => {
      eventBus.off('event', wake)
      clearInterval(poll)
    })
    void drain()
    return sse.response
  }

  return new Elysia({
    prefix: '/v1',
    normalize: false,
  })
    .use(models())
    .use(kit.operations)
    .get(
      '/events',
      async ({ request, query }) =>
        (request.headers.get('accept') ?? '').includes('text/event-stream')
          ? ((await stream(request, query)) as never)
          : list(request, query),
      {
        operation: {
          id: 'get_events',
          level: 'any',
          cli: {
            path: ['events'],
            render: 'events',
          },
          stream: true,
        },
        query: eventQuery,
        response: replies({
          200: EventPage,
        }),
        detail: {
          summary:
            'Events visible to the caller; Accept: text/event-stream streams them, resuming after since or Last-Event-ID',
          tags: ['events'],
        },
      },
    )
}
