import { eq, inArray, isNotNull } from 'drizzle-orm'
import type { Db } from '../db/client.ts'
import { deployment, service, type BaseImageRecord } from '../db/schema.ts'
import { readSetting } from '../api/settings.ts'
import { emitEvent } from '../station/events.ts'
import { displayRef, manifestAccept, parseReference, registryRequest, type Hop, type Reference } from './registry.ts'

export type CheckState = BaseImageRecord['check']

export type CheckResult = {
  ref: string
  state: Exclude<CheckState, 'current' | 'moved'> | 'ok'
  digest: string | null
  status: number
  hops: Hop[]
  ratelimit: { limit: string | null; remaining: string | null }
  retry_after_s: number | null
  error: string | null
  duration_ms: number
}

export const defaultIntervalS = 21600

export const intervalS = (db: Db) => {
  const v = readSetting<number>(db, 'base_images.check_interval_s')
  return typeof v === 'number' && v >= 0 ? v : defaultIntervalS
}

export const keyOf = (r: Reference) => `${r.apiHost}/${r.repository}:${r.tag ?? ''}`

export const headCheck = async (ref: string, fetchImpl?: typeof fetch): Promise<CheckResult> => {
  const started = Date.now()
  const r = parseReference(ref)
  const res = await registryRequest(r, `manifests/${r.tag ?? 'latest'}`, { method: 'HEAD', accept: manifestAccept, timeoutMs: 15_000, fetchImpl })
  const digest = res.headers.get('docker-content-digest')
  const retry = Number(res.headers.get('retry-after'))
  const state: CheckResult['state'] =
    res.status === 0 || res.status >= 500
      ? 'unreachable'
      : res.status === 401 || res.status === 403
        ? 'auth_required'
        : res.status === 404
          ? 'not_found'
          : res.status === 429
            ? 'rate_limited'
            : res.status === 200
              ? digest
                ? 'ok'
                : 'no_digest'
              : 'unreachable'
  return {
    ref: displayRef(r),
    state,
    digest: state === 'ok' ? digest : null,
    status: res.status,
    hops: res.hops,
    ratelimit: { limit: res.headers.get('ratelimit-limit'), remaining: res.headers.get('ratelimit-remaining') },
    retry_after_s: Number.isFinite(retry) && retry > 0 ? retry : null,
    error: res.error,
    duration_ms: Date.now() - started
  }
}

type Holder = { deploymentId: string; serviceId: string; serviceName: string; index: number; entry: BaseImageRecord }

const holders = (db: Db) => {
  const rows = db
    .select({ id: service.id, name: service.name, dep: service.current_deployment_id })
    .from(service)
    .where(isNotNull(service.current_deployment_id))
    .all()
  const deps = rows.length
    ? db
        .select({ id: deployment.id, base_images: deployment.base_images })
        .from(deployment)
        .where(inArray(deployment.id, rows.map(r => r.dep!)))
        .all()
    : []
  const byDep = new Map(deps.map(d => [d.id, d.base_images]))
  const out = new Map<string, Holder[]>()
  for (const svc of rows) {
    const images = byDep.get(svc.dep!) ?? []
    images.forEach((entry, index) => {
      const key = keyOf(parseReference(entry.ref))
      out.set(key, [...(out.get(key) ?? []), { deploymentId: svc.dep!, serviceId: svc.id, serviceName: svc.name, index, entry }])
    })
  }
  return out
}

export const applyResult = (db: Db, key: string, result: CheckResult, list: Holder[]) => {
  const checkedAt = new Date().toISOString()
  const moved: Holder[] = []
  const findings: Holder[] = []
  db.transaction(tx => {
    for (const h of list) {
      const dep = tx.select({ base_images: deployment.base_images }).from(deployment).where(eq(deployment.id, h.deploymentId)).get()
      if (!dep) continue
      const images = [...dep.base_images]
      const prev = images[h.index]
      if (!prev) continue
      const state: CheckState = result.state === 'ok' ? (result.digest === prev.digest ? 'current' : 'moved') : result.state
      const latest = result.state === 'ok' ? result.digest : (prev.latest_digest ?? null)
      if (state === 'moved' && (prev.check !== 'moved' || prev.latest_digest !== latest)) moved.push({ ...h, entry: { ...prev, latest_digest: latest } })
      if ((state === 'auth_required' || state === 'not_found') && prev.check !== state) findings.push({ ...h, entry: { ...prev, check: state } })
      images[h.index] = { ...prev, check: state, checked_at: checkedAt, latest_digest: latest }
      tx.update(deployment).set({ base_images: images }).where(eq(deployment.id, h.deploymentId)).run()
    }
    if (moved.length) {
      const first = moved[0]!
      emitEvent(tx as unknown as Db, 'base_image.moved', { entity: 'base_image', id: key }, {
        base_image: result.ref,
        old_digest: first.entry.digest,
        new_digest: first.entry.latest_digest,
        services: [...new Set(moved.map(m => m.serviceId))],
        auto_rebuild: false,
        platform_changed: null,
        fix: [...new Set(moved.map(m => `sly services rebuild --service ${m.serviceId}`))]
      })
    }
    for (const f of findings) {
      emitEvent(tx as unknown as Db, 'doctor.finding', { entity: 'service', id: f.serviceId }, {
        check: 'base_image',
        status: 'warn',
        detail: `${result.ref}: ${f.entry.check}`,
        fix: f.entry.check === 'auth_required' ? 'The repository is private or was deleted; phase 1a checks anonymously.' : 'The tag no longer exists; rebuild from a tag that does.'
      })
    }
  })
  return { moved: moved.length, findings: findings.length }
}

export type CheckerLog = (event: string, fields: Record<string, unknown>) => void

export const startBaseImageChecker = (db: Db, log: CheckerLog = (event, fields) => console.log(JSON.stringify({ event, ...fields }))) => {
  const next = new Map<string, number>()
  let lastInterval = -1
  let running = false
  const tick = async () => {
    if (running) return
    running = true
    try {
      const interval = intervalS(db)
      if (interval !== lastInterval) {
        next.clear()
        lastInterval = interval
        log('base_image.interval', { interval_s: interval, enabled: interval > 0 })
      }
      if (interval === 0) return
      const now = Date.now()
      const groups = holders(db)
      for (const key of [...next.keys()]) if (!groups.has(key)) next.delete(key)
      for (const [key, list] of groups) {
        if (!next.has(key)) next.set(key, now + Math.floor(Math.random() * interval * 1000))
        if (next.get(key)! > now) continue
        const result = await headCheck(list[0]!.entry.ref)
        const effect = applyResult(db, key, result, list)
        const wait = result.state === 'rate_limited' && result.retry_after_s ? result.retry_after_s * 1000 : interval * 1000
        next.set(key, Date.now() + Math.round(wait * (0.9 + Math.random() * 0.2)))
        log('base_image.check', {
          ref: result.ref,
          state: result.state,
          digest: result.digest,
          status: result.status,
          hosts: [...new Set(result.hops.map(h => h.host))],
          hops: result.hops.length,
          ratelimit: result.ratelimit,
          moved_events: effect.moved,
          findings: effect.findings,
          deployments: list.length,
          duration_ms: result.duration_ms,
          error: result.error
        })
      }
    } catch (error) {
      log('base_image.check_failed', { explanation: (error as Error).message })
    } finally {
      running = false
    }
  }
  const timer = setInterval(() => void tick(), 1000)
  timer.unref()
  return { stop: () => clearInterval(timer), tick }
}

export const baseImageInventory = (db: Db) => {
  const out: { ref: string; registry: string; checks: { service_id: string; service: string; deployment_id: string; digest: string; check: CheckState; checked_at: string | null; latest_digest: string | null }[] }[] = []
  for (const [, list] of holders(db)) {
    const r = parseReference(list[0]!.entry.ref)
    out.push({
      ref: displayRef(r),
      registry: r.apiHost,
      checks: list.map(h => ({ service_id: h.serviceId, service: h.serviceName, deployment_id: h.deploymentId, digest: h.entry.digest, check: h.entry.check, checked_at: h.entry.checked_at ?? null, latest_digest: h.entry.latest_digest ?? null }))
    })
  }
  return out.sort((a, b) => a.ref.localeCompare(b.ref))
}
