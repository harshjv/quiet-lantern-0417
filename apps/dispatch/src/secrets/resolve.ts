import { and, asc, eq } from 'drizzle-orm'

import type { Db } from '../db/client.ts'
import { app, app_port, grant, key, machine, project, target } from '../db/schema.ts'

import { SecretsError } from './errors.ts'
import { parseValue, type Segment } from './reference.ts'
import { headValue, type SecretValueRow, type ValueTarget } from './values.ts'

export const maxHops = 8

export type ValueNode = {
  kind: 'value'
  from: string
  key_id: string
  key: string
  app_id: string | null
  target: ValueTarget
  secret_value_id: string
  version: number
  sealed: boolean
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
  key_id: string
  template: string
  parts: SourceNode[]
}

export type SourceNode = ValueNode | ExportNode | TemplateNode

type AppRow = typeof app.$inferSelect
type MachineRow = typeof machine.$inferSelect
type KeyRow = typeof key.$inferSelect
type ReferenceSegment = Extract<Segment, { type: 'reference' }>

export const isSealed = (node: SourceNode): boolean =>
  node.kind === 'value' ? node.sealed : node.kind === 'template' ? node.parts.some(isSealed) : false

export const isRedacted = (leaf: ValueNode) => leaf.sealed || leaf.generated === true

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

  appKeys() {
    return this.db
      .select()
      .from(key)
      .where(and(eq(key.scope, 'app'), eq(key.app_id, this.svc!.id)))
      .orderBy(asc(key.name))
      .all()
  }

  machineKeys() {
    return this.db
      .select()
      .from(key)
      .where(and(eq(key.scope, 'machine'), eq(key.machine_id, this.box!.id)))
      .orderBy(asc(key.name))
      .all()
  }

  resolve(v: KeyRow): SourceNode {
    return this.resolveAppKey(this.svc!, v, [])
  }

  resolveMachine(v: KeyRow): SourceNode {
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
              'KEY_REFERENCE_INVALID',
              'a machine key references project or global keys only',
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
        key_id: v.id,
        template: v.reference,
        parts,
      }
    }

    const row = headValue(this.db, v.id, 'production')

    if (!row) {
      throw new SecretsError('KEY_UNRESOLVED', `${box.name}.${v.name} has no value`, {
        key: v.name,
        machine_id: box.id,
      })
    }

    return this.valueNode(v, row, 'machine', null)
  }

  private get where() {
    return this.place.kind === 'production' ? 'production' : `preview ${this.place.name}`
  }

  private missing(label: string, v: KeyRow, details: Record<string, unknown>) {
    return new SecretsError(
      'KEY_UNRESOLVED',
      `${label} has no value in ${this.where}`,
      {
        key: v.name,
        preview: this.place.kind === 'preview' ? this.place.name : null,
        ...details,
      },
      this.place.kind === 'preview' && v.kind === 'sealed'
        ? `Set a preview value for ${v.name}; previews never read production's sealed values.`
        : `Set a value for ${v.name}.`,
    )
  }

  private headFor(v: KeyRow) {
    if (this.place.kind === 'production') {
      return headValue(this.db, v.id, 'production')
    }

    const preview = headValue(this.db, v.id, 'preview')

    if (preview || (v.kind === 'sealed' && v.scope !== 'app')) {
      return preview
    }

    return headValue(this.db, v.id, 'production')
  }

  private label(v: KeyRow, owner: AppRow) {
    return `${owner.name}.${v.name}`
  }

  private valueNode(v: KeyRow, row: SecretValueRow, from: string, appId: string | null): ValueNode {
    return {
      kind: 'value',
      from,
      key_id: v.id,
      key: v.name,
      app_id: appId,
      target: row.target,
      secret_value_id: row.id,
      version: row.version,
      sealed: v.kind === 'sealed',
      generated: v.kind === 'literal' && v.reference !== null,
    }
  }

  private resolveAppKey(owner: AppRow, v: KeyRow, chain: string[]): SourceNode {
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
        key_id: v.id,
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
    fromKey: string,
  ): SourceNode {
    const ref = segment.target

    if (chain.length > maxHops) {
      throw new SecretsError(
        'KEY_REFERENCE_INVALID',
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
            'KEY_TARGET_MISSING',
            `app ${ref.app} does not exist in ${this.where}`,
            {},
          )
        }

        const v = this.db
          .select()
          .from(key)
          .where(and(eq(key.scope, 'app'), eq(key.app_id, svc.id), eq(key.name, ref.key)))
          .get()

        if (v) {
          if (v.id === fromKey || chain.includes(this.label(v, svc))) {
            throw new SecretsError(
              'KEY_CYCLE',
              `reference chain returns to itself: ${[...chain, this.label(v, svc)].join(' -> ')}`,
              {
                cycle: [...chain, this.label(v, svc)],
              },
            )
          }

          return this.resolveAppKey(svc, v, chain)
        }

        const value = this.exportOf(svc, ref.key)

        if (value === undefined) {
          throw new SecretsError(
            'KEY_UNRESOLVED',
            `app ${svc.name} has no key or export ${ref.key}`,
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
          'KEY_TARGET_MISSING',
          `attachment ${ref.alias} does not exist in ${this.where}; attachments arrive in phase 1b`,
          {},
        )
      case 'generator':
        throw new SecretsError('KEY_REFERENCE_INVALID', 'secret(N) must be the entire value', {})
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
      .from(key)
      .where(and(eq(key.scope, 'project'), eq(key.project_id, this.projectId), eq(key.name, name)))
      .get()

    if (!v) {
      throw new SecretsError('KEY_UNRESOLVED', `project key ${name} does not exist`, {})
    }

    const row = this.headFor(v)

    if (!row) {
      throw this.missing(`project key ${name}`, v, {})
    }

    return this.valueNode(v, row, `project:${row.target}`, null)
  }

  private resolveGlobal(name: string): ValueNode {
    const granted = this.db
      .select({
        v: key,
        alias: grant.alias,
      })
      .from(grant)
      .innerJoin(key, eq(key.id, grant.key_id))
      .where(and(eq(grant.project_id, this.projectId), eq(key.scope, 'global')))
      .all()
      .find((g) => (g.alias ?? g.v.name) === name)

    if (!granted) {
      const exists = this.db
        .select({
          id: key.id,
        })
        .from(key)
        .where(and(eq(key.scope, 'global'), eq(key.name, name)))
        .get()

      if (exists) {
        throw new SecretsError(
          'KEY_NOT_GRANTED',
          `global key ${name} exists but project ${this.projectId} holds no grant for it`,
          {},
        )
      }

      throw new SecretsError('KEY_UNRESOLVED', `global key ${name} does not exist`, {})
    }

    const row = headValue(this.db, granted.v.id, 'production')

    if (!row) {
      throw new SecretsError('KEY_UNRESOLVED', `global key ${name} has no value`, {})
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
