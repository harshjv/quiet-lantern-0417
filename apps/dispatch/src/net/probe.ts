import type { Static } from '@sinclair/typebox'

import type { MessageBody } from '@stationly/protocol'

import { audit, type Call, type Deps } from '../api/context.ts'
import { ApiError } from '../api/errors.ts'
import type { AppRow } from '../api/lookup.ts'
import { stationError } from '../api/routes/runs.ts'
import type { NetworkProbe } from '../api/shapes.ts'
import type { ActorValue } from '../auth/principal.ts'
import { StationRequestError } from '../station/server.ts'

export type ProbeRequest = {
  kind: 'tcp' | 'dns'
  to: string
  port: number | null
  timeout_s: number
}

export type ProbeDoc = Static<typeof NetworkProbe>

type ProbeReply = MessageBody<'network.probe.result'>

const windowMs = 60_000

export const createProbeLimits = (perApp = 6, perTarget = 30) => {
  const hits = new Map<string, number[]>()
  const recent = (key: string, now: number) => {
    const list = (hits.get(key) ?? []).filter((at) => now - at < windowMs)

    hits.set(key, list)

    return list
  }

  return (appId: string, targetId: string, now = Date.now()) => {
    const svc = recent(`app:${appId}`, now)
    const env = recent(`target:${targetId}`, now)
    const full =
      svc.length >= perApp
        ? {
            list: svc,
            limit: perApp,
            scope: 'app',
          }
        : env.length >= perTarget
          ? {
              list: env,
              limit: perTarget,
              scope: 'preview',
            }
          : null

    if (full) {
      const retry = Math.max(1, Math.ceil((full.list[0]! + windowMs - now) / 1000))

      throw new ApiError(
        'RATE_LIMITED',
        `Probes are limited to ${full.limit} per ${full.scope} per minute.`,
        undefined,
        {
          retry_after_s: retry,
          limit: full.limit,
          scope: full.scope,
        },
        {
          'retry-after': String(retry),
        },
      )
    }

    svc.push(now)
    env.push(now)
  }
}

const probeFields = (r: ProbeReply) => ({
  kind: r.kind,
  to: r.to,
  port: r.port,
  ...(r.dns
    ? {
        dns: r.dns,
      }
    : {}),
  ...(r.tcp
    ? {
        tcp: r.tcp,
      }
    : {}),
  ...(r.verdict
    ? {
        verdict: {
          verdict: r.verdict.verdict,
          path: r.verdict.path,
        },
      }
    : {}),
  at: r.at,
})

export const shapeProbe = (name: string, r: ProbeReply): ProbeDoc => ({
  app: name,
  ...probeFields(r),
})

type Source = { entity: 'app'; id: string; name: string; server_id: string }

const askProbe = async (deps: Pick<Deps, 'stations'>, source: Source, probe: ProbeRequest) => {
  const reply = await deps.stations
    .ask(
      source.server_id,
      'network.probe',
      {
        ...(source.entity === 'app'
          ? {
              app_id: source.id,
            }
          : {
              sandbox_id: source.id,
            }),
        kind: probe.kind,
        to: probe.to,
        ...(probe.port !== null
          ? {
              port: probe.port,
            }
          : {}),
        timeout_s: probe.timeout_s,
      },
      {
        timeoutMs: 15_000,
      },
    )
    .catch((error) => {
      if (error instanceof StationRequestError && error.code === 'PROTOCOL_LIMIT') {
        throw new ApiError(
          'RATE_LIMITED',
          `The server is already running a probe from ${source.name}, or four probes at once.`,
          undefined,
          {
            retry_after_s: 1,
            station_code: error.code,
          },
          {
            'retry-after': '1',
          },
        )
      }

      return stationError(error)
    })

  return reply.body
}

const auditProbe = (
  deps: Pick<Deps, 'db'>,
  call: Call,
  source: Source,
  probe: ProbeRequest,
  r: ProbeReply,
  requestedBy: ActorValue | null,
) => {
  const actorCall = requestedBy
    ? {
        ...call,
        principal: {
          ...call.principal,
          actor: requestedBy,
        },
      }
    : call

  audit(
    deps.db,
    actorCall,
    'network.probe',
    {
      entity: source.entity,
      id: source.id,
    },
    {
      after: {
        kind: probe.kind,
        to: probe.to,
        port: probe.port,
        timeout_s: probe.timeout_s,
        result: r.tcp?.result ?? r.dns?.rcode ?? null,
        address: r.tcp?.address ?? null,
        path: r.verdict?.path ?? null,
        verdict: r.verdict?.verdict ?? null,
        ms: r.tcp?.ms ?? r.dns?.ms ?? null,
        ...(requestedBy
          ? {
              approved_by: call.principal.actor,
            }
          : {}),
      },
    },
  )
}

export const sendProbe = async (
  deps: Pick<Deps, 'db' | 'stations'>,
  call: Call,
  svc: AppRow,
  probe: ProbeRequest,
  requestedBy: ActorValue | null = null,
) => {
  const source: Source = {
    entity: 'app',
    id: svc.id,
    name: svc.name,
    server_id: svc.server_id,
  }
  const r = await askProbe(deps, source, probe)

  auditProbe(deps, call, source, probe, r, requestedBy)

  return shapeProbe(svc.name, r)
}
