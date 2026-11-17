import { Type } from '@sinclair/typebox'
import { eq } from 'drizzle-orm'

import { injectionValues, Nullable, StringEnum, targetKindValues } from '@stationly/protocol'

import { deployment, key } from '../db/schema.ts'
import type { EnvSnapshot } from '../secrets/deploy.ts'
import { SecretsError } from '../secrets/errors.ts'
import { parseValue } from '../secrets/reference.ts'
import {
  isSealed,
  leaves,
  render,
  Resolver,
  type SourceNode,
  type ValueNode,
} from '../secrets/resolve.ts'
import { decryptLeaf, storedBytes } from '../secrets/variables.ts'

import { audit, type Call } from './context.ts'
import { fail } from './errors.ts'
import type { Kit } from './kit.ts'
import { previewIdOf, type AppContext, type MachineContext } from './lookup.ts'
import { definitionOf, Export, KeyKind } from './shapes.ts'
import { exportsOf } from './views.ts'

const NStr = Nullable(Type.String())

export const ResolvedPart = Type.Recursive(
  (Part) =>
    Type.Union([
      Type.Object(
        {
          text: Type.String(),
        },
        {
          additionalProperties: false,
        },
      ),
      Type.Object(
        {
          ref: NStr,
          chain: Type.Array(
            Type.Union([
              Type.Object(
                {
                  scope: StringEnum(['project', 'global', 'app', 'machine']),
                  app_id: Type.Optional(NStr),
                  target: Type.Optional(StringEnum(targetKindValues)),
                  name: Type.String(),
                  key_id: Type.String(),
                  kind: definitionOf(KeyKind),
                  secret_value_id: Type.String(),
                  version: Type.Integer(),
                  bytes: Type.Optional(Nullable(Type.Integer())),
                  pinned_version: Nullable(Type.Integer()),
                },
                {
                  additionalProperties: false,
                },
              ),
              Type.Object(
                {
                  scope: Type.Literal('export'),
                  app_id: Type.String(),
                  key: Type.String(),
                  value: Type.String(),
                },
                {
                  additionalProperties: false,
                },
              ),
              Type.Object(
                {
                  scope: StringEnum(['app', 'machine']),
                  app_id: NStr,
                  name: NStr,
                  key_id: Type.String(),
                  kind: Type.Literal('reference'),
                  reference: Type.String(),
                  parts: Type.Optional(Type.Array(Part)),
                },
                {
                  additionalProperties: false,
                },
              ),
            ]),
          ),
        },
        {
          additionalProperties: false,
        },
      ),
    ]),
  {
    $id: 'ResolvedPart',
  },
)

export const ResolvedKey = Type.Object(
  {
    name: Type.String(),
    key_id: Type.String(),
    kind: KeyKind,
    reference: NStr,
    injection: StringEnum(injectionValues),
    build: Type.Boolean(),
    sealed: Type.Boolean(),
    stale: Type.Boolean(),
    parts: Type.Optional(Type.Array(ResolvedPart)),
    secret_value_id: Type.Optional(Type.String()),
    version: Type.Optional(Type.Integer()),
    bytes: Type.Optional(Nullable(Type.Integer())),
    pinned_version: Type.Optional(Nullable(Type.Integer())),
    error: Nullable(
      Type.Object(
        {
          code: Type.String(),
          explanation: Type.String(),
        },
        {
          additionalProperties: false,
        },
      ),
    ),
    value: Type.Optional(Type.String()),
  },
  {
    title: 'ResolvedKey',
    additionalProperties: false,
  },
)

export const MachineResolved = Type.Object(
  {
    machine_id: Type.String(),
    project_id: Type.String(),
    preview_id: NStr,
    keys: Type.Array(ResolvedKey),
  },
  {
    title: 'MachineResolved',
    additionalProperties: false,
  },
)

export const Resolved = Type.Object(
  {
    app_id: Type.String(),
    project_id: Type.String(),
    preview_id: NStr,
    compared_with: NStr,
    keys: Type.Array(ResolvedKey),
    exports: Type.Array(Export),
  },
  {
    title: 'Resolved',
    additionalProperties: false,
  },
)

type Hop = Record<string, unknown>

type Subject =
  { kind: 'app'; ctx: AppContext; compareWith?: string } | { kind: 'machine'; ctx: MachineContext }

const describeKeys = (kit: Kit, call: Call, subject: Subject, options: { admin: boolean }) => {
  const { db, keyring } = kit.deps
  const comparedId =
    subject.kind === 'app' ? (subject.compareWith ?? subject.ctx.app.current_deployment_id) : null
  const compared = comparedId
    ? db.select().from(deployment).where(eq(deployment.id, comparedId)).get()
    : undefined

  if (
    subject.kind === 'app' &&
    comparedId &&
    (!compared || compared.app_id !== subject.ctx.app.id)
  ) {
    fail('NOT_FOUND', `deployment ${comparedId} is not a deployment of this app`)
  }

  const pinned = new Map<string, number>()

  for (const entry of (compared?.env_snapshot as EnvSnapshot | undefined)?.entries ?? []) {
    for (const leaf of leaves(entry.node)) {
      if (leaf.kind === 'value') {
        pinned.set(`${leaf.key_id}:${leaf.target}`, leaf.version)
      }
    }
  }

  const keyRow = (id: string) => db.select().from(key).where(eq(key.id, id)).get()
  let stale = false

  const valueHop = (leaf: ValueNode): Hop => {
    const scope = leaf.from.startsWith('project')
      ? 'project'
      : leaf.from === 'global'
        ? 'global'
        : leaf.from === 'machine'
          ? 'machine'
          : 'app'
    const pinnedVersion = compared ? (pinned.get(`${leaf.key_id}:${leaf.target}`) ?? null) : null

    if (compared && pinnedVersion !== leaf.version) {
      stale = true
    }

    return {
      scope,
      ...(scope === 'app'
        ? {
            app_id: leaf.app_id,
          }
        : {}),
      ...(scope === 'project'
        ? {
            target: leaf.target,
          }
        : {}),
      name: leaf.key,
      key_id: leaf.key_id,
      kind: keyRow(leaf.key_id)?.kind ?? (leaf.sealed ? 'sealed' : 'literal'),
      secret_value_id: leaf.secret_value_id,
      version: leaf.version,
      ...(leaf.sealed
        ? {
            bytes: storedBytes(db, leaf.secret_value_id),
          }
        : {}),
      pinned_version: pinnedVersion,
    }
  }

  const partsOf = (node: Extract<SourceNode, { kind: 'template' }>): Hop[] => {
    const children = [...node.parts]

    return parseValue(node.template).map((segment) => {
      if (segment.type === 'text') {
        return {
          text: segment.text,
        }
      }

      const child = children.shift()!

      return {
        ref: segment.raw.slice(3, -2).trim(),
        chain: chainOf(child),
      }
    })
  }

  const chainOf = (node: SourceNode): Hop[] => {
    if (node.kind === 'value') {
      return [valueHop(node)]
    }

    if (node.kind === 'export') {
      return [
        {
          scope: 'export',
          app_id: node.app_id,
          key: node.key,
          value: node.value,
        },
      ]
    }

    const row = keyRow(node.key_id)
    const hop: Hop = {
      scope: row?.scope === 'machine' ? 'machine' : 'app',
      app_id: row?.app_id ?? null,
      name: row?.name ?? null,
      key_id: node.key_id,
      kind: 'reference',
      reference: node.template,
    }
    const segments = parseValue(node.template)

    if (segments.length === 1 && node.parts.length === 1) {
      return [hop, ...chainOf(node.parts[0]!)]
    }

    return [
      {
        ...hop,
        parts: partsOf(node),
      },
    ]
  }

  const decrypted: string[] = []
  const owner =
    subject.kind === 'app'
      ? {
          entity: 'app',
          id: subject.ctx.app.id,
        }
      : {
          entity: 'machine',
          id: subject.ctx.machine.id,
        }
  const resolver =
    subject.kind === 'app'
      ? Resolver.forApp(db, subject.ctx.app.id)
      : Resolver.forMachine(db, subject.ctx.machine.id)
  const listed = subject.kind === 'app' ? resolver.appKeys() : resolver.machineKeys()
  const keys = listed.map((v) => {
    const base = {
      name: v.name,
      key_id: v.id,
      kind: v.kind,
      reference: v.reference,
      injection: v.injection,
      build: v.build,
    }
    let node: SourceNode

    try {
      node = subject.kind === 'app' ? resolver.resolve(v) : resolver.resolveMachine(v)
    } catch (error) {
      if (!(error instanceof SecretsError)) {
        throw error
      }

      return {
        ...base,
        sealed: v.kind === 'sealed',
        stale: false,
        parts: [],
        error: {
          code: error.code,
          explanation: error.message,
        },
      }
    }

    stale = false
    const sealed = isSealed(node)
    const shape =
      node.kind === 'template'
        ? {
            parts: partsOf(node),
          }
        : node.kind === 'value'
          ? (() => {
              const hop = valueHop(node)

              return {
                secret_value_id: hop.secret_value_id,
                version: hop.version,
                ...('bytes' in hop
                  ? {
                      bytes: hop.bytes,
                    }
                  : {}),
                pinned_version: hop.pinned_version,
              }
            })()
          : {
              parts: [
                {
                  ref: v.reference,
                  chain: chainOf(node),
                },
              ],
            }
    const entryStale = stale
    let value: string | undefined

    if (options.admin && !sealed) {
      value = render(node, (leaf) => {
        decrypted.push(leaf.secret_value_id)

        return decryptLeaf(db, keyring, leaf)
      })
    }

    return {
      ...base,
      sealed,
      stale: entryStale,
      ...shape,
      error: null,
      ...(value === undefined
        ? {}
        : {
            value,
          }),
    }
  })

  if (decrypted.length) {
    audit(db, call, 'secret.decrypt', owner, {
      purpose: 'view',
      after: {
        secret_value_ids: [...new Set(decrypted)],
      },
    })
  }

  return {
    keys,
    compared,
  }
}

export const resolvedView = (
  kit: Kit,
  call: Call,
  ctx: AppContext,
  options: { admin: boolean; compareWith?: string },
) => {
  const { keys, compared } = describeKeys(
    kit,
    call,
    {
      kind: 'app',
      ctx,
      compareWith: options.compareWith,
    },
    options,
  )

  return {
    app_id: ctx.app.id,
    project_id: ctx.project.id,
    preview_id: previewIdOf(ctx.target_row),
    compared_with: compared?.id ?? null,
    keys,
    exports: exportsOf(kit.deps.db, ctx.app),
  }
}

export const machineResolvedView = (
  kit: Kit,
  call: Call,
  ctx: MachineContext,
  options: { admin: boolean },
) => ({
  machine_id: ctx.machine.id,
  project_id: ctx.project.id,
  preview_id: previewIdOf(ctx.target_row),
  keys: describeKeys(
    kit,
    call,
    {
      kind: 'machine',
      ctx,
    },
    options,
  ).keys,
})
