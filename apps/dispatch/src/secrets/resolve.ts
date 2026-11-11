import { and, asc, eq } from 'drizzle-orm'

import type { Db } from '../db/client.ts'
import {
  environment,
  grant,
  project,
  sandbox,
  service,
  service_port,
  variable,
} from '../db/schema.ts'

import { SecretsError } from './errors.ts'
import { parseValue, type Segment } from './reference.ts'
import { headValue, type SecretValueRow } from './values.ts'

export const maxHops = 8

export type ValueNode = {
  kind: 'value'
  from: string
  variable_id: string
  key: string
  service_id: string | null
  environment_id: string | null
  secret_value_id: string
  version: number
  sealed: boolean
  generated?: boolean
  fallback_from_protected: boolean
}

export type ExportNode = {
  kind: 'export'
  from: 'export'
  service_id: string
  key: string
  value: string
}

export type TemplateNode = {
  kind: 'template'
  variable_id: string
  template: string
  parts: SourceNode[]
}

export type SourceNode = ValueNode | ExportNode | TemplateNode

type ServiceRow = typeof service.$inferSelect
type SandboxRow = typeof sandbox.$inferSelect
type VariableRow = typeof variable.$inferSelect
type ReferenceSegment = Extract<Segment, { type: 'reference' }>

export const isSealed = (node: SourceNode): boolean =>
  node.kind === 'value' ? node.sealed : node.kind === 'template' ? node.parts.some(isSealed) : false

export const isRedacted = (leaf: ValueNode) => leaf.sealed || leaf.generated === true

export const holdsRedacted = (node: SourceNode) =>
  leaves(node).some((leaf) => leaf.kind === 'value' && isRedacted(leaf))

export const isFallback = (node: SourceNode): boolean =>
  node.kind === 'value'
    ? node.fallback_from_protected
    : node.kind === 'template'
      ? node.parts.some(isFallback)
      : false

export const leaves = (node: SourceNode): (ValueNode | ExportNode)[] =>
  node.kind === 'template' ? node.parts.flatMap(leaves) : [node]

export const render = (node: SourceNode, plaintext: (node: ValueNode) => string): string => {
  if (node.kind === 'value') {
    return plaintext(node)
  }

  if (node.kind === 'export') {
    return node.value
  }

  const parts = [...node.parts]

  return parseValue(node.template)
    .map((segment) => (segment.type === 'text' ? segment.text : render(parts.shift()!, plaintext)))
    .join('')
}

const withReference = (error: unknown, segment: ReferenceSegment, chain: string[]) => {
  if (error instanceof SecretsError) {
    Object.assign(error.details, {
      reference: segment.raw,
      offset: segment.offset,
      target: segment.target,
      chain: error.details.chain ?? chain,
    })
  }

  return error
}

export class Resolver {
  private readonly db: Db
  private readonly svc: ServiceRow | null
  private readonly box: SandboxRow | null
  private readonly env: typeof environment.$inferSelect
  private readonly projectId: string

  constructor(db: Db, owner: { service: ServiceRow } | { sandbox: SandboxRow }) {
    this.db = db
    this.svc = 'service' in owner ? owner.service : null
    this.box = 'sandbox' in owner ? owner.sandbox : null
    const environmentId = this.svc?.environment_id ?? this.box!.environment_id

    this.env = db.select().from(environment).where(eq(environment.id, environmentId)).get()!
    this.projectId = this.env.project_id
  }

  static forService(db: Db, serviceId: string) {
    const row = db.select().from(service).where(eq(service.id, serviceId)).get()

    if (!row) {
      throw new SecretsError('NOT_FOUND', `service ${serviceId} does not exist`)
    }

    return new Resolver(db, {
      service: row,
    })
  }

  static forSandbox(db: Db, sandboxId: string) {
    const row = db.select().from(sandbox).where(eq(sandbox.id, sandboxId)).get()

    if (!row) {
      throw new SecretsError('NOT_FOUND', `sandbox ${sandboxId} does not exist`)
    }

    return new Resolver(db, {
      sandbox: row,
    })
  }

  serviceVariables() {
    return this.db
      .select()
      .from(variable)
      .where(and(eq(variable.scope, 'service'), eq(variable.service_id, this.svc!.id)))
      .orderBy(asc(variable.key))
      .all()
  }

  sandboxVariables() {
    return this.db
      .select()
      .from(variable)
      .where(and(eq(variable.scope, 'sandbox'), eq(variable.sandbox_id, this.box!.id)))
      .orderBy(asc(variable.key))
      .all()
  }

  resolve(v: VariableRow): SourceNode {
    return this.resolveServiceVariable(this.svc!, v, [])
  }

  resolveSandbox(v: VariableRow): SourceNode {
    const box = this.box!

    if (v.kind === 'reference' && v.reference !== null) {
      const chain = [`${box.name}.${v.key}`]
      const parts = parseValue(v.reference)
        .filter((s): s is ReferenceSegment => s.type === 'reference')
        .map((segment) => {
          try {
            if (segment.target.type === 'project') {
              return this.resolveProject(segment.target.key)
            }

            if (segment.target.type === 'global') {
              return this.resolveGlobal(segment.target.key)
            }

            throw new SecretsError(
              'VARIABLE_REFERENCE_INVALID',
              'a sandbox variable references project or global variables only',
              {
                offset: segment.offset,
              },
            )
          } catch (error) {
            throw withReference(error, segment, chain)
          }
        })

      return {
        kind: 'template',
        variable_id: v.id,
        template: v.reference,
        parts,
      }
    }

    const row = headValue(this.db, v.id, null)

    if (!row) {
      throw new SecretsError('VARIABLE_UNRESOLVED', `${box.name}.${v.key} has no value`, {
        key: v.key,
        sandbox_id: box.id,
      })
    }

    return this.valueNode(v, row, 'sandbox', null)
  }

  private label(v: VariableRow, owner: ServiceRow) {
    return `${owner.name}.${v.key}`
  }

  private valueNode(
    v: VariableRow,
    row: SecretValueRow,
    from: string,
    serviceId: string | null,
    fallback = false,
  ): ValueNode {
    return {
      kind: 'value',
      from,
      variable_id: v.id,
      key: v.key,
      service_id: serviceId,
      environment_id: row.environment_id,
      secret_value_id: row.id,
      version: row.version,
      sealed: v.kind === 'sealed',
      generated: v.kind === 'literal' && v.reference !== null,
      fallback_from_protected: fallback,
    }
  }

  private resolveServiceVariable(owner: ServiceRow, v: VariableRow, chain: string[]): SourceNode {
    const here = [...chain, this.label(v, owner)]

    if (v.kind === 'reference' && v.reference !== null) {
      const segments = parseValue(v.reference)
      const parts = segments
        .filter((s): s is ReferenceSegment => s.type === 'reference')
        .map((segment) => {
          try {
            return this.resolveTarget(owner, segment, here, v.id)
          } catch (error) {
            throw withReference(error, segment, here)
          }
        })

      return {
        kind: 'template',
        variable_id: v.id,
        template: v.reference,
        parts,
      }
    }

    const row = headValue(this.db, v.id, null)

    if (!row) {
      throw new SecretsError('VARIABLE_UNRESOLVED', `${this.label(v, owner)} has no value`, {
        key: v.key,
        service_id: owner.id,
      })
    }

    return this.valueNode(v, row, 'service', owner.id)
  }

  private resolveTarget(
    owner: ServiceRow,
    segment: ReferenceSegment,
    chain: string[],
    fromVariable: string,
  ): SourceNode {
    const target = segment.target

    if (chain.length > maxHops) {
      throw new SecretsError(
        'VARIABLE_REFERENCE_INVALID',
        `reference chain ${chain.join(' -> ')} is longer than ${maxHops} hops`,
        {
          hops: chain.length,
        },
      )
    }

    switch (target.type) {
      case 'service': {
        const svc = this.db
          .select()
          .from(service)
          .where(
            and(eq(service.environment_id, owner.environment_id), eq(service.name, target.service)),
          )
          .get()

        if (!svc) {
          throw new SecretsError(
            'VARIABLE_TARGET_MISSING',
            `service ${target.service} does not exist in environment ${this.env.name}`,
            {},
          )
        }

        const v = this.db
          .select()
          .from(variable)
          .where(
            and(
              eq(variable.scope, 'service'),
              eq(variable.service_id, svc.id),
              eq(variable.key, target.key),
            ),
          )
          .get()

        if (v) {
          if (v.id === fromVariable || chain.includes(this.label(v, svc))) {
            throw new SecretsError(
              'VARIABLE_CYCLE',
              `reference chain returns to itself: ${[...chain, this.label(v, svc)].join(' -> ')}`,
              {
                cycle: [...chain, this.label(v, svc)],
              },
            )
          }

          return this.resolveServiceVariable(svc, v, chain)
        }

        const value = this.exportOf(svc, target.key)

        if (value === undefined) {
          throw new SecretsError(
            'VARIABLE_UNRESOLVED',
            `service ${svc.name} has no variable or export ${target.key}`,
            {},
          )
        }

        return {
          kind: 'export',
          from: 'export',
          service_id: svc.id,
          key: target.key,
          value,
        }
      }

      case 'project':
        return this.resolveProject(target.key)
      case 'global':
        return this.resolveGlobal(target.key)
      case 'shared':
        throw new SecretsError(
          'VARIABLE_TARGET_MISSING',
          `attachment ${target.alias} does not exist in environment ${this.env.name}; attachments arrive in phase 1b`,
          {},
        )
      case 'generator':
        throw new SecretsError(
          'VARIABLE_REFERENCE_INVALID',
          'secret(N) must be the entire value',
          {},
        )
    }
  }

  private exportOf(svc: ServiceRow, key: string) {
    const host = `${svc.name}.internal`
    const port = this.db
      .select()
      .from(service_port)
      .where(eq(service_port.service_id, svc.id))
      .orderBy(asc(service_port.created_at), asc(service_port.port))
      .get()

    if (key === 'HOST') {
      return host
    }

    if (key === 'PORT' && port) {
      return String(port.port)
    }

    if (key === 'URL' && port && svc.kind === 'web') {
      return `http://${host}:${port.port}`
    }

    return undefined
  }

  private resolveProject(key: string): ValueNode {
    const v = this.db
      .select()
      .from(variable)
      .where(
        and(
          eq(variable.scope, 'project'),
          eq(variable.project_id, this.projectId),
          eq(variable.key, key),
        ),
      )
      .get()

    if (!v) {
      throw new SecretsError('VARIABLE_UNRESOLVED', `project variable ${key} does not exist`, {})
    }

    const own = headValue(this.db, v.id, this.env.id)

    if (own) {
      return this.valueNode(v, own, `project:${this.env.name}`, null)
    }

    const protectedValues = this.env.protected
      ? []
      : this.db
          .select({
            id: environment.id,
          })
          .from(environment)
          .where(and(eq(environment.project_id, this.projectId), eq(environment.protected, true)))
          .all()
          .filter((e) => headValue(this.db, v.id, e.id) !== undefined)
    const fallback = headValue(this.db, v.id, null)

    if (fallback) {
      return this.valueNode(v, fallback, 'project:default', null, protectedValues.length > 0)
    }

    if (protectedValues.length > 0) {
      throw new SecretsError(
        'VARIABLE_PROTECTED_SOURCE',
        `project variable ${key} has values only in protected environments and no default`,
        {
          protected_environments: protectedValues.map((e) => e.id),
        },
      )
    }

    throw new SecretsError(
      'VARIABLE_UNRESOLVED',
      `project variable ${key} has no value for environment ${this.env.name} and no default`,
      {},
    )
  }

  private resolveGlobal(key: string): ValueNode {
    const granted = this.db
      .select({
        v: variable,
        alias: grant.alias,
      })
      .from(grant)
      .innerJoin(variable, eq(variable.id, grant.variable_id))
      .where(and(eq(grant.project_id, this.projectId), eq(variable.scope, 'global')))
      .all()
      .find((g) => (g.alias ?? g.v.key) === key)

    if (!granted) {
      const exists = this.db
        .select({
          id: variable.id,
        })
        .from(variable)
        .where(and(eq(variable.scope, 'global'), eq(variable.key, key)))
        .get()

      if (exists) {
        throw new SecretsError(
          'VARIABLE_NOT_GRANTED',
          `global variable ${key} exists but project ${this.projectId} holds no grant for it`,
          {},
        )
      }

      throw new SecretsError('VARIABLE_UNRESOLVED', `global variable ${key} does not exist`, {})
    }

    const row = headValue(this.db, granted.v.id, null)

    if (!row) {
      throw new SecretsError('VARIABLE_UNRESOLVED', `global variable ${key} has no value`, {})
    }

    return this.valueNode(granted.v, row, 'global', null)
  }
}

export const projectOf = (db: Db, serviceId: string) =>
  db
    .select({
      project: project,
      environment: environment,
      service: service,
    })
    .from(service)
    .innerJoin(environment, eq(environment.id, service.environment_id))
    .innerJoin(project, eq(project.id, environment.project_id))
    .where(eq(service.id, serviceId))
    .get()
