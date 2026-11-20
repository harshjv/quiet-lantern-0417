import { and, eq, inArray } from 'drizzle-orm'

import type { Db } from '../db/client.ts'
import {
  app,
  deployment,
  environment_variable,
  event,
  machine,
  target,
  type StaleReasonValue,
} from '../db/schema.ts'
import { canonical } from '../generation/hash.ts'
import { envDigest, envOf, generationEnv } from '../secrets/deploy.ts'
import { SecretsError } from '../secrets/errors.ts'
import { leaves, Resolver } from '../secrets/resolve.ts'
import { machineEntries } from '../secrets/sandbox.ts'
import type { VariableWrite } from '../secrets/variables.ts'

import { configFields } from './deployments.ts'

type AppRow = typeof app.$inferSelect

export type StaleDependent = {
  app_id: string
  project_id: string
  preview_id: string | null
  environment_variables: string[]
}

const canonicalOrNull = (value: unknown) => canonical(value ?? null)

const list = (keys: string[]) => keys.join(', ')

const pendingEnv = (db: Db, svc: AppRow) => {
  const resolver = Resolver.forApp(db, svc.id)
  const entries = []
  const unresolved: string[] = []

  for (const v of resolver.appVariables()) {
    try {
      entries.push({
        key: v.name,
        injection: v.injection,
        node: resolver.resolve(v),
      })
    } catch (error) {
      if (!(error instanceof SecretsError)) {
        throw error
      }

      unresolved.push(v.name)
    }
  }

  const env = envOf(
    db,
    {
      app_id: svc.id,
      target_id: svc.target_id,
      deployment_id: svc.current_deployment_id ?? '',
    },
    entries,
  )

  return {
    env,
    unresolved,
  }
}

const changedVariables = (
  deployed: ReturnType<typeof envOf>,
  pending: ReturnType<typeof envOf>,
  unresolved: string[],
) => {
  const shape = (env: ReturnType<typeof envOf>) =>
    new Map(env.map(({ value: _value, ...rest }) => [rest.key, canonicalOrNull(rest)]))
  const before = shape(deployed)
  const after = shape(pending)
  const keys = new Set(unresolved)

  for (const key of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(key) !== after.get(key)) {
      keys.add(key)
    }
  }

  return [...keys].sort()
}

const deployedEnv = (db: Db, deploymentId: string) => {
  try {
    return generationEnv(db, deploymentId)
  } catch (error) {
    if (!(error instanceof SecretsError)) {
      throw error
    }

    return {
      env: [] as ReturnType<typeof envOf>,
      env_digest: null,
    }
  }
}

export const staleness = (db: Db, svc: AppRow) => {
  const pending = pendingEnv(db, svc)
  const reads = pending.env.flatMap((entry) =>
    entry.refs.flatMap((ref) => ('secret_value_id' in ref ? [ref.secret_value_id] : [])),
  )

  if (!svc.current_deployment_id) {
    return {
      reasons: [] as StaleReasonValue[],
      reads,
    }
  }

  const current = db
    .select({
      config_snapshot: deployment.config_snapshot,
    })
    .from(deployment)
    .where(eq(deployment.id, svc.current_deployment_id))
    .get()

  if (!current) {
    return {
      reasons: [] as StaleReasonValue[],
      reads,
    }
  }

  const reasons: StaleReasonValue[] = []
  const deployed = deployedEnv(db, svc.current_deployment_id)
  const digest = pending.unresolved.length ? null : envDigest(pending.env)

  if (digest === null || digest !== deployed.env_digest) {
    const keys = changedVariables(deployed.env, pending.env, pending.unresolved)
    const unresolved = pending.unresolved.length
      ? ` ${list(pending.unresolved)} does not resolve, so the next deploy fails until it does.`
      : ''

    reasons.push({
      code: 'ENVIRONMENT_VARIABLES_CHANGED',
      explanation: `Environment variables changed since the last deploy${keys.length ? `: ${list(keys)}` : ''}. Deploy to apply them.${unresolved}`,
      names: keys,
    })
  }

  const snapshot = current.config_snapshot as Record<string, unknown>
  const fields = configFields.filter(
    (field) =>
      canonicalOrNull((svc as Record<string, unknown>)[field]) !== canonicalOrNull(snapshot[field]),
  )

  if (fields.length) {
    reasons.push({
      code: 'CONFIG_CHANGED',
      explanation: `Configuration changed since the last deploy: ${list(fields)}. Deploy to apply it.`,
      names: [...fields],
    })
  }

  return {
    reasons,
    reads,
  }
}

export const refreshStale = (db: Db, appIds?: string[]) => {
  const readers = new Map<string, string[]>()

  if (appIds && appIds.length === 0) {
    return readers
  }

  const rows = db
    .select()
    .from(app)
    .where(appIds ? inArray(app.id, appIds) : undefined)
    .all()

  for (const svc of rows) {
    const { reasons, reads } = staleness(db, svc)

    for (const id of new Set(reads)) {
      readers.set(id, [...(readers.get(id) ?? []), svc.id])
    }

    if (
      svc.stale === reasons.length > 0 &&
      canonicalOrNull(svc.stale_reasons) === canonicalOrNull(reasons)
    ) {
      continue
    }

    db.update(app)
      .set({
        stale: reasons.length > 0,
        stale_reasons: reasons,
      })
      .where(eq(app.id, svc.id))
      .run()
  }

  return readers
}

const machineReaders = (db: Db) => {
  const readers = new Map<string, string[]>()
  const owners = new Set(
    db
      .select({
        id: environment_variable.machine_id,
      })
      .from(environment_variable)
      .where(eq(environment_variable.scope, 'machine'))
      .all()
      .map((v) => v.id),
  )

  for (const box of db
    .select({
      id: machine.id,
    })
    .from(machine)
    .all()) {
    if (!owners.has(box.id)) {
      continue
    }

    for (const entry of machineEntries(db, box.id)) {
      for (const leaf of leaves(entry.node)) {
        if (leaf.kind === 'value') {
          readers.set(leaf.secret_value_id, [
            ...new Set([...(readers.get(leaf.secret_value_id) ?? []), box.id]),
          ])
        }
      }
    }
  }

  return readers
}

export const settleVariableWrites = (db: Db, writes: VariableWrite[]) => {
  const readers = refreshStale(db)
  const boxes = machineReaders(db)

  for (const write of writes) {
    db.insert(event)
      .values({
        type: 'secret.changed',
        subject: {
          entity: 'environment_variable',
          id: write.environment_variable_id,
          project_id: write.project_id,
        },
        payload: {
          environment_variable_id: write.environment_variable_id,
          scope: write.scope,
          version: write.version,
          dependents: readers.get(write.secret_value_id) ?? [],
          machines: boxes.get(write.secret_value_id) ?? [],
          actor: write.actor,
        },
        delivered: {},
      })
      .run()
  }
}

export const staleDependents = (
  db: Db,
  projectId: string | null,
  appIds?: Set<string>,
): StaleDependent[] =>
  db
    .select({
      svc: app,
      env: target,
    })
    .from(app)
    .innerJoin(target, eq(target.id, app.target_id))
    .where(
      and(eq(app.stale, true), projectId === null ? undefined : eq(target.project_id, projectId)),
    )
    .all()
    .flatMap(({ svc, env }) => {
      if (appIds && !appIds.has(svc.id)) {
        return []
      }

      const reason = svc.stale_reasons.find((r) => r.code === 'ENVIRONMENT_VARIABLES_CHANGED')

      return reason
        ? [
            {
              app_id: svc.id,
              project_id: env.project_id,
              preview_id: env.kind === 'preview' ? env.id : null,
              environment_variables: reason.names,
            },
          ]
        : []
    })
