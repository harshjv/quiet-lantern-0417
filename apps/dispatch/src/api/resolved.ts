import { Type } from '@sinclair/typebox'
import { eq } from 'drizzle-orm'

import { injectionValues, Nullable, StringEnum, targetKindValues } from '@stationly/protocol'

import { deployment, environment_variable } from '../db/schema.ts'
import type { EnvSnapshot } from '../secrets/deploy.ts'
import { SecretsError } from '../secrets/errors.ts'
import { parseValue } from '../secrets/reference.ts'
import {
  isSecret,
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
import { previewIdOf, type AppContext } from './lookup.ts'
import { definitionOf, EnvironmentVariableKind, Export } from './shapes.ts'
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
                  scope: StringEnum(['project', 'global', 'app']),
                  app_id: Type.Optional(NStr),
                  target: Type.Optional(StringEnum(targetKindValues)),
                  name: Type.String(),
                  environment_variable_id: Type.String(),
                  kind: definitionOf(EnvironmentVariableKind),
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
                  scope: Type.Literal('app'),
                  app_id: NStr,
                  name: NStr,
                  environment_variable_id: Type.String(),
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

export const ResolvedVariable = Type.Object(
  {
    name: Type.String(),
    environment_variable_id: Type.String(),
    kind: EnvironmentVariableKind,
    reference: NStr,
    injection: StringEnum(injectionValues),
    build: Type.Boolean(),
    secret: Type.Boolean(),
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
    title: 'ResolvedVariable',
    additionalProperties: false,
  },
)

export const Resolved = Type.Object(
  {
    app_id: Type.String(),
    project_id: Type.String(),
    preview_id: NStr,
    compared_with: NStr,
    environment_variables: Type.Array(ResolvedVariable),
    exports: Type.Array(Export),
  },
  {
    title: 'Resolved',
    additionalProperties: false,
  },
)

type Hop = Record<string, unknown>

type Subject = { kind: 'app'; ctx: AppContext; compareWith?: string }

const describeVariables = (kit: Kit, call: Call, subject: Subject, options: { admin: boolean }) => {
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
        pinned.set(`${leaf.environment_variable_id}:${leaf.target}`, leaf.version)
      }
    }
  }

  const variableRow = (id: string) =>
    db.select().from(environment_variable).where(eq(environment_variable.id, id)).get()
  let stale = false

  const valueHop = (leaf: ValueNode): Hop => {
    const scope = leaf.from.startsWith('project')
      ? 'project'
      : leaf.from === 'global'
        ? 'global'
        : 'app'
    const pinnedVersion = compared
      ? (pinned.get(`${leaf.environment_variable_id}:${leaf.target}`) ?? null)
      : null

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
      environment_variable_id: leaf.environment_variable_id,
      kind: variableRow(leaf.environment_variable_id)?.kind ?? (leaf.secret ? 'secret' : 'literal'),
      secret_value_id: leaf.secret_value_id,
      version: leaf.version,
      ...(leaf.secret
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

    const row = variableRow(node.environment_variable_id)
    const hop: Hop = {
      scope: 'app',
      app_id: row?.app_id ?? null,
      name: row?.name ?? null,
      environment_variable_id: node.environment_variable_id,
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
  const owner = {
    entity: 'app',
    id: subject.ctx.app.id,
  }
  const resolver = Resolver.forApp(db, subject.ctx.app.id)
  const listed = resolver.appVariables()
  const variables = listed.map((v) => {
    const base = {
      name: v.name,
      environment_variable_id: v.id,
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
        secret: v.kind === 'secret',
        stale: false,
        parts: [],
        error: {
          code: error.code,
          explanation: error.message,
        },
      }
    }

    stale = false
    const secret = isSecret(node)
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

    if (options.admin && !secret) {
      value = render(node, (leaf) => {
        decrypted.push(leaf.secret_value_id)

        return decryptLeaf(db, keyring, leaf)
      })
    }

    return {
      ...base,
      secret,
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
    environment_variables: variables,
    compared,
  }
}

export const resolvedView = (
  kit: Kit,
  call: Call,
  ctx: AppContext,
  options: { admin: boolean; compareWith?: string },
) => {
  const { environment_variables, compared } = describeVariables(
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
    environment_variables,
    exports: exportsOf(kit.deps.db, ctx.app),
  }
}
