import type { MessageBody } from '@stationly/protocol'
import type { Static } from '@sinclair/typebox'
import type { ActorValue } from '../auth/principal.ts'
import { audit, type Call, type Deps } from '../api/context.ts'
import { ApiError } from '../api/errors.ts'
import type { SandboxRow, ServiceRow } from '../api/lookup.ts'
import type { NetworkProbe, SandboxNetworkProbe } from '../api/shapes.ts'
import { stationError } from '../api/routes/runs.ts'
import { StationRequestError } from '../station/server.ts'

export type ProbeRequest = { kind: 'tcp' | 'dns'; to: string; port: number | null; timeout_s: number }

export type ProbeDoc = Static<typeof NetworkProbe>

export type SandboxProbeDoc = Static<typeof SandboxNetworkProbe>

type ProbeReply = MessageBody<'network.probe.result'>

const windowMs = 60_000

export const createProbeLimits = (perService = 6, perEnvironment = 30) => {
  const hits = new Map<string, number[]>()
  const recent = (key: string, now: number) => {
    const list = (hits.get(key) ?? []).filter(at => now - at < windowMs)
    hits.set(key, list)
    return list
  }
  return (serviceId: string, environmentId: string, now = Date.now()) => {
    const svc = recent(`service:${serviceId}`, now)
    const env = recent(`environment:${environmentId}`, now)
    const full = svc.length >= perService ? { list: svc, limit: perService, scope: 'service' } : env.length >= perEnvironment ? { list: env, limit: perEnvironment, scope: 'environment' } : null
    if (full) {
      const retry = Math.max(1, Math.ceil((full.list[0]! + windowMs - now) / 1000))
      throw new ApiError('RATE_LIMITED', `Probes are limited to ${full.limit} per ${full.scope} per minute.`, undefined, { retry_after_s: retry, limit: full.limit, scope: full.scope }, { 'retry-after': String(retry) })
    }
    svc.push(now)
    env.push(now)
  }
}

const probeFields = (r: ProbeReply) => ({
  kind: r.kind,
  to: r.to,
  port: r.port,
  ...(r.dns ? { dns: r.dns } : {}),
  ...(r.tcp ? { tcp: r.tcp } : {}),
  ...(r.verdict ? { verdict: { verdict: r.verdict.verdict, path: r.verdict.path } } : {}),
  at: r.at
})

export const shapeProbe = (name: string, r: ProbeReply): ProbeDoc => ({ service: name, ...probeFields(r) })

export const shapeSandboxProbe = (name: string, r: ProbeReply): SandboxProbeDoc => ({ sandbox: name, ...probeFields(r) })

type Source = { entity: 'service' | 'sandbox'; id: string; name: string; station_id: string }

const askProbe = async (deps: Pick<Deps, 'stations'>, source: Source, probe: ProbeRequest) => {
  const reply = await deps.stations
    .ask(
      source.station_id,
      'network.probe',
      { ...(source.entity === 'service' ? { service_id: source.id } : { sandbox_id: source.id }), kind: probe.kind, to: probe.to, ...(probe.port !== null ? { port: probe.port } : {}), timeout_s: probe.timeout_s },
      { capability: 'network.v1', timeoutMs: 15_000 }
    )
    .catch(error => {
      if (error instanceof StationRequestError && error.code === 'PROTOCOL_LIMIT')
        throw new ApiError('RATE_LIMITED', `The station is already running a probe from ${source.name}, or four probes at once.`, undefined, { retry_after_s: 1, station_code: error.code }, { 'retry-after': '1' })
      return stationError(error)
    })
  return reply.body as ProbeReply
}

const auditProbe = (deps: Pick<Deps, 'db'>, call: Call, source: Source, probe: ProbeRequest, r: ProbeReply, requestedBy: ActorValue | null) => {
  const actorCall = requestedBy ? { ...call, principal: { ...call.principal, actor: requestedBy } } : call
  audit(deps.db, actorCall, 'network.probe', { entity: source.entity, id: source.id }, {
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
      ...(requestedBy ? { accepted_by: call.principal.actor } : {})
    }
  })
}

export const sendProbe = async (deps: Pick<Deps, 'db' | 'stations'>, call: Call, svc: ServiceRow, probe: ProbeRequest, requestedBy: ActorValue | null = null) => {
  const source: Source = { entity: 'service', id: svc.id, name: svc.name, station_id: svc.station_id }
  const r = await askProbe(deps, source, probe)
  auditProbe(deps, call, source, probe, r, requestedBy)
  return shapeProbe(svc.name, r)
}

export const sendSandboxProbe = async (deps: Pick<Deps, 'db' | 'stations'>, call: Call, box: SandboxRow, probe: ProbeRequest) => {
  const source: Source = { entity: 'sandbox', id: box.id, name: box.name, station_id: box.station_id }
  const r = await askProbe(deps, source, probe)
  auditProbe(deps, call, source, probe, r, null)
  return shapeSandboxProbe(box.name, r)
}
