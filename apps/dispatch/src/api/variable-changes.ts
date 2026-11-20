import { and, eq, inArray } from 'drizzle-orm'

import type { Principal } from '../auth/principal.ts'
import type { Target } from '../auth/scopes.ts'
import type { Db } from '../db/client.ts'
import { app, environment_variable, target } from '../db/schema.ts'
import type { Keyring } from '../secrets/keyring.ts'
import { hasReference, parseValue } from '../secrets/reference.ts'
import {
  decryptValue,
  headValue,
  nextValueVersion,
  variablesOf,
  type ValueTarget,
} from '../secrets/values.ts'

import { requireInstance, requireLevel } from './access.ts'
import type { ChangeSet } from './changes.ts'
import { fail, invalid } from './errors.ts'
import type { VariableRow } from './lookup.ts'

export type VariableItem = {
  name: string
  kind: 'literal' | 'reference' | 'secret'
  value?: string
  reference?: string
  injection?: 'env' | 'file'
  build?: boolean
}

export type VariableScope =
  | { scope: 'app'; parent: string; appId: string | null; valueTarget: ValueTarget; target: Target }
  | { scope: 'project'; parent: string; valueTarget: ValueTarget; target: Target }
  | { scope: 'machine'; parent: string; machineId: string; target: Target }
  | { scope: 'global'; target: Target }

export const existingVariables = (db: Db, scope: VariableScope): VariableRow[] => {
  if (scope.scope === 'app') {
    if (!scope.appId) {
      return []
    }

    return variablesOf(db, {
      scope: 'app',
      id: scope.appId,
    }).all()
  }

  if (scope.scope === 'machine') {
    return variablesOf(db, {
      scope: 'machine',
      id: scope.machineId,
    }).all()
  }

  if (scope.scope === 'project') {
    return variablesOf(db, {
      scope: 'project',
      id: scope.parent,
    }).all()
  }

  return variablesOf(db, {
    scope: 'global',
  }).all()
}

export const dependentsOf = (db: Db, row: VariableRow) => {
  const candidates = db
    .select()
    .from(environment_variable)
    .where(and(eq(environment_variable.scope, 'app'), eq(environment_variable.kind, 'reference')))
    .all()
  const owner =
    row.scope === 'app' ? db.select().from(app).where(eq(app.id, row.app_id!)).get() : undefined
  const projectTargets =
    row.scope === 'project'
      ? db
          .select({
            id: target.id,
          })
          .from(target)
          .where(eq(target.project_id, row.project_id!))
          .all()
          .map((e) => e.id)
      : []
  const projectApps = projectTargets.length
    ? new Set(
        db
          .select({
            id: app.id,
          })
          .from(app)
          .where(inArray(app.target_id, projectTargets))
          .all()
          .map((s) => s.id),
      )
    : new Set<string>()
  const out: { entity: 'environment_variable'; id: string; name: string; app_id: string }[] = []

  for (const candidate of candidates) {
    if (candidate.id === row.id || !candidate.reference) {
      continue
    }

    let segments: ReturnType<typeof parseValue>

    try {
      segments = parseValue(candidate.reference)
    } catch {
      continue
    }

    const hit = segments.some((segment) => {
      if (segment.type !== 'reference') {
        return false
      }

      const ref = segment.target

      if (row.scope === 'app' && ref.type === 'app' && owner) {
        if (ref.app !== owner.name || ref.key !== row.name) {
          return false
        }

        const candidateOwner = db
          .select({
            target_id: app.target_id,
          })
          .from(app)
          .where(eq(app.id, candidate.app_id!))
          .get()

        return candidateOwner?.target_id === owner.target_id
      }

      if (row.scope === 'project' && ref.type === 'project') {
        return ref.key === row.name && projectApps.has(candidate.app_id!)
      }

      if (row.scope === 'global' && ref.type === 'global') {
        return ref.key === row.name
      }

      return false
    })

    if (hit) {
      out.push({
        entity: 'environment_variable',
        id: candidate.id,
        name: candidate.name,
        app_id: candidate.app_id!,
      })
    }
  }

  return out
}

const levelFor = (principal: Principal, scope: VariableScope, kind: string) => {
  if (scope.scope === 'global') {
    return requireInstance(principal, 'admin')
  }

  if (scope.scope === 'project') {
    return requireLevel(principal, scope.target, 'admin')
  }

  return requireLevel(principal, scope.target, kind === 'secret' ? 'admin' : 'deploy')
}

const unchanged = (
  db: Db,
  keyring: Keyring,
  prior: VariableRow | undefined,
  item: VariableItem,
  valueTarget: ValueTarget,
) => {
  if (!prior || prior.kind !== item.kind) {
    return false
  }

  if (
    (item.injection ?? prior.injection) !== prior.injection ||
    (item.build ?? prior.build) !== prior.build
  ) {
    return false
  }

  if (item.kind === 'reference') {
    return item.reference === prior.reference
  }

  if (
    item.kind !== 'literal' ||
    item.reference !== undefined ||
    prior.reference !== null ||
    item.value === undefined
  ) {
    return false
  }

  const head = headValue(db, prior.id, valueTarget, 'unset')

  return head !== undefined && decryptValue(keyring, head) === item.value
}

export const planVariables = (
  db: Db,
  keyring: Keyring,
  principal: Principal,
  set: ChangeSet,
  scope: VariableScope,
  input: { set?: VariableItem[]; unset?: string[]; allow_unresolved?: boolean },
  options: { replaceAll?: boolean } = {},
) => {
  const existing = new Map(existingVariables(db, scope).map((v) => [v.name, v]))
  const issues: { path: string; message: string }[] = []
  const items = input.set ?? []

  items.forEach((item, i) => {
    const path = `/set/${i}`

    if (item.kind === 'reference') {
      if (scope.scope !== 'app' && scope.scope !== 'machine') {
        issues.push({
          path: `${path}/kind`,
          message: `${scope.scope} environment variables hold values, not references`,
        })
      }

      if (item.reference === undefined) {
        issues.push({
          path: `${path}/reference`,
          message: 'required for kind reference',
        })
      } else if (!hasReference(parseValue(item.reference))) {
        issues.push({
          path: `${path}/reference`,
          message: 'contains no ${{...}} reference',
        })
      } else if (
        scope.scope === 'machine' &&
        parseValue(item.reference).some(
          (segment) =>
            segment.type === 'reference' &&
            segment.target.type !== 'project' &&
            segment.target.type !== 'global',
        )
      ) {
        issues.push({
          path: `${path}/reference`,
          message:
            'a machine environment variable references ${{project.KEY}}, ${{global.KEY}} or ${{secret(N)}} only, never an app',
        })
      }
    } else if (
      item.value === undefined &&
      !(item.kind === 'literal' && item.reference !== undefined) &&
      !(item.kind === 'secret' && existing.get(item.name)?.kind === 'secret')
    ) {
      issues.push({
        path: `${path}/value`,
        message: `required for kind ${item.kind}`,
      })
    }

    if (
      item.kind === 'literal' &&
      item.value !== undefined &&
      hasReference(parseValue(item.value))
    ) {
      issues.push({
        path: `${path}/value`,
        message: 'a literal holds no reference; use kind reference, or escape as $${{',
      })
    }

    if (item.kind === 'literal' && item.reference !== undefined) {
      const segments = parseValue(item.reference)

      if (!(
        segments.length === 1 &&
        segments[0]!.type === 'reference' &&
        segments[0]!.target.type === 'generator'
      )) {
        issues.push({
          path: `${path}/reference`,
          message: 'a literal reference must be exactly ${{secret(N)}}',
        })
      }
    }

    const prior = existing.get(item.name)

    if (prior?.kind === 'secret' && item.kind !== 'secret') {
      issues.push({
        path: `${path}/kind`,
        message: `${item.name} is secret; converting a secret environment variable is not possible`,
      })
    }

    if (items.findIndex((other) => other.name === item.name) !== i) {
      issues.push({
        path: `${path}/name`,
        message: 'name appears twice',
      })
    }
  })

  for (const [i, name] of (input.unset ?? []).entries()) {
    if (!existing.has(name)) {
      issues.push({
        path: `/unset/${i}`,
        message: `${name} does not exist`,
      })
    }
  }

  if (issues.length) {
    invalid(issues)
  }

  const valueTarget =
    scope.scope === 'project' || scope.scope === 'app' ? scope.valueTarget : 'production'
  const parent = scope.scope === 'global' ? null : scope.parent

  for (const item of items) {
    levelFor(principal, scope, item.kind)
    const prior = existing.get(item.name)

    if (unchanged(db, keyring, prior, item, valueTarget)) {
      continue
    }

    const reference =
      item.kind === 'reference'
        ? item.reference!
        : item.kind === 'literal'
          ? (item.reference ?? null)
          : null
    const plaintext = item.kind === 'reference' || reference !== null ? null : (item.value ?? null)
    const after: Record<string, unknown> = {
      scope: scope.scope,
      name: item.name,
      kind: item.kind,
      reference,
      injection: item.injection ?? prior?.injection ?? 'env',
      build: item.build ?? prior?.build ?? false,
      value_length: plaintext === null ? null : Buffer.byteLength(plaintext, 'utf8'),
      version:
        plaintext === null && reference === null
          ? null
          : prior
            ? nextValueVersion(db, prior.id, valueTarget)
            : 1,
      allow_unresolved: input.allow_unresolved ?? false,
      target: valueTarget,
      ...(plaintext === null
        ? {}
        : {
            value_id: set.secret(plaintext),
          }),
    }

    if (prior) {
      set.update(
        'environment_variable',
        prior.id,
        '',
        {
          name: prior.name,
          kind: prior.kind,
          reference: prior.reference,
        },
        after,
      )
    } else {
      set.add('environment_variable', parent, after)
    }
  }

  const unset = new Set(input.unset ?? [])

  if (options.replaceAll) {
    for (const name of existing.keys()) {
      if (!items.some((item) => item.name === name)) {
        unset.add(name)
      }
    }
  }

  for (const name of unset) {
    const prior = existing.get(name)!

    levelFor(principal, scope, prior.kind)
    const dependents = dependentsOf(db, prior)

    if (dependents.length) {
      fail(
        'DELETE_HAS_DEPENDENTS',
        `${name} is referenced by ${dependents.map((d) => d.name).join(', ')}.`,
        'Remove or change the references first.',
        {
          dependents,
        },
      )
    }

    set.remove('environment_variable', prior.id, {
      name: prior.name,
      kind: prior.kind,
    })
  }
}
