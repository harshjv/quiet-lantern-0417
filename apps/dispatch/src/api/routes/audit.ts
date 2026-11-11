import { and, desc, eq, gte, like, lte, sql } from 'drizzle-orm'
import { t } from 'elysia'

import type { Target } from '../../auth/scopes.ts'
import { audit_event } from '../../db/schema.ts'
import { can } from '../access.ts'
import { ApiError } from '../errors.ts'
import { project as select } from '../fields.ts'
import { parseTime, type Kit } from '../kit.ts'
import { targets, type TargetEntity } from '../lookup.ts'
import { before, collect, listQuery, since, until } from '../pagination.ts'
import { AuditEvent, Page, replies } from '../shapes.ts'

export const auditRoutes = (kit: Kit) => {
  const { db } = kit.deps

  const targetOf = (entity: string, id: string): Target | null => {
    if (!Object.hasOwn(targets, entity)) {
      return null
    }

    try {
      return targets[entity as TargetEntity](db, id).target
    } catch (error) {
      if (error instanceof ApiError) {
        return null
      }

      throw error
    }
  }

  return kit.router('audit', '/v1').get(
    '/audit',
    async ({ request, query }) => {
      const principal = await kit.principal(request)
      const instance = can(
        principal,
        {
          project_id: '*',
          environment_id: '*',
        },
        'read',
      )
      const since = parseTime(query.since, '/since')
      const until = parseTime(query.until, '/until')
      const page = collect(
        (cursor, size) =>
          db
            .select()
            .from(audit_event)
            .where(
              and(
                since ? gte(audit_event.created_at, since) : undefined,
                until ? lte(audit_event.created_at, until) : undefined,
                query.actor_type
                  ? eq(sql`json_extract(${audit_event.actor}, '$.type')`, query.actor_type)
                  : undefined,
                query.actor_id
                  ? eq(sql`json_extract(${audit_event.actor}, '$.id')`, query.actor_id)
                  : undefined,
                query.action
                  ? like(audit_event.action, `${query.action.replaceAll('%', '')}%`)
                  : undefined,
                query.target_entity
                  ? eq(sql`json_extract(${audit_event.target}, '$.entity')`, query.target_entity)
                  : undefined,
                query.target_id
                  ? eq(sql`json_extract(${audit_event.target}, '$.id')`, query.target_id)
                  : undefined,
                query.request_id ? eq(audit_event.request_id, query.request_id) : undefined,
                before(audit_event.id, cursor),
              ),
            )
            .orderBy(desc(audit_event.id))
            .limit(size)
            .all(),
        query,
        (row) => {
          if (instance) {
            return true
          }

          const target = targetOf(row.target.entity, row.target.id)

          return target !== null && can(principal, target, 'read')
        },
      )

      return {
        items: page.rows.map((row) => select(kit.views.audit, row, kit.fields(query.fields))),
        next_cursor: page.next_cursor,
      }
    },
    {
      operation: {
        id: 'get_audit_events',
        summary: 'Audit events; rows outside the caller scopes are omitted',
        level: 'any',
        cli: {
          path: ['audit'],
        },
      },
      query: t.Object({
        ...listQuery,
        since,
        until,
        actor_type: t.Optional(
          t.String({
            description: 'Only events by this kind of actor',
          }),
        ),
        actor_id: t.Optional(
          t.String({
            description: 'Only events by this actor id',
          }),
        ),
        action: t.Optional(
          t.String({
            description: 'Only actions starting with this, such as service. or deploy',
          }),
        ),
        target_entity: t.Optional(
          t.String({
            description: 'Only events on this kind of entity, such as service',
          }),
        ),
        target_id: t.Optional(
          t.String({
            description: 'Only events on this entity id',
          }),
        ),
        request_id: t.Optional(
          t.String({
            description: 'Only events of this request id',
          }),
        ),
      }),
      response: replies({
        200: Page(AuditEvent),
      }),
    },
  )
}
