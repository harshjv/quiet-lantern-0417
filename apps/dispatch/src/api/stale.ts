import canonicalize from 'canonicalize'
import { and, eq, inArray } from 'drizzle-orm'
import type { Db } from '../db/client.ts'
import { deployment, environment, event, sandbox, service, type StaleReasonValue, variable } from '../db/schema.ts'
import { envDigest, envOf, generationEnv } from '../secrets/deploy.ts'
import { SecretsError } from '../secrets/errors.ts'
import { Resolver, leaves } from '../secrets/resolve.ts'
import { sandboxEntries } from '../secrets/sandbox.ts'
import type { VariableWrite } from '../secrets/variables.ts'
import { configFields } from './deployments.ts'

type ServiceRow = typeof service.$inferSelect

export type StaleDependent = { service_id: string; environment_id: string; protected: boolean; keys: string[] }

const canonical = (value: unknown) => canonicalize(value ?? null) ?? 'null'

const list = (keys: string[]) => keys.join(', ')

const pendingEnv = (db: Db, svc: ServiceRow) => {
  const resolver = Resolver.forService(db, svc.id)
  const entries = []
  const unresolved: string[] = []
  for (const v of resolver.serviceVariables()) {
    try {
      entries.push({ key: v.key, injection: v.injection, node: resolver.resolve(v) })
    } catch (error) {
      if (!(error instanceof SecretsError)) throw error
      unresolved.push(v.key)
    }
  }
  const env = envOf(db, { service_id: svc.id, environment_id: svc.environment_id, deployment_id: svc.current_deployment_id ?? '' }, entries)
  return { env, unresolved }
}

const changedKeys = (deployed: ReturnType<typeof envOf>, pending: ReturnType<typeof envOf>, unresolved: string[]) => {
  const shape = (env: ReturnType<typeof envOf>) => new Map(env.map(({ value: _value, ...rest }) => [rest.key, canonical(rest)]))
  const before = shape(deployed)
  const after = shape(pending)
  const keys = new Set(unresolved)
  for (const key of new Set([...before.keys(), ...after.keys()])) if (before.get(key) !== after.get(key)) keys.add(key)
  return [...keys].sort()
}

const deployedEnv = (db: Db, deploymentId: string) => {
  try {
    return generationEnv(db, deploymentId)
  } catch (error) {
    if (!(error instanceof SecretsError)) throw error
    return { env: [] as ReturnType<typeof envOf>, env_digest: null }
  }
}

export const staleness = (db: Db, svc: ServiceRow) => {
  const pending = pendingEnv(db, svc)
  const reads = pending.env.flatMap(entry => entry.refs.flatMap(ref => ('secret_value_id' in ref ? [ref.secret_value_id] : [])))
  if (!svc.current_deployment_id) return { reasons: [] as StaleReasonValue[], reads }
  const current = db.select({ config_snapshot: deployment.config_snapshot }).from(deployment).where(eq(deployment.id, svc.current_deployment_id)).get()
  if (!current) return { reasons: [] as StaleReasonValue[], reads }
  const reasons: StaleReasonValue[] = []
  const deployed = deployedEnv(db, svc.current_deployment_id)
  const digest = pending.unresolved.length ? null : envDigest(pending.env)
  if (digest === null || digest !== deployed.env_digest) {
    const keys = changedKeys(deployed.env, pending.env, pending.unresolved)
    const unresolved = pending.unresolved.length ? ` ${list(pending.unresolved)} does not resolve, so the next deploy fails until it does.` : ''
    reasons.push({ code: 'VARIABLES_CHANGED', explanation: `Variables changed since the last deploy${keys.length ? `: ${list(keys)}` : ''}. Deploy to apply them.${unresolved}`, keys })
  }
  const snapshot = current.config_snapshot as Record<string, unknown>
  const fields = configFields.filter(field => canonical((svc as Record<string, unknown>)[field]) !== canonical(snapshot[field]))
  if (fields.length) reasons.push({ code: 'CONFIG_CHANGED', explanation: `Configuration changed since the last deploy: ${list(fields)}. Deploy to apply it.`, keys: [...fields] })
  return { reasons, reads }
}

export const refreshStale = (db: Db, serviceIds?: string[]) => {
  const readers = new Map<string, string[]>()
  if (serviceIds && serviceIds.length === 0) return readers
  const rows = db
    .select()
    .from(service)
    .where(serviceIds ? inArray(service.id, serviceIds) : undefined)
    .all()
  for (const svc of rows) {
    const { reasons, reads } = staleness(db, svc)
    for (const id of new Set(reads)) readers.set(id, [...(readers.get(id) ?? []), svc.id])
    if (svc.stale === reasons.length > 0 && canonical(svc.stale_reasons) === canonical(reasons)) continue
    db.update(service).set({ stale: reasons.length > 0, stale_reasons: reasons }).where(eq(service.id, svc.id)).run()
  }
  return readers
}

const sandboxReaders = (db: Db) => {
  const readers = new Map<string, string[]>()
  const owners = new Set(db.select({ id: variable.sandbox_id }).from(variable).where(eq(variable.scope, 'sandbox')).all().map(v => v.id))
  for (const box of db.select({ id: sandbox.id }).from(sandbox).all()) {
    if (!owners.has(box.id)) continue
    for (const entry of sandboxEntries(db, box.id)) {
      for (const leaf of leaves(entry.node)) if (leaf.kind === 'value') readers.set(leaf.secret_value_id, [...new Set([...(readers.get(leaf.secret_value_id) ?? []), box.id])])
    }
  }
  return readers
}

export const settleVariableWrites = (db: Db, writes: VariableWrite[]) => {
  const readers = refreshStale(db)
  const boxes = sandboxReaders(db)
  for (const write of writes) {
    db.insert(event)
      .values({
        type: 'secret.changed',
        subject: { entity: 'variable', id: write.variable_id, project_id: write.project_id },
        payload: { variable: write.variable_id, scope: write.scope, version: write.version, dependents: readers.get(write.secret_value_id) ?? [], sandboxes: boxes.get(write.secret_value_id) ?? [], actor: write.actor },
        delivered: {}
      })
      .run()
  }
}

export const staleDependents = (db: Db, projectId: string | null, serviceIds?: Set<string>): StaleDependent[] =>
  db
    .select({ svc: service, env: environment })
    .from(service)
    .innerJoin(environment, eq(environment.id, service.environment_id))
    .where(and(eq(service.stale, true), projectId === null ? undefined : eq(environment.project_id, projectId)))
    .all()
    .flatMap(({ svc, env }) => {
      if (serviceIds && !serviceIds.has(svc.id)) return []
      const reason = svc.stale_reasons.find(r => r.code === 'VARIABLES_CHANGED')
      return reason ? [{ service_id: svc.id, environment_id: env.id, protected: env.protected, keys: reason.keys }] : []
    })
