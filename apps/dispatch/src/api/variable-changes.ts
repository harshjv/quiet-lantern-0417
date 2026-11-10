import { and, eq, inArray } from 'drizzle-orm'
import type { Principal } from '../auth/principal.ts'
import type { Target } from '../auth/scopes.ts'
import type { Db } from '../db/client.ts'
import type { Keyring } from '../secrets/keyring.ts'
import { environment, service, variable } from '../db/schema.ts'
import { SecretsError } from '../secrets/errors.ts'
import { hasReference, parseValue } from '../secrets/reference.ts'
import { decryptValue, headValue, nextValueVersion } from '../secrets/values.ts'
import { requireInstance, requireLevel } from './access.ts'
import type { ChangeSet } from './changes.ts'
import { fail, fromSecretsError, invalid } from './errors.ts'
import type { VariableRow } from './lookup.ts'

export type VariableItem = {
  key: string
  kind: 'literal' | 'reference' | 'sealed'
  value?: string
  reference?: string
  injection?: 'env' | 'file'
  build?: boolean
}

export type VariableScope =
  | { scope: 'service'; parent: string; serviceId: string | null; target: Target }
  | { scope: 'project'; parent: string; environmentId: string | null; target: Target }
  | { scope: 'sandbox'; parent: string; sandboxId: string; target: Target }
  | { scope: 'global'; target: Target }

const parse = (text: string) => {
  try {
    return parseValue(text)
  } catch (error) {
    if (error instanceof SecretsError) throw fromSecretsError(error)
    throw error
  }
}

export const existingVariables = (db: Db, scope: VariableScope): VariableRow[] => {
  if (scope.scope === 'service') {
    if (!scope.serviceId) return []
    return db.select().from(variable).where(and(eq(variable.scope, 'service'), eq(variable.service_id, scope.serviceId))).all()
  }
  if (scope.scope === 'sandbox') return db.select().from(variable).where(and(eq(variable.scope, 'sandbox'), eq(variable.sandbox_id, scope.sandboxId))).all()
  if (scope.scope === 'project') return db.select().from(variable).where(and(eq(variable.scope, 'project'), eq(variable.project_id, scope.parent))).all()
  return db.select().from(variable).where(eq(variable.scope, 'global')).all()
}

export const dependentsOf = (db: Db, row: VariableRow) => {
  const candidates = db.select().from(variable).where(and(eq(variable.scope, 'service'), eq(variable.kind, 'reference'))).all()
  const owner = row.scope === 'service' ? db.select().from(service).where(eq(service.id, row.service_id!)).get() : undefined
  const projectEnvs =
    row.scope === 'project' ? db.select({ id: environment.id }).from(environment).where(eq(environment.project_id, row.project_id!)).all().map(e => e.id) : []
  const projectServices = projectEnvs.length ? new Set(db.select({ id: service.id }).from(service).where(inArray(service.environment_id, projectEnvs)).all().map(s => s.id)) : new Set<string>()
  const out: { entity: 'variable'; id: string; key: string; service_id: string }[] = []
  for (const candidate of candidates) {
    if (candidate.id === row.id || !candidate.reference) continue
    let segments: ReturnType<typeof parseValue>
    try {
      segments = parseValue(candidate.reference)
    } catch {
      continue
    }
    const hit = segments.some(segment => {
      if (segment.type !== 'reference') return false
      const target = segment.target
      if (row.scope === 'service' && target.type === 'service' && owner) {
        if (target.service !== owner.name || target.key !== row.key) return false
        const candidateOwner = db.select({ environment_id: service.environment_id }).from(service).where(eq(service.id, candidate.service_id!)).get()
        return candidateOwner?.environment_id === owner.environment_id
      }
      if (row.scope === 'project' && target.type === 'project') return target.key === row.key && projectServices.has(candidate.service_id!)
      if (row.scope === 'global' && target.type === 'global') return target.key === row.key
      return false
    })
    if (hit) out.push({ entity: 'variable', id: candidate.id, key: candidate.key, service_id: candidate.service_id! })
  }
  return out
}

const levelFor = (principal: Principal, scope: VariableScope, kind: string) => {
  if (scope.scope === 'global') return requireInstance(principal, 'admin')
  if (scope.scope === 'project') return requireLevel(principal, scope.target, 'admin')
  return requireLevel(principal, scope.target, kind === 'sealed' ? 'admin' : 'deploy')
}

const unchanged = (db: Db, keyring: Keyring, prior: VariableRow | undefined, item: VariableItem, environmentId: string | null) => {
  if (!prior || prior.kind !== item.kind) return false
  if ((item.injection ?? prior.injection) !== prior.injection || (item.build ?? prior.build) !== prior.build) return false
  if (item.kind === 'reference') return item.reference === prior.reference
  if (item.kind !== 'literal' || item.reference !== undefined || prior.reference !== null || item.value === undefined) return false
  const head = headValue(db, prior.id, environmentId, 'unset')
  return head !== undefined && decryptValue(keyring, head) === item.value
}

export const planVariables = (
  db: Db,
  keyring: Keyring,
  principal: Principal,
  set: ChangeSet,
  scope: VariableScope,
  input: { set?: VariableItem[]; unset?: string[]; allow_unresolved?: boolean },
  options: { replaceAll?: boolean } = {}
) => {
  const existing = new Map(existingVariables(db, scope).map(v => [v.key, v]))
  const issues: { path: string; message: string }[] = []
  const items = input.set ?? []
  items.forEach((item, i) => {
    const path = `/set/${i}`
    if (item.kind === 'reference') {
      if (scope.scope !== 'service' && scope.scope !== 'sandbox') issues.push({ path: `${path}/kind`, message: `${scope.scope} variables hold values, not references` })
      if (item.reference === undefined) issues.push({ path: `${path}/reference`, message: 'required for kind reference' })
      else if (!hasReference(parse(item.reference))) issues.push({ path: `${path}/reference`, message: 'contains no ${{...}} reference' })
      else if (scope.scope === 'sandbox' && parse(item.reference).some(segment => segment.type === 'reference' && segment.target.type !== 'project' && segment.target.type !== 'global'))
        issues.push({ path: `${path}/reference`, message: 'a sandbox variable references ${{project.KEY}}, ${{global.KEY}} or ${{secret(N)}} only, never a service' })
    } else if (item.value === undefined && !(item.kind === 'literal' && item.reference !== undefined)) {
      issues.push({ path: `${path}/value`, message: `required for kind ${item.kind}` })
    }
    if (item.kind === 'literal' && item.value !== undefined && hasReference(parse(item.value))) {
      issues.push({ path: `${path}/value`, message: 'a literal holds no reference; use kind reference, or escape as $${{' })
    }
    if (item.kind === 'literal' && item.reference !== undefined) {
      const segments = parse(item.reference)
      if (!(segments.length === 1 && segments[0]!.type === 'reference' && segments[0]!.target.type === 'generator')) {
        issues.push({ path: `${path}/reference`, message: 'a literal reference must be exactly ${{secret(N)}}' })
      }
    }
    const prior = existing.get(item.key)
    if (prior?.kind === 'sealed' && item.kind !== 'sealed') issues.push({ path: `${path}/kind`, message: `${item.key} is sealed; converting a sealed variable is not possible` })
    if (items.findIndex(other => other.key === item.key) !== i) issues.push({ path: `${path}/key`, message: 'key appears twice' })
  })
  for (const [i, key] of (input.unset ?? []).entries()) {
    if (!existing.has(key)) issues.push({ path: `/unset/${i}`, message: `${key} does not exist` })
  }
  if (issues.length) invalid(issues)

  const environmentId = scope.scope === 'project' ? scope.environmentId : null
  const parent = scope.scope === 'global' ? null : scope.parent
  for (const item of items) {
    levelFor(principal, scope, item.kind)
    const prior = existing.get(item.key)
    if (unchanged(db, keyring, prior, item, environmentId)) continue
    const reference = item.kind === 'reference' ? item.reference! : item.kind === 'literal' ? (item.reference ?? null) : null
    const plaintext = item.kind === 'reference' || reference !== null ? null : item.value!
    const after: Record<string, unknown> = {
      scope: scope.scope,
      key: item.key,
      kind: item.kind,
      reference,
      injection: item.injection ?? prior?.injection ?? 'env',
      build: item.build ?? prior?.build ?? false,
      value_length: plaintext === null ? null : Buffer.byteLength(plaintext, 'utf8'),
      version: plaintext === null && reference === null ? null : prior ? nextValueVersion(db, prior.id, environmentId) : 1,
      allow_unresolved: input.allow_unresolved ?? false,
      ...(environmentId ? { environment_id: environmentId } : {}),
      ...(plaintext === null ? {} : { value_id: set.secret(plaintext) })
    }
    if (prior) set.update('variable', prior.id, '', { key: prior.key, kind: prior.kind, reference: prior.reference }, after)
    else set.add('variable', parent, after)
  }
  const unset = new Set(input.unset ?? [])
  if (options.replaceAll) for (const key of existing.keys()) if (!items.some(item => item.key === key)) unset.add(key)
  for (const key of unset) {
    const prior = existing.get(key)!
    levelFor(principal, scope, prior.kind)
    const dependents = dependentsOf(db, prior)
    if (dependents.length) {
      fail('DELETE_HAS_DEPENDENTS', `${key} is referenced by ${dependents.map(d => d.key).join(', ')}.`, 'Remove or change the references first.', { dependents })
    }
    set.remove('variable', prior.id, { key: prior.key, kind: prior.kind })
  }
}
