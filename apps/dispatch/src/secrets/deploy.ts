import { randomBytes } from 'node:crypto'
import { EnvEntry, messages, type Actor, type MessageBody } from '@stationly/protocol'
import type { Static } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { asc, desc, eq } from 'drizzle-orm'
import type { Db } from '../db/client.ts'
import { sha256Digest } from '../generation/hash.ts'
import { audit_event, deployment, service, service_port } from '../db/schema.ts'
import { newId } from '../db/ids.ts'
import { SecretsError } from './errors.ts'
import type { Keyring } from './keyring.ts'
import { Resolver, holdsRedacted, isFallback, isRedacted, isSealed, leaves, render, type SourceNode, type ValueNode } from './resolve.ts'
import { decryptLeaf } from './variables.ts'

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
  const entries = resolver.serviceVariables().map(v => {
    let node: SourceNode
    try {
      node = resolver.resolve(v)
    } catch (error) {
      if (error instanceof SecretsError) Object.assign(error.details, { key: v.key })
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
      node
    }
  })
  return { resolved_at: new Date().toISOString(), entries }
}

export const createDeployment = (
  db: Db,
  input: { service_id: string; image_ref: string; trigger: 'manual' | 'variable_change' | 'redeploy'; actor: ActorValue }
) => {
  const svc = db.select().from(service).where(eq(service.id, input.service_id)).get()
  if (!svc) throw new SecretsError('NOT_FOUND', `service ${input.service_id} does not exist`)
  const env_snapshot = snapshotOf(db, svc.id)
  const last = db.select({ number: deployment.number }).from(deployment).where(eq(deployment.service_id, svc.id)).orderBy(desc(deployment.number)).limit(1).get()
  const id = newId('deployment')
  const number = (last?.number ?? 0) + 1
  const { id: _id, created_at: _c, updated_at: _u, ...config } = svc
  db.insert(deployment)
    .values({
      id,
      service_id: svc.id,
      number,
      trigger: { type: input.trigger, actor: input.actor, source_sha: null, rollback_of: null },
      image_ref: input.image_ref,
      env_snapshot,
      config_snapshot: config,
      strategy: svc.strategy,
      base_images: []
    })
    .run()
  return { deployment_id: id, number }
}

export const activateDeployment = (db: Db, deploymentId: string) => {
  const dep = db.select().from(deployment).where(eq(deployment.id, deploymentId)).get()
  if (!dep) throw new SecretsError('NOT_FOUND', `deployment ${deploymentId} does not exist`)
  db.update(deployment).set({ status: 'active', finished_at: new Date() }).where(eq(deployment.id, deploymentId)).run()
  db.update(service).set({ current_deployment_id: deploymentId }).where(eq(service.id, dep.service_id)).run()
  return dep.service_id
}

const snapshotFor = (db: Db, deploymentId: string) => {
  const dep = db.select().from(deployment).where(eq(deployment.id, deploymentId)).get()
  if (!dep) throw new SecretsError('NOT_FOUND', `deployment ${deploymentId} does not exist`)
  return { dep, snapshot: dep.env_snapshot as EnvSnapshot }
}

export const refsOf = (node: SourceNode) =>
  leaves(node).map(leaf =>
    leaf.kind === 'value' ? { secret_value_id: leaf.secret_value_id, version: leaf.version } : { export: { service_id: leaf.service_id, key: leaf.key } }
  )

export const envDigest = (env: EnvEntryValue[]) => {
  const stripped = env.map(({ value: _value, ...rest }) => rest)
  return sha256Digest(stripped)
}

export const envOf = (db: Db, ids: { service_id: string; environment_id: string; deployment_id: string }, entries: Pick<SnapshotEntry, 'key' | 'injection' | 'node'>[]): EnvEntryValue[] => {
  const port = db.select().from(service_port).where(eq(service_port.service_id, ids.service_id)).orderBy(asc(service_port.created_at), asc(service_port.port)).get()
  const platform: [string, string][] = [
    ...(port ? ([['PORT', String(port.port)]] as [string, string][]) : []),
    ['STATIONLY_SERVICE_ID', ids.service_id],
    ['STATIONLY_ENVIRONMENT_ID', ids.environment_id],
    ['STATIONLY_DEPLOYMENT_ID', ids.deployment_id]
  ]
  return [
    ...platform.map(([key, value]) => ({ key, injection: 'env' as const, refs: [], value, platform: true })),
    ...entries.map(entry => ({ key: entry.key, injection: entry.injection, refs: refsOf(entry.node), platform: false }))
  ]
}

export const generationEnv = (db: Db, deploymentId: string) => {
  const { dep, snapshot } = snapshotFor(db, deploymentId)
  const svc = db.select().from(service).where(eq(service.id, dep.service_id)).get()!
  const config = dep.config_snapshot as { environment_id: string; secrets_owner: { uid: number; gid: number } | null }
  const env = envOf(db, { service_id: svc.id, environment_id: config.environment_id, deployment_id: dep.id }, snapshot.entries)
  const invalid = env.findIndex(entry => !Value.Check(EnvEntry, entry))
  if (invalid >= 0) throw new SecretsError('VALIDATION_FAILED', `env entry ${env[invalid]!.key} does not match EnvEntry`)
  return { deployment_id: dep.id, number: dep.number, service_id: svc.id, env, env_digest: envDigest(env), secrets_owner: config.secrets_owner }
}

export const renderEntries = (db: Db, keyring: Keyring, entries: { key: string; node: SourceNode }[]) => {
  const decrypted = new Map<string, string>()
  const redacted = new Map<string, { key: string; value: string }>()
  const plaintext = (leaf: ValueNode) => {
    const cached = decrypted.get(leaf.secret_value_id)
    if (cached !== undefined) return cached
    const value = decryptLeaf(db, keyring, leaf)
    decrypted.set(leaf.secret_value_id, value)
    if (isRedacted(leaf)) redacted.set(leaf.secret_value_id, { key: leaf.key, value })
    return value
  }
  const rendered = entries.map(entry => ({ key: entry.key, value: render(entry.node, plaintext), redacted: holdsRedacted(entry.node) }))
  const redaction = [...rendered.filter(r => r.redacted).map(({ key, value }) => ({ key, value })), ...redacted.values()]
  return { rendered, redaction, decryptedIds: [...decrypted.keys()] }
}

export const secretsDeliver = (db: Db, keyring: Keyring, deploymentId: string, purpose: Purpose, actor: ActorValue): SecretsDeliver => {
  const { snapshot } = snapshotFor(db, deploymentId)
  const { env_digest } = generationEnv(db, deploymentId)
  const { rendered, redaction: known, decryptedIds } = renderEntries(db, keyring, snapshot.entries)
  const values = snapshot.entries.map((entry, i) => ({
    key: entry.key,
    injection: entry.injection,
    refs: refsOf(entry.node),
    value: Buffer.from(rendered[i]!.value, 'utf8').toString('base64url')
  }))
  const redaction = known.map(p => ({ key: p.key, value: Buffer.from(p.value, 'utf8').toString('base64url') }))
  const body: SecretsDeliver = { target: { deployment_id: deploymentId }, env_digest, purpose, values, redaction }
  if (!Value.Check(messages['secrets.deliver'].body, body)) {
    const issue = Value.Errors(messages['secrets.deliver'].body, body).First()
    throw new SecretsError('PROTOCOL_INVALID_MESSAGE', `secrets.deliver body does not match its schema at ${issue?.path}: ${issue?.message}`)
  }
  db.insert(audit_event)
    .values({
      actor,
      action: 'secret.decrypt',
      target: { entity: 'deployment', id: deploymentId },
      request_id: `req_${randomBytes(8).toString('hex')}`,
      purpose,
      after: { secret_value_ids: decryptedIds }
    })
    .run()
  return body
}

export const snapshotVersions = (db: Db, deploymentId: string) => {
  const { snapshot } = snapshotFor(db, deploymentId)
  return snapshot.entries.map(entry => ({
    key: entry.key,
    sealed: entry.sealed,
    sources: leaves(entry.node).map(leaf => (leaf.kind === 'value' ? `${leaf.key}@v${leaf.version}` : `export:${leaf.key}`))
  }))
}

export const redactionKnown = (db: Db, keyring: Keyring, deploymentId: string, actor: ActorValue, requestId: string) => {
  const { snapshot } = snapshotFor(db, deploymentId)
  const { redaction, decryptedIds } = renderEntries(db, keyring, snapshot.entries)
  if (decryptedIds.length) {
    db.insert(audit_event)
      .values({
        actor,
        action: 'secret.decrypt',
        target: { entity: 'deployment', id: deploymentId },
        request_id: requestId,
        purpose: 'redaction',
        after: { secret_value_ids: decryptedIds }
      })
      .run()
  }
  return redaction
}
