import type { Static } from '@sinclair/typebox'
import { eq } from 'drizzle-orm'

import { remedy, type Diagnosis, type Observed } from '@stationly/protocol'

import type { Db } from '../db/client.ts'
import { app, app_port, domain } from '../db/schema.ts'

import { appSubject, emitEvent } from './events.ts'

type DomainRow = typeof domain.$inferSelect
type Route = Observed['gateway']['routes'][string]
type DiagnosisValue = Static<typeof Diagnosis>
type Status = DomainRow['status']

const routeDiagnosis = (d: DomainRow, route: Route): DiagnosisValue => {
  const failure = route.failure

  if (route.result === 'blocked') {
    return {
      phase: 'route',
      code: 'ROUTE_NOT_APPLIED',
      summary: `The Gateway route for ${d.hostname} is blocked on the server by ${route.blocked_by ?? 'a failed dependency'}.`,
      details: {
        blocked_by: route.blocked_by ?? null,
      },
      fixes: [
        remedy(
          'WAIT_FOR_APPLY',
          `Fix ${route.blocked_by ?? 'the blocking object'} first; the route applies once it does.`,
        ),
      ],
    }
  }

  return {
    phase: 'route',
    code: failure?.code ?? 'ROUTE_NOT_APPLIED',
    summary:
      failure?.explanation ?? `The Gateway route for ${d.hostname} failed to apply on the server.`,
    ...(failure?.details
      ? {
          details: failure.details,
        }
      : {}),
    fixes: failure?.fix ? [remedy('WAIT_FOR_APPLY', failure.fix)] : [],
  }
}

const derive = (d: DomainRow, route: Route): { status: Status; error: DiagnosisValue | null } => {
  if (route.result === 'failed' || route.result === 'blocked') {
    return {
      status: 'error',
      error: routeDiagnosis(d, route),
    }
  }

  if (d.status === 'active') {
    return {
      status: 'active',
      error: route.result === 'pending' ? d.error : null,
    }
  }

  return {
    status: route.result === 'ok' && route.probe?.ok ? 'active' : 'pending',
    error: null,
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

export const ingestRoutes = (
  db: Db,
  stationId: string,
  observed: Pick<Observed, 'observed_at' | 'gateway'>,
) => {
  const routes = observed.gateway.routes
  const rows = db
    .select({
      d: domain,
      app_id: app.id,
    })
    .from(domain)
    .innerJoin(app_port, eq(app_port.id, domain.app_port_id))
    .innerJoin(app, eq(app.id, app_port.app_id))
    .where(eq(app.server_id, stationId))
    .all()
  const changed: { domain: string; from: Status; to: Status }[] = []

  for (const { d, app_id } of rows) {
    const route = routes[d.id]

    if (!route) {
      continue
    }

    const next = derive(d, route)
    const checkedAt =
      route.probe && d.status !== 'active' ? new Date(observed.observed_at) : d.last_checked_at

    if (
      next.status === d.status &&
      same(next.error, d.error) &&
      checkedAt?.getTime() === d.last_checked_at?.getTime()
    ) {
      continue
    }

    db.update(domain)
      .set({
        status: next.status,
        error: next.error,
        last_checked_at: checkedAt,
        updated_at: new Date(),
      })
      .where(eq(domain.id, d.id))
      .run()

    if (next.status === d.status) {
      continue
    }

    emitEvent(
      db,
      'domain.changed',
      {
        ...appSubject(db, app_id),
        entity: 'domain',
        id: d.id,
        domain_id: d.id,
      },
      {
        domain: d.id,
        hostname: d.hostname,
        from: d.status,
        to: next.status,
        code: next.error?.code ?? null,
      },
    )
    changed.push({
      domain: d.id,
      from: d.status,
      to: next.status,
    })
  }

  return changed
}
