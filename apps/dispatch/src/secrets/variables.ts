import { randomBytes } from 'node:crypto'
import type { Actor } from '@stationly/protocol'
import type { Static } from '@sinclair/typebox'
import { and, eq, isNull } from 'drizzle-orm'
import type { Db } from '../db/client.ts'
import { audit_event, deployment, environment, grant, sandbox, secret_value, service, variable } from '../db/schema.ts'
import { newId } from '../db/ids.ts'
import { SecretsError } from './errors.ts'
import { valueBytes, type Keyring } from './keyring.ts'
import { hasReference, keyPattern, parseValue } from './reference.ts'
import { Resolver, isFallback, isSealed, leaves, render, type SourceNode, type ValueNode } from './resolve.ts'
import type { EnvSnapshot } from './deploy.ts'
import { decryptValue, headValue, nextValueVersion } from './values.ts'

type ActorValue = Static<typeof Actor>

export type VariableInput = {
  scope: 'global' | 'project' | 'service' | 'sandbox'
  project_id?: string
  service_id?: string
  sandbox_id?: string
  environment_id?: string | null
  key: string
  value: string
  sealed?: boolean
  injection?: 'env' | 'file'
  build?: boolean
  allow_unresolved?: boolean
  actor: ActorValue
  request_id: string
}

export type VariableWrite = { variable_id: string; project_id: string | null; scope: VariableInput['scope']; actor: ActorValue; secret_value_id: string; version: number }

const generatorOf = (value: string) => {
  if (!value.startsWith('${{')) return null
  try {
    const segments = parseValue(value)
    return segments.length === 1 && segments[0]!.type === 'reference' && segments[0]!.target.type === 'generator' ? segments[0]!.target : null
  } catch {
    return null
  }
}

const deferrable = new Set(['VARIABLE_UNRESOLVED', 'VARIABLE_TARGET_MISSING', 'VARIABLE_NOT_GRANTED', 'VARIABLE_PROTECTED_SOURCE'])

const findVariable = (db: Db, input: VariableInput) => {
  const parent =
    input.scope === 'service'
      ? eq(variable.service_id, input.service_id!)
      : input.scope === 'sandbox'
        ? eq(variable.sandbox_id, input.sandbox_id!)
        : input.scope === 'project'
          ? eq(variable.project_id, input.project_id!)
          : isNull(variable.service_id)
  return db
    .select()
    .from(variable)
    .where(and(eq(variable.scope, input.scope), parent, eq(variable.key, input.key)))
    .get()
}

export const setVariable = (db: Db, keyring: Keyring, input: VariableInput) => {
  if (!keyPattern.test(input.key)) throw new SecretsError('VALIDATION_FAILED', `key ${input.key} must match [A-Z_][A-Z0-9_]*`, { key: input.key })
  if (input.scope !== 'project' && input.environment_id) {
    throw new SecretsError('VALIDATION_FAILED', `only project variables hold per-environment values`, { key: input.key })
  }
  const environmentId = input.scope === 'project' ? (input.environment_id ?? null) : null
  let projectId = input.project_id ?? null
  if (input.scope === 'service') {
    const svc = db
      .select({ project_id: environment.project_id })
      .from(service)
      .innerJoin(environment, eq(environment.id, service.environment_id))
      .where(eq(service.id, input.service_id!))
      .get()
    if (!svc) throw new SecretsError('NOT_FOUND', `service ${input.service_id} does not exist`)
    projectId = svc.project_id
  }
  if (input.scope === 'sandbox') {
    const box = db.select({ project_id: sandbox.project_id }).from(sandbox).where(eq(sandbox.id, input.sandbox_id!)).get()
    if (!box) throw new SecretsError('NOT_FOUND', `sandbox ${input.sandbox_id} does not exist`)
    projectId = box.project_id
  }

  let kind: 'literal' | 'reference' | 'sealed'
  let reference: string | null = null
  let plaintext: string | null
  const sealedGenerator = input.sealed ? generatorOf(input.value) : null
  if (sealedGenerator) {
    kind = 'sealed'
    reference = input.value
    plaintext = randomBytes(sealedGenerator.bytes).toString('base64url')
  } else if (input.sealed) {
    kind = 'sealed'
    plaintext = input.value
  } else {
    const segments = parseValue(input.value)
    const generator = segments[0]?.type === 'reference' && segments[0].target.type === 'generator' ? segments[0].target : null
    if (hasReference(segments) && !generator && input.scope !== 'service' && input.scope !== 'sandbox') {
      throw new SecretsError('VARIABLE_REFERENCE_INVALID', `${input.scope} variables hold values, not references`, { offset: 0 })
    }
    if (generator) {
      kind = 'literal'
      reference = input.value
      plaintext = randomBytes(generator.bytes).toString('base64url')
    } else if (hasReference(segments)) {
      kind = 'reference'
      reference = input.value
      plaintext = null
    } else {
      kind = 'literal'
      plaintext = segments.map(s => (s.type === 'text' ? s.text : '')).join('')
    }
  }

  return db.transaction(tx => {
    const existing = findVariable(tx as unknown as Db, input)
    if (existing?.kind === 'sealed' && kind !== 'sealed') {
      throw new SecretsError('VALIDATION_FAILED', `${input.key} is sealed; converting a sealed variable is not possible, create a new variable instead`, { key: input.key })
    }
    const variableId = existing?.id ?? newId('variable')
    const fields = {
      kind,
      reference,
      injection: input.injection ?? existing?.injection ?? 'env',
      build: input.build ?? existing?.build ?? false
    }
    if (existing) tx.update(variable).set(fields).where(eq(variable.id, variableId)).run()
    else
      tx.insert(variable)
        .values({ id: variableId, scope: input.scope, project_id: projectId, service_id: input.service_id ?? null, sandbox_id: input.sandbox_id ?? null, key: input.key, ...fields })
        .run()

    let written: { secret_value_id: string; version: number } | null = null
    if (plaintext !== null) {
      const id = newId('secret_value')
      const version = nextValueVersion(tx as unknown as Db, variableId, environmentId)
      const sealedValue = keyring.encrypt(id, plaintext)
      tx.insert(secret_value)
        .values({ id, variable_id: variableId, environment_id: environmentId, version, ...sealedValue, created_by: input.actor })
        .run()
      written = { secret_value_id: id, version }
    }
    tx.update(variable)
      .set({ current_value_id: written?.secret_value_id ?? null })
      .where(eq(variable.id, variableId))
      .run()

    const row = tx.select().from(variable).where(eq(variable.id, variableId)).get()!
    let unresolved: SecretsError | null = null
    if (input.scope === 'service') {
      try {
        Resolver.forService(tx as unknown as Db, input.service_id!).resolve(row)
      } catch (error) {
        if (!(error instanceof SecretsError)) throw error
        if (!deferrable.has(error.code) || !input.allow_unresolved) throw error
        unresolved = error
      }
    }
    if (input.scope === 'sandbox') {
      try {
        Resolver.forSandbox(tx as unknown as Db, input.sandbox_id!).resolveSandbox(row)
      } catch (error) {
        if (!(error instanceof SecretsError)) throw error
        if (!deferrable.has(error.code) || !input.allow_unresolved) throw error
        unresolved = error
      }
    }

    tx.insert(audit_event)
      .values({
        actor: input.actor,
        action: 'variable.set',
        target: { entity: 'variable', id: variableId },
        request_id: input.request_id,
        after: { key: input.key, scope: input.scope, kind, environment_id: environmentId, version: written?.version ?? null, reference }
      })
      .run()
    const write: VariableWrite | null = written ? { variable_id: variableId, project_id: projectId, scope: input.scope, actor: input.actor, ...written } : null
    return { variable_id: variableId, kind, write, unresolved: unresolved?.toJSON() ?? null }
  })
}

const deployedVersions = (db: Db, svc: typeof service.$inferSelect) => {
  if (!svc.current_deployment_id) return new Map<string, number>()
  const dep = db.select({ env_snapshot: deployment.env_snapshot }).from(deployment).where(eq(deployment.id, svc.current_deployment_id)).get()
  const snapshot = dep?.env_snapshot as EnvSnapshot | undefined
  const versions = new Map<string, number>()
  for (const entry of snapshot?.entries ?? []) {
    for (const leaf of leaves(entry.node)) if (leaf.kind === 'value') versions.set(`${leaf.variable_id}:${leaf.environment_id}`, leaf.version)
  }
  return versions
}

export const resolvedView = (db: Db, keyring: Keyring, serviceId: string, options: { admin: boolean }) => {
  const resolver = Resolver.forService(db, serviceId)
  const svc = db.select().from(service).where(eq(service.id, serviceId)).get()!
  const deployed = deployedVersions(db, svc)
  return resolver.serviceVariables().map(v => {
    const base = { key: v.key, kind: v.kind, reference: v.reference, injection: v.injection, build: v.build }
    let node: SourceNode
    try {
      node = resolver.resolve(v)
    } catch (error) {
      if (!(error instanceof SecretsError)) throw error
      return { ...base, sources: [], sealed: v.kind === 'sealed', fallback_from_protected: false, stale: true, error: error.toJSON() }
    }
    const templateSegments = v.reference ? parseValue(v.reference).filter(s => s.type === 'reference') : []
    const top = node.kind === 'template' ? node.parts : [node]
    const sources = top.flatMap((part, i) =>
      leaves(part).map(leaf => {
        const reference = node.kind === 'template' ? (templateSegments[i] as { raw: string }).raw : null
        if (leaf.kind === 'export') return { reference, from: leaf.from, service_id: leaf.service_id, key: leaf.key }
        return {
          reference,
          from: leaf.from,
          service_id: leaf.service_id,
          key: leaf.key,
          secret_value_id: leaf.secret_value_id,
          version: leaf.version,
          deployed_version: deployed.get(`${leaf.variable_id}:${leaf.environment_id}`) ?? null,
          sealed: leaf.sealed
        }
      })
    )
    const sealed = isSealed(node)
    const stale = svc.current_deployment_id !== null && sources.some(s => 'version' in s && s.version !== s.deployed_version)
    const value = options.admin && !sealed ? render(node, leaf => decryptLeaf(db, keyring, leaf)) : undefined
    return { ...base, sources, sealed, fallback_from_protected: isFallback(node), ...(value === undefined ? {} : { value }), stale }
  })
}

export const decryptLeaf = (db: Db, keyring: Keyring, leaf: ValueNode) => {
  const row = db.select().from(secret_value).where(eq(secret_value.id, leaf.secret_value_id)).get()
  if (!row || row.version !== leaf.version) throw new SecretsError('SECRETS_UNAVAILABLE', `secret_value ${leaf.secret_value_id} version ${leaf.version} is gone`)
  if (row.revoked_at) throw new SecretsError('ROLLBACK_SECRET_REVOKED', `${leaf.key} version ${leaf.version} is revoked`, { keys: [leaf.key] })
  return decryptValue(keyring, row)
}

export const storedBytes = (db: Db, secretValueId: string) => {
  const row = db.select({ ciphertext: secret_value.ciphertext }).from(secret_value).where(eq(secret_value.id, secretValueId)).get()
  return row ? valueBytes(row.ciphertext) : null
}

export const readValue = (db: Db, keyring: Keyring, serviceId: string, key: string) => {
  const resolver = Resolver.forService(db, serviceId)
  const v = resolver.serviceVariables().find(row => row.key === key)
  if (!v) throw new SecretsError('NOT_FOUND', `variable ${key} does not exist on service ${serviceId}`)
  const node = resolver.resolve(v)
  if (isSealed(node)) throw new SecretsError('SEALED_VALUE_UNREADABLE', `${key} is sealed or built from a sealed value; no endpoint returns it`, { key })
  return render(node, leaf => decryptLeaf(db, keyring, leaf))
}

export const grantGlobal = (db: Db, variableId: string, projectId: string, alias: string | null) => {
  const id = newId('grant')
  db.insert(grant).values({ id, variable_id: variableId, project_id: projectId, alias, source: 'manual' }).run()
  return id
}

export const sealedGlobalValue = (db: Db, keyring: Keyring, key: string) => {
  const row = db.select().from(variable).where(and(eq(variable.scope, 'global'), eq(variable.key, key))).get()
  if (!row) throw new SecretsError('NOT_FOUND', `global variable ${key} does not exist`, { key })
  if (row.kind !== 'sealed') throw new SecretsError('VALIDATION_FAILED', `global variable ${key} is not sealed`, { key })
  const value = headValue(db, row.id, null)
  if (!value) throw new SecretsError('SECRETS_UNAVAILABLE', `global variable ${key} has no value`, { key })
  return { secret_value_id: value.id, value: decryptValue(keyring, value) }
}

export const sealedGlobalExists = (db: Db, key: string) => {
  const row = db.select({ kind: variable.kind }).from(variable).where(and(eq(variable.scope, 'global'), eq(variable.key, key))).get()
  return row ? { sealed: row.kind === 'sealed' } : null
}
