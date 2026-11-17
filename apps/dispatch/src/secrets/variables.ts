import { randomBytes } from 'node:crypto'

import type { Static } from '@sinclair/typebox'
import { and, eq, isNull } from 'drizzle-orm'

import { keyNamePattern, type Actor } from '@stationly/protocol'

import { recordAudit } from '../db/audit.ts'
import type { Db } from '../db/client.ts'
import { newId } from '../db/ids.ts'
import { app, deployment, key, machine, secret_value, target } from '../db/schema.ts'

import type { EnvSnapshot } from './deploy.ts'
import { SecretsError } from './errors.ts'
import { valueBytes, type Keyring } from './keyring.ts'
import { hasReference, keyPattern, parseValue } from './reference.ts'
import { isSealed, leaves, render, Resolver, type SourceNode, type ValueNode } from './resolve.ts'
import { decryptValue, headValue, nextValueVersion, type ValueTarget } from './values.ts'

type ActorValue = Static<typeof Actor>

export type KeyInput = {
  scope: 'global' | 'project' | 'app' | 'machine'
  project_id?: string
  app_id?: string
  machine_id?: string
  target?: ValueTarget
  name: string
  value: string
  sealed?: boolean
  injection?: 'env' | 'file'
  build?: boolean
  empty?: boolean
  allow_unresolved?: boolean
  actor: ActorValue
  request_id: string
}

export type KeyWrite = {
  key_id: string
  project_id: string | null
  scope: KeyInput['scope']
  actor: ActorValue
  secret_value_id: string
  version: number
}

const generatorOf = (value: string) => {
  if (!value.startsWith('${{')) {
    return null
  }

  try {
    const segments = parseValue(value)

    return segments.length === 1 &&
      segments[0]!.type === 'reference' &&
      segments[0]!.target.type === 'generator'
      ? segments[0]!.target
      : null
  } catch {
    return null
  }
}

const deferrable = new Set(['KEY_UNRESOLVED', 'KEY_TARGET_MISSING', 'KEY_NOT_GRANTED'])

const findKey = (db: Db, input: KeyInput) => {
  const parent =
    input.scope === 'app'
      ? eq(key.app_id, input.app_id!)
      : input.scope === 'machine'
        ? eq(key.machine_id, input.machine_id!)
        : input.scope === 'project'
          ? eq(key.project_id, input.project_id!)
          : isNull(key.app_id)

  return db
    .select()
    .from(key)
    .where(and(eq(key.scope, input.scope), parent, eq(key.name, input.name)))
    .get()
}

export const setKey = (db: Db, keyring: Keyring, input: KeyInput) => {
  if (!keyPattern.test(input.name)) {
    throw new SecretsError('VALIDATION_FAILED', `key ${input.name} must match ${keyNamePattern}`, {
      key: input.name,
    })
  }

  const valueTarget = input.target ?? 'production'

  if (valueTarget === 'preview' && input.scope !== 'project' && input.scope !== 'app') {
    throw new SecretsError('VALIDATION_FAILED', `only project and app keys hold preview values`, {
      key: input.name,
    })
  }

  let projectId = input.project_id ?? null

  if (input.scope === 'app') {
    const svc = db
      .select({
        project_id: target.project_id,
      })
      .from(app)
      .innerJoin(target, eq(target.id, app.target_id))
      .where(eq(app.id, input.app_id!))
      .get()

    if (!svc) {
      throw new SecretsError('NOT_FOUND', `app ${input.app_id} does not exist`)
    }

    projectId = svc.project_id
  }

  if (input.scope === 'machine') {
    const box = db
      .select({
        project_id: machine.project_id,
      })
      .from(machine)
      .where(eq(machine.id, input.machine_id!))
      .get()

    if (!box) {
      throw new SecretsError('NOT_FOUND', `machine ${input.machine_id} does not exist`)
    }

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
    plaintext = input.empty ? null : input.value
  } else {
    const segments = parseValue(input.value)
    const generator =
      segments[0]?.type === 'reference' && segments[0].target.type === 'generator'
        ? segments[0].target
        : null

    if (
      hasReference(segments) &&
      !generator &&
      input.scope !== 'app' &&
      input.scope !== 'machine'
    ) {
      throw new SecretsError(
        'KEY_REFERENCE_INVALID',
        `${input.scope} keys hold values, not references`,
        {
          offset: 0,
        },
      )
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
      plaintext = segments.map((s) => (s.type === 'text' ? s.text : '')).join('')
    }
  }

  return db.transaction((tx) => {
    const existing = findKey(tx, input)

    if (existing?.kind === 'sealed' && kind !== 'sealed') {
      throw new SecretsError(
        'VALIDATION_FAILED',
        `${input.name} is sealed; converting a sealed key is not possible, create a new key instead`,
        {
          key: input.name,
        },
      )
    }

    const keyId = existing?.id ?? newId('key')
    const fields = {
      kind,
      reference,
      injection: input.injection ?? existing?.injection ?? 'env',
      build: input.build ?? existing?.build ?? false,
    }

    if (existing) {
      tx.update(key).set(fields).where(eq(key.id, keyId)).run()
    } else {
      tx.insert(key)
        .values({
          id: keyId,
          scope: input.scope,
          project_id: projectId,
          app_id: input.app_id ?? null,
          machine_id: input.machine_id ?? null,
          name: input.name,
          ...fields,
        })
        .run()
    }

    let written: { secret_value_id: string; version: number } | null = null

    if (plaintext !== null) {
      const id = newId('secret_value')
      const version = nextValueVersion(tx, keyId, valueTarget)
      const sealedValue = keyring.encrypt(id, plaintext)

      tx.insert(secret_value)
        .values({
          id,
          key_id: keyId,
          target: valueTarget,
          version,
          ...sealedValue,
          created_by: input.actor,
        })
        .run()
      written = {
        secret_value_id: id,
        version,
      }
    }

    tx.update(key)
      .set({
        current_value_id: written?.secret_value_id ?? null,
      })
      .where(eq(key.id, keyId))
      .run()

    const row = tx.select().from(key).where(eq(key.id, keyId)).get()!
    let unresolved: SecretsError | null = null

    if (input.scope === 'app') {
      try {
        Resolver.forApp(tx, input.app_id!).resolve(row)
      } catch (error) {
        if (!(error instanceof SecretsError)) {
          throw error
        }

        if (!deferrable.has(error.code) || !input.allow_unresolved) {
          throw error
        }

        unresolved = error
      }
    }

    if (input.scope === 'machine') {
      try {
        Resolver.forMachine(tx, input.machine_id!).resolveMachine(row)
      } catch (error) {
        if (!(error instanceof SecretsError)) {
          throw error
        }

        if (!deferrable.has(error.code) || !input.allow_unresolved) {
          throw error
        }

        unresolved = error
      }
    }

    recordAudit(tx, {
      actor: input.actor,
      action: 'key.set',
      target: {
        entity: 'key',
        id: keyId,
      },
      requestId: input.request_id,
      after: {
        name: input.name,
        scope: input.scope,
        kind,
        target: valueTarget,
        version: written?.version ?? null,
        reference,
      },
    })
    const write: KeyWrite | null = written
      ? {
          key_id: keyId,
          project_id: projectId,
          scope: input.scope,
          actor: input.actor,
          ...written,
        }
      : null

    return {
      key_id: keyId,
      kind,
      write,
      unresolved: unresolved?.toJSON() ?? null,
    }
  })
}

const deployedVersions = (db: Db, svc: typeof app.$inferSelect) => {
  if (!svc.current_deployment_id) {
    return new Map<string, number>()
  }

  const dep = db
    .select({
      env_snapshot: deployment.env_snapshot,
    })
    .from(deployment)
    .where(eq(deployment.id, svc.current_deployment_id))
    .get()
  const snapshot = dep?.env_snapshot as EnvSnapshot | undefined
  const versions = new Map<string, number>()

  for (const entry of snapshot?.entries ?? []) {
    for (const leaf of leaves(entry.node)) {
      if (leaf.kind === 'value') {
        versions.set(`${leaf.key_id}:${leaf.target}`, leaf.version)
      }
    }
  }

  return versions
}

export const resolvedView = (
  db: Db,
  keyring: Keyring,
  appId: string,
  options: { admin: boolean },
) => {
  const resolver = Resolver.forApp(db, appId)
  const svc = db.select().from(app).where(eq(app.id, appId)).get()!
  const deployed = deployedVersions(db, svc)

  return resolver.appKeys().map((v) => {
    const base = {
      name: v.name,
      kind: v.kind,
      reference: v.reference,
      injection: v.injection,
      build: v.build,
    }
    let node: SourceNode

    try {
      node = resolver.resolve(v)
    } catch (error) {
      if (!(error instanceof SecretsError)) {
        throw error
      }

      return {
        ...base,
        sources: [],
        sealed: v.kind === 'sealed',
        stale: true,
        error: error.toJSON(),
      }
    }

    const templateSegments = v.reference
      ? parseValue(v.reference).filter((s) => s.type === 'reference')
      : []
    const top = node.kind === 'template' ? node.parts : [node]
    const sources = top.flatMap((part, i) =>
      leaves(part).map((leaf) => {
        const reference =
          node.kind === 'template' ? (templateSegments[i] as { raw: string }).raw : null

        if (leaf.kind === 'export') {
          return {
            reference,
            from: leaf.from,
            app_id: leaf.app_id,
            key: leaf.key,
          }
        }

        return {
          reference,
          from: leaf.from,
          app_id: leaf.app_id,
          key: leaf.key,
          secret_value_id: leaf.secret_value_id,
          version: leaf.version,
          deployed_version: deployed.get(`${leaf.key_id}:${leaf.target}`) ?? null,
          sealed: leaf.sealed,
        }
      }),
    )
    const sealed = isSealed(node)
    const stale =
      svc.current_deployment_id !== null &&
      sources.some((s) => 'version' in s && s.version !== s.deployed_version)
    const value =
      options.admin && !sealed ? render(node, (leaf) => decryptLeaf(db, keyring, leaf)) : undefined

    return {
      ...base,
      sources,
      sealed,
      ...(value === undefined
        ? {}
        : {
            value,
          }),
      stale,
    }
  })
}

export const decryptLeaf = (db: Db, keyring: Keyring, leaf: ValueNode) => {
  const row = db.select().from(secret_value).where(eq(secret_value.id, leaf.secret_value_id)).get()

  if (!row || row.version !== leaf.version) {
    throw new SecretsError(
      'SECRETS_UNAVAILABLE',
      `secret_value ${leaf.secret_value_id} version ${leaf.version} is gone`,
    )
  }

  if (row.revoked_at) {
    throw new SecretsError(
      'ROLLBACK_SECRET_REVOKED',
      `${leaf.key} version ${leaf.version} is revoked`,
      {
        keys: [leaf.key],
      },
    )
  }

  return decryptValue(keyring, row)
}

export const storedBytes = (db: Db, secretValueId: string) => {
  const row = db
    .select({
      ciphertext: secret_value.ciphertext,
    })
    .from(secret_value)
    .where(eq(secret_value.id, secretValueId))
    .get()

  return row ? valueBytes(row.ciphertext) : null
}

export const sealedGlobalValue = (db: Db, keyring: Keyring, name: string) => {
  const row = db
    .select()
    .from(key)
    .where(and(eq(key.scope, 'global'), eq(key.name, name)))
    .get()

  if (!row) {
    throw new SecretsError('NOT_FOUND', `global key ${name} does not exist`, {
      key: name,
    })
  }

  if (row.kind !== 'sealed') {
    throw new SecretsError('VALIDATION_FAILED', `global key ${name} is not sealed`, {
      key: name,
    })
  }

  const value = headValue(db, row.id, 'production')

  if (!value) {
    throw new SecretsError('SECRETS_UNAVAILABLE', `global key ${name} has no value`, {
      key: name,
    })
  }

  return {
    secret_value_id: value.id,
    value: decryptValue(keyring, value),
  }
}

export const sealedGlobalExists = (db: Db, name: string) => {
  const row = db
    .select({
      kind: key.kind,
    })
    .from(key)
    .where(and(eq(key.scope, 'global'), eq(key.name, name)))
    .get()

  return row
    ? {
        sealed: row.kind === 'sealed',
      }
    : null
}
