import type { Static } from '@sinclair/typebox'
import { eq } from 'drizzle-orm'

import { remedy, type Diagnosis, type ErrorBody, type Observed } from '@stationly/protocol'

import type { Db } from '../db/client.ts'
import { domain, service, service_port } from '../db/schema.ts'

import { emitEvent, serviceSubject } from './events.ts'

type DomainRow = typeof domain.$inferSelect
type Route = Observed['gateway']['routes'][string]
type DiagnosisValue = Static<typeof Diagnosis>
type ErrorBodyValue = Static<typeof ErrorBody>
type Status = DomainRow['status']
type Certificate = NonNullable<DomainRow['certificate']>

const checkDns = (hostname: string) =>
  remedy(
    'CHECK_DNS_RECORD',
    `Point the A record of ${hostname} at the station's public address, then wait for the Gateway's next attempt.`,
  )

const routeDiagnosis = (d: DomainRow, route: Route): DiagnosisValue => {
  const failure = route.failure

  if (route.result === 'blocked') {
    return {
      phase: 'route',
      code: 'ROUTE_NOT_APPLIED',
      summary: `The Gateway route for ${d.hostname} is blocked on the station by ${route.blocked_by ?? 'a failed dependency'}.`,
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
      failure?.explanation ?? `The Gateway route for ${d.hostname} failed to apply on the station.`,
    ...(failure?.details
      ? {
          details: failure.details,
        }
      : {}),
    fixes: failure?.fix ? [remedy('WAIT_FOR_APPLY', failure.fix)] : [],
  }
}

const certificateDiagnosis = (
  d: DomainRow,
  failure: ErrorBodyValue | null,
  expiresAt: string | null,
): DiagnosisValue => {
  if (!failure) {
    return {
      phase: 'certificate',
      code: 'CERTIFICATE_ISSUANCE_FAILED',
      summary: expiresAt
        ? `The certificate for ${d.hostname} expired at ${expiresAt} and the Gateway has served no renewal.`
        : `The Gateway's last certificate order for ${d.hostname} failed and no certificate is served.`,
      details: {
        hostname: d.hostname,
        expires_at: expiresAt,
      },
      fixes: [checkDns(d.hostname)],
    }
  }

  const rateLimited = failure.code === 'CERTIFICATE_RATE_LIMITED'

  return {
    phase: 'certificate',
    code: failure.code,
    summary: failure.explanation,
    ...(failure.details
      ? {
          details: failure.details,
        }
      : {}),
    fixes: [remedy(rateLimited ? 'ADD_DOMAIN' : 'CHECK_DNS_RECORD', failure.fix)],
  }
}

const derive = (
  d: DomainRow,
  route: Route,
): { status: Status; error: DiagnosisValue | null; certificate: DomainRow['certificate'] } => {
  const observed = d.ingress === 'direct' ? route.certificate : null
  const unknown =
    !observed ||
    (observed.status === 'pending' && d.certificate !== null && d.certificate.status !== 'pending')
  const certificate: DomainRow['certificate'] = unknown
    ? d.certificate
    : {
        resolver: d.certificate?.resolver ?? 'letsencrypt',
        status: observed.status,
        not_before: observed.not_before,
        expires_at: observed.expires_at,
      }

  if (route.result === 'failed' || route.result === 'blocked') {
    return {
      status: 'error',
      error: routeDiagnosis(d, route),
      certificate,
    }
  }

  if (route.result === 'pending') {
    return {
      status: d.status === 'active' ? 'active' : 'pending',
      error: d.status === 'active' ? d.error : null,
      certificate,
    }
  }

  if (d.ingress === 'direct') {
    const status = certificate?.status

    if (status === 'failed' || status === 'expired') {
      return {
        status: 'error',
        error:
          unknown && d.error?.phase === 'certificate'
            ? d.error
            : certificateDiagnosis(d, observed?.failure ?? null, certificate?.expires_at ?? null),
        certificate,
      }
    }

    if (d.status === 'active') {
      return {
        status: 'active',
        error: null,
        certificate,
      }
    }

    return {
      status: status === 'valid' && route.probe?.ok ? 'active' : 'pending',
      error: null,
      certificate,
    }
  }

  if (d.status === 'active') {
    return {
      status: 'active',
      error: null,
      certificate,
    }
  }

  return {
    status: route.probe?.ok ? 'active' : 'pending',
    error: null,
    certificate,
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

const certificateStatus = (c: Certificate | null) => c?.status ?? null

export const ingestRoutes = (
  db: Db,
  stationId: string,
  observed: Pick<Observed, 'observed_at' | 'gateway'>,
) => {
  const routes = observed.gateway.routes
  const rows = db
    .select({
      d: domain,
      service_id: service.id,
    })
    .from(domain)
    .innerJoin(service_port, eq(service_port.id, domain.service_port_id))
    .innerJoin(service, eq(service.id, service_port.service_id))
    .where(eq(service.station_id, stationId))
    .all()
  const changed: { domain: string; from: Status; to: Status }[] = []

  for (const { d, service_id } of rows) {
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
      same(next.certificate, d.certificate) &&
      checkedAt?.getTime() === d.last_checked_at?.getTime()
    ) {
      continue
    }

    db.update(domain)
      .set({
        status: next.status,
        error: next.error,
        certificate: next.certificate,
        last_checked_at: checkedAt,
        updated_at: new Date(),
      })
      .where(eq(domain.id, d.id))
      .run()
    const certificateMoved =
      certificateStatus(next.certificate) !== certificateStatus(d.certificate)

    if (next.status === d.status && !certificateMoved) {
      continue
    }

    emitEvent(
      db,
      'domain.changed',
      {
        ...serviceSubject(db, service_id),
        entity: 'domain',
        id: d.id,
        domain_id: d.id,
      },
      {
        domain: d.id,
        hostname: d.hostname,
        from: d.status,
        to: next.status,
        certificate: next.certificate
          ? {
              status: next.certificate.status,
              expires_at: next.certificate.expires_at,
            }
          : null,
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
