import { and, asc, eq } from 'drizzle-orm'

import type { Db } from '../db/client.ts'
import {
  app,
  app_port,
  environment_variable,
  grant,
  machine,
  project,
  target,
} from '../db/schema.ts'

import { SecretsError } from './errors.ts'
import { parseValue, type Segment } from './reference.ts'
import { headValue, type SecretValueRow, type ValueTarget } from './values.ts'

export const maxHops = 8

export type ValueNode = {
  kind: 'value'
  from: string
  environment_variable_id: string
  key: string
  app_id: string | null
  target: ValueTarget
  secret_value_id: string
  version: number
  secret: boolean
  generated?: boolean
}

export type ExportNode = {
  kind: 'export'
  from: 'export'
  app_id: string
  key: string
  value: string
}

export type TemplateNode = {
  kind: 'template'
  environment_variable_id: string
  template: string
  parts: SourceNode[]
}

export type SourceNode = ValueNode | ExportNode | TemplateNode

type AppRow = typeof app.$inferSelect
type MachineRow = typeof machine.$inferSelect
type VariableRow = typeof environment_variable.$inferSelect
type ReferenceSegment = Extract<Segment, { type: 'reference' }>

export const isSecret = (node: SourceNode): boolean =>
  node.kind === 'value' ? node.secret : node.kind === 'template' ? node.parts.some(isSecret) : false

export const isRedacted = (leaf: ValueNode) => leaf.secret || leaf.generated === true

export const holdsRedacted = (node: SourceNode) =>
  leaves(node).some((leaf) => leaf.kind === 'value' && isRedacted(leaf))

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
  private readonly svc: AppRow | null
  private readonly box: MachineRow | null
  private readonly place: typeof target.$inferSelect
  private readonly projectId: string

  constructor(db: Db, owner: { app: AppRow } | { machine: MachineRow }) {
    this.db = db
    this.svc = 'app' in owner ? owner.app : null
    this.box = 'machine' in owner ? owner.machine : null
    const targetId = this.svc?.target_id ?? this.box!.target_id

    this.place = db.select().from(target).where(eq(target.id, targetId)).get()!
    this.projectId = this.place.project_id
  }

  static forApp(db: Db, appId: string) {
    const row = db.select().from(app).where(eq(app.id, appId)).get()

    if (!row) {
      throw new SecretsError('NOT_FOUND', `app ${appId} does not exist`)
    }

    return new Resolver(db, {
      app: row,
    })
  }

  static forMachine(db: Db, machineId: string) {
    const row = db.select().from(machine).where(eq(machine.id, machineId)).get()

    if (!row) {
      throw new SecretsError('NOT_FOUND', `machine ${machineId} does not exist`)
    }

    return new Resolver(db, {
      machine: row,
    })
  }

  appVariables() {
    return this.db
      .select()
      .from(environment_variable)
      .where(
        and(eq(environment_variable.scope, 'app'), eq(environment_variable.app_id, this.svc!.id)),
      )
      .orderBy(asc(environment_variable.name))
      .all()
  }

  machineVariables() {
    return this.db
      .select()
      .from(environment_variable)
      .where(
        and(
          eq(environment_variable.scope, 'machine'),
          eq(environment_variable.machine_id, this.box!.id),
        ),
      )
      .orderBy(asc(environment_variable.name))
      .all()
  }

  resolve(v: VariableRow): SourceNode {
    return this.resolveAppVariable(this.svc!, v, [])
  }

  resolveMachine(v: VariableRow): SourceNode {
    const box = this.box!

    if (v.kind === 'reference' && v.reference !== null) {
      const chain = [`${box.name}.${v.name}`]
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
              'ENVIRONMENT_VARIABLE_REFERENCE_INVALID',
              'a machine environment variable references project or global environment variables only',
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
        environment_variable_id: v.id,
        template: v.reference,
        parts,
      }
    }

    const row = headValue(this.db, v.id, 'production')

    if (!row) {
      throw new SecretsError(
        'ENVIRONMENT_VARIABLE_UNRESOLVED',
        `${box.name}.${v.name} has no value`,
        {
          environment_variable: v.name,
          machine_id: box.id,
        },
      )
    }

    return this.valueNode(v, row, 'machine', null)
  }

  private get where() {
    return this.place.kind === 'production' ? 'production' : `preview ${this.place.name}`
  }

  private missing(label: string, v: VariableRow, details: Record<string, unknown>) {
    return new SecretsError(
      'ENVIRONMENT_VARIABLE_UNRESOLVED',
      `${label} has no value in ${this.where}`,
      {
        environment_variable: v.name,
        preview: this.place.kind === 'preview' ? this.place.name : null,
        ...details,
      },
      this.place.kind === 'preview' && v.kind === 'secret'
        ? `Set a preview value for ${v.name}; previews never read production's secret values.`
        : `Set a value for ${v.name}.`,
    )
  }

  private headFor(v: VariableRow) {
    if (this.place.kind === 'production') {
      return headValue(this.db, v.id, 'production')
    }

    const preview = headValue(this.db, v.id, 'preview')

    if (preview || (v.kind === 'secret' && v.scope !== 'app')) {
      return preview
    }

    return headValue(this.db, v.id, 'production')
  }

  private label(v: VariableRow, owner: AppRow) {
    return `${owner.name}.${v.name}`
  }

  private valueNode(
    v: VariableRow,
    row: SecretValueRow,
    from: string,
    appId: string | null,
  ): ValueNode {
    return {
      kind: 'value',
      from,
      environment_variable_id: v.id,
      key: v.name,
      app_id: appId,
      target: row.target,
      secret_value_id: row.id,
      version: row.version,
      secret: v.kind === 'secret',
      generated: v.kind === 'literal' && v.reference !== null,
    }
  }

  private resolveAppVariable(owner: AppRow, v: VariableRow, chain: string[]): SourceNode {
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
        environment_variable_id: v.id,
        template: v.reference,
        parts,
      }
    }

    const row = this.headFor(v)

    if (!row) {
      throw this.missing(this.label(v, owner), v, {
        app_id: owner.id,
      })
    }

    return this.valueNode(v, row, 'app', owner.id)
  }

  private resolveTarget(
    owner: AppRow,
    segment: ReferenceSegment,
    chain: string[],
    fromVariable: string,
  ): SourceNode {
    const ref = segment.target

    if (chain.length > maxHops) {
      throw new SecretsError(
        'ENVIRONMENT_VARIABLE_REFERENCE_INVALID',
        `reference chain ${chain.join(' -> ')} is longer than ${maxHops} hops`,
        {
          hops: chain.length,
        },
      )
    }

    switch (ref.type) {
      case 'app': {
        const svc = this.db
          .select()
          .from(app)
          .where(and(eq(app.target_id, owner.target_id), eq(app.name, ref.app)))
          .get()

        if (!svc) {
          throw new SecretsError(
            'ENVIRONMENT_VARIABLE_TARGET_MISSING',
            `app ${ref.app} does not exist in ${this.where}`,
            {},
          )
        }

        const v = this.db
          .select()
          .from(environment_variable)
          .where(
            and(
              eq(environment_variable.scope, 'app'),
              eq(environment_variable.app_id, svc.id),
              eq(environment_variable.name, ref.key),
            ),
          )
          .get()

        if (v) {
          if (v.id === fromVariable || chain.includes(this.label(v, svc))) {
            throw new SecretsError(
              'ENVIRONMENT_VARIABLE_CYCLE',
              `reference chain returns to itself: ${[...chain, this.label(v, svc)].join(' -> ')}`,
              {
                cycle: [...chain, this.label(v, svc)],
              },
            )
          }

          return this.resolveAppVariable(svc, v, chain)
        }

        const value = this.exportOf(svc, ref.key)

        if (value === undefined) {
          throw new SecretsError(
            'ENVIRONMENT_VARIABLE_UNRESOLVED',
            `app ${svc.name} has no environment variable or export ${ref.key}`,
            {},
          )
        }

        return {
          kind: 'export',
          from: 'export',
          app_id: svc.id,
          key: ref.key,
          value,
        }
      }

      case 'project':
        return this.resolveProject(ref.key)
      case 'global':
        return this.resolveGlobal(ref.key)
      case 'shared':
        throw new SecretsError(
          'ENVIRONMENT_VARIABLE_TARGET_MISSING',
          `attachment ${ref.alias} does not exist in ${this.where}; attachments arrive in phase 1b`,
          {},
        )
      case 'generator':
        throw new SecretsError(
          'ENVIRONMENT_VARIABLE_REFERENCE_INVALID',
          'secret(N) must be the entire value',
          {},
        )
    }
  }

  private exportOf(svc: AppRow, key: string) {
    const host = `${svc.name}.internal`
    const port = this.db
      .select()
      .from(app_port)
      .where(eq(app_port.app_id, svc.id))
      .orderBy(asc(app_port.created_at), asc(app_port.port))
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

  private resolveProject(name: string): ValueNode {
    const v = this.db
      .select()
      .from(environment_variable)
      .where(
        and(
          eq(environment_variable.scope, 'project'),
          eq(environment_variable.project_id, this.projectId),
          eq(environment_variable.name, name),
        ),
      )
      .get()

    if (!v) {
      throw new SecretsError(
        'ENVIRONMENT_VARIABLE_UNRESOLVED',
        `project environment variable ${name} does not exist`,
        {},
      )
    }

    const row = this.headFor(v)

    if (!row) {
      throw this.missing(`project environment variable ${name}`, v, {})
    }

    return this.valueNode(v, row, `project:${row.target}`, null)
  }

  private resolveGlobal(name: string): ValueNode {
    const granted = this.db
      .select({
        v: environment_variable,
        alias: grant.alias,
      })
      .from(grant)
      .innerJoin(environment_variable, eq(environment_variable.id, grant.environment_variable_id))
      .where(and(eq(grant.project_id, this.projectId), eq(environment_variable.scope, 'global')))
      .all()
      .find((g) => (g.alias ?? g.v.name) === name)

    if (!granted) {
      const exists = this.db
        .select({
          id: environment_variable.id,
        })
        .from(environment_variable)
        .where(and(eq(environment_variable.scope, 'global'), eq(environment_variable.name, name)))
        .get()

      if (exists) {
        throw new SecretsError(
          'ENVIRONMENT_VARIABLE_NOT_GRANTED',
          `global environment variable ${name} exists but project ${this.projectId} holds no grant for it`,
          {},
        )
      }

      throw new SecretsError(
        'ENVIRONMENT_VARIABLE_UNRESOLVED',
        `global environment variable ${name} does not exist`,
        {},
      )
    }

    const row = headValue(this.db, granted.v.id, 'production')

    if (!row) {
      throw new SecretsError(
        'ENVIRONMENT_VARIABLE_UNRESOLVED',
        `global environment variable ${name} has no value`,
        {},
      )
    }

    return this.valueNode(granted.v, row, 'global', null)
  }
}

export const projectOf = (db: Db, appId: string) =>
  db
    .select({
      project: project,
      target: target,
      app: app,
    })
    .from(app)
    .innerJoin(target, eq(target.id, app.target_id))
    .innerJoin(project, eq(project.id, target.project_id))
    .where(eq(app.id, appId))
    .get()
