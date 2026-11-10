import type { Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { asc, desc, eq } from 'drizzle-orm'

import { EnvEntry, type Actor, type MessageBody } from '@stationly/protocol'

import type { Db } from '../db/client.ts'
import { newId } from '../db/ids.ts'
import { deployment, service, service_port } from '../db/schema.ts'
import { sha256Digest } from '../generation/hash.ts'

import { knownRedaction, refsOf, renderedDelivery } from './deliver.ts'
import { SecretsError } from './errors.ts'
import type { Keyring } from './keyring.ts'
import { isFallback, isSealed, leaves, Resolver, type SourceNode } from './resolve.ts'

type ActorValue = Static<typeof Actor>
type EnvEntryValue = Static<typeof EnvEntry>
type SecretsDeliver = MessageBody<'secrets.deliver'>
type Purpose = SecretsDeliver['purpose']

export type SnapshotEntry = {
  key: string
  variable_id: string
  kind: 'literal' | 'reference' | 'sealed'
  injection: 'env' | 'file'
  build: boolean
  sealed: boolean
  fallback_from_protected: boolean
  node: SourceNode
}

export type EnvSnapshot = { resolved_at: string; entries: SnapshotEntry[] }

export const snapshotOf = (db: Db, serviceId: string): EnvSnapshot => {
  const resolver = Resolver.forService(db, serviceId)
  const entries = resolver.serviceVariables().map((v) => {
    let node: SourceNode
    try {
      node = resolver.resolve(v)
    } catch (error) {
      if (error instanceof SecretsError)
        Object.assign(error.details, {
          key: v.key,
        })
      throw error
    }
    return {
      key: v.key,
      variable_id: v.id,
      kind: v.kind,
      injection: v.injection,
      build: v.build,
      sealed: isSealed(node),
      fallback_from_protected: isFallback(node),
      node,
    }
  })
  return {
    resolved_at: new Date().toISOString(),
    entries,
  }
}

export const createDeployment = (
  db: Db,
  input: {
    service_id: string
    image_ref: string
    trigger: 'manual' | 'variable_change' | 'redeploy'
    actor: ActorValue
  },
) => {
  const svc = db.select().from(service).where(eq(service.id, input.service_id)).get()
  if (!svc) throw new SecretsError('NOT_FOUND', `service ${input.service_id} does not exist`)
  const env_snapshot = snapshotOf(db, svc.id)
  const last = db
    .select({
      number: deployment.number,
    })
    .from(deployment)
    .where(eq(deployment.service_id, svc.id))
    .orderBy(desc(deployment.number))
    .limit(1)
    .get()
  const id = newId('deployment')
  const number = (last?.number ?? 0) + 1
  const { id: _id, created_at: _c, updated_at: _u, ...config } = svc
  db.insert(deployment)
    .values({
      id,
      service_id: svc.id,
      number,
      trigger: {
        type: input.trigger,
        actor: input.actor,
        source_sha: null,
        rollback_of: null,
      },
      image_ref: input.image_ref,
      env_snapshot,
      config_snapshot: config,
      strategy: svc.strategy,
      base_images: [],
    })
    .run()
  return {
    deployment_id: id,
    number,
  }
}

export const activateDeployment = (db: Db, deploymentId: string) => {
  const dep = db.select().from(deployment).where(eq(deployment.id, deploymentId)).get()
  if (!dep) throw new SecretsError('NOT_FOUND', `deployment ${deploymentId} does not exist`)
  db.update(deployment)
    .set({
      status: 'active',
      finished_at: new Date(),
    })
    .where(eq(deployment.id, deploymentId))
    .run()
  db.update(service)
    .set({
      current_deployment_id: deploymentId,
    })
    .where(eq(service.id, dep.service_id))
    .run()
  return dep.service_id
}

const snapshotFor = (db: Db, deploymentId: string) => {
  const dep = db.select().from(deployment).where(eq(deployment.id, deploymentId)).get()
  if (!dep) throw new SecretsError('NOT_FOUND', `deployment ${deploymentId} does not exist`)
  return {
    dep,
    snapshot: dep.env_snapshot as EnvSnapshot,
  }
}

export const envDigest = (env: EnvEntryValue[]) => {
  const stripped = env.map(({ value: _value, ...rest }) => rest)
  return sha256Digest(stripped)
}

export const envOf = (
  db: Db,
  ids: { service_id: string; environment_id: string; deployment_id: string },
  entries: Pick<SnapshotEntry, 'key' | 'injection' | 'node'>[],
): EnvEntryValue[] => {
  const port = db
    .select()
    .from(service_port)
    .where(eq(service_port.service_id, ids.service_id))
    .orderBy(asc(service_port.created_at), asc(service_port.port))
    .get()
  const platform: [string, string][] = [
    ...(port ? ([['PORT', String(port.port)]] as [string, string][]) : []),
    ['STATIONLY_SERVICE_ID', ids.service_id],
    ['STATIONLY_ENVIRONMENT_ID', ids.environment_id],
    ['STATIONLY_DEPLOYMENT_ID', ids.deployment_id],
  ]
  return [
    ...platform.map(([key, value]) => ({
      key,
      injection: 'env' as const,
      refs: [],
      value,
      platform: true,
    })),
    ...entries.map((entry) => ({
      key: entry.key,
      injection: entry.injection,
      refs: refsOf(entry.node),
      platform: false,
    })),
  ]
}

export const generationEnv = (db: Db, deploymentId: string) => {
  const { dep, snapshot } = snapshotFor(db, deploymentId)
  const svc = db.select().from(service).where(eq(service.id, dep.service_id)).get()!
  const config = dep.config_snapshot as {
    environment_id: string
    secrets_owner: { uid: number; gid: number } | null
  }
  const env = envOf(
    db,
    {
      service_id: svc.id,
      environment_id: config.environment_id,
      deployment_id: dep.id,
    },
    snapshot.entries,
  )
  const invalid = env.findIndex((entry) => !Value.Check(EnvEntry, entry))
  if (invalid >= 0)
    throw new SecretsError(
      'VALIDATION_FAILED',
      `env entry ${env[invalid]!.key} does not match EnvEntry`,
    )
  return {
    deployment_id: dep.id,
    number: dep.number,
    service_id: svc.id,
    env,
    env_digest: envDigest(env),
    secrets_owner: config.secrets_owner,
  }
}

export const secretsDeliver = (
  db: Db,
  keyring: Keyring,
  deploymentId: string,
  purpose: Purpose,
  actor: ActorValue,
): SecretsDeliver => {
  const { snapshot } = snapshotFor(db, deploymentId)
  const { env_digest } = generationEnv(db, deploymentId)
  return renderedDelivery(db, keyring, snapshot.entries, {
    target: {
      deployment_id: deploymentId,
    },
    subject: {
      entity: 'deployment',
      id: deploymentId,
    },
    env_digest,
    purpose,
    actor,
  })
}

export const snapshotVersions = (db: Db, deploymentId: string) => {
  const { snapshot } = snapshotFor(db, deploymentId)
  return snapshot.entries.map((entry) => ({
    key: entry.key,
    sealed: entry.sealed,
    sources: leaves(entry.node).map((leaf) =>
      leaf.kind === 'value' ? `${leaf.key}@v${leaf.version}` : `export:${leaf.key}`,
    ),
  }))
}

export const redactionKnown = (
  db: Db,
  keyring: Keyring,
  deploymentId: string,
  actor: ActorValue,
  requestId: string,
) =>
  knownRedaction(
    db,
    keyring,
    snapshotFor(db, deploymentId).snapshot.entries,
    {
      entity: 'deployment',
      id: deploymentId,
    },
    actor,
    requestId,
  )
