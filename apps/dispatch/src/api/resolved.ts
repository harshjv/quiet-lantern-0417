import { Type } from '@sinclair/typebox'
import { eq } from 'drizzle-orm'

import { injectionValues, Nullable, StringEnum } from '@stationly/protocol'

import { deployment, environment, variable } from '../db/schema.ts'
import type { EnvSnapshot } from '../secrets/deploy.ts'
import { SecretsError } from '../secrets/errors.ts'
import { parseValue } from '../secrets/reference.ts'
import {
  isFallback,
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
import type { SandboxContext, ServiceContext } from './lookup.ts'
import { definitionOf, Export, VariableKind } from './shapes.ts'
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
                  scope: StringEnum(['project', 'global', 'service', 'sandbox']),
                  service_id: Type.Optional(NStr),
                  environment: Type.Optional(Type.String()),
                  key: Type.String(),
                  variable_id: Type.String(),
                  kind: definitionOf(VariableKind),
                  secret_value_id: Type.String(),
                  version: Type.Integer(),
                  bytes: Type.Optional(Nullable(Type.Integer())),
                  pinned_version: Nullable(Type.Integer()),
                  fallback_from_protected: Type.Optional(Type.Literal(true)),
                },
                {
                  additionalProperties: false,
                },
              ),
              Type.Object(
                {
                  scope: Type.Literal('export'),
                  service_id: Type.String(),
                  key: Type.String(),
                  value: Type.String(),
                },
                {
                  additionalProperties: false,
                },
              ),
              Type.Object(
                {
                  scope: StringEnum(['service', 'sandbox']),
                  service_id: NStr,
                  key: NStr,
                  variable_id: Type.String(),
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
    key: Type.String(),
    variable_id: Type.String(),
    kind: VariableKind,
    reference: NStr,
    injection: StringEnum(injectionValues),
    build: Type.Boolean(),
    sealed: Type.Boolean(),
    stale: Type.Boolean(),
    fallback_from_protected: Type.Boolean(),
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

export const SandboxResolved = Type.Object(
  {
    sandbox_id: Type.String(),
    environment_id: Type.String(),
    variables: Type.Array(ResolvedVariable),
  },
  {
    title: 'SandboxResolved',
    additionalProperties: false,
  },
)

export const Resolved = Type.Object(
  {
    service_id: Type.String(),
    environment_id: Type.String(),
    compared_with: NStr,
    variables: Type.Array(ResolvedVariable),
    exports: Type.Array(Export),
  },
  {
    title: 'Resolved',
    additionalProperties: false,
  },
)

type Hop = Record<string, unknown>

type Subject =
  | { kind: 'service'; ctx: ServiceContext; compareWith?: string }
  | { kind: 'sandbox'; ctx: SandboxContext }

const describeVariables = (kit: Kit, call: Call, subject: Subject, options: { admin: boolean }) => {
  const { db, keyring } = kit.deps
  const comparedId =
    subject.kind === 'service'
      ? (subject.compareWith ?? subject.ctx.service.current_deployment_id)
      : null
  const compared = comparedId
    ? db.select().from(deployment).where(eq(deployment.id, comparedId)).get()
    : undefined

  if (
    subject.kind === 'service' &&
    comparedId &&
    (!compared || compared.service_id !== subject.ctx.service.id)
  ) {
    fail('NOT_FOUND', `deployment ${comparedId} is not a deployment of this service`)
  }

  const pinned = new Map<string, number>()

  for (const entry of (compared?.env_snapshot as EnvSnapshot | undefined)?.entries ?? []) {
    for (const leaf of leaves(entry.node)) {
      if (leaf.kind === 'value') {
        pinned.set(`${leaf.variable_id}:${leaf.environment_id}`, leaf.version)
      }
    }
  }

  const envNames = new Map(
    db
      .select({
        id: environment.id,
        name: environment.name,
      })
      .from(environment)
      .all()
      .map((e) => [e.id, e.name]),
  )
  const variableRow = (id: string) => db.select().from(variable).where(eq(variable.id, id)).get()
  let stale = false

  const valueHop = (leaf: ValueNode): Hop => {
    const scope = leaf.from.startsWith('project')
      ? 'project'
      : leaf.from === 'global'
        ? 'global'
        : leaf.from === 'sandbox'
          ? 'sandbox'
          : 'service'
    const pinnedVersion = compared
      ? (pinned.get(`${leaf.variable_id}:${leaf.environment_id}`) ?? null)
      : null

    if (compared && pinnedVersion !== leaf.version) {
      stale = true
    }

    return {
      scope,
      ...(scope === 'service'
        ? {
            service_id: leaf.service_id,
          }
        : {}),
      ...(scope === 'project'
        ? {
            environment: leaf.environment_id
              ? (envNames.get(leaf.environment_id) ?? leaf.environment_id)
              : 'default',
          }
        : {}),
      key: leaf.key,
      variable_id: leaf.variable_id,
      kind: variableRow(leaf.variable_id)?.kind ?? (leaf.sealed ? 'sealed' : 'literal'),
      secret_value_id: leaf.secret_value_id,
      version: leaf.version,
      ...(leaf.sealed
        ? {
            bytes: storedBytes(db, leaf.secret_value_id),
          }
        : {}),
      pinned_version: pinnedVersion,
      ...(leaf.fallback_from_protected
        ? {
            fallback_from_protected: true,
          }
        : {}),
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
          service_id: node.service_id,
          key: node.key,
          value: node.value,
        },
      ]
    }

    const row = variableRow(node.variable_id)
    const hop: Hop = {
      scope: row?.scope === 'sandbox' ? 'sandbox' : 'service',
      service_id: row?.service_id ?? null,
      key: row?.key ?? null,
      variable_id: node.variable_id,
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
    subject.kind === 'service'
      ? {
          entity: 'service',
          id: subject.ctx.service.id,
        }
      : {
          entity: 'sandbox',
          id: subject.ctx.sandbox.id,
        }
  const resolver =
    subject.kind === 'service'
      ? Resolver.forService(db, subject.ctx.service.id)
      : Resolver.forSandbox(db, subject.ctx.sandbox.id)
  const listed =
    subject.kind === 'service' ? resolver.serviceVariables() : resolver.sandboxVariables()
  const variables = listed.map((v) => {
    const base = {
      key: v.key,
      variable_id: v.id,
      kind: v.kind,
      reference: v.reference,
      injection: v.injection,
      build: v.build,
    }
    let node: SourceNode

    try {
      node = subject.kind === 'service' ? resolver.resolve(v) : resolver.resolveSandbox(v)
    } catch (error) {
      if (!(error instanceof SecretsError)) {
        throw error
      }

      return {
        ...base,
        sealed: v.kind === 'sealed',
        stale: false,
        fallback_from_protected: false,
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
      fallback_from_protected: isFallback(node),
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
    variables,
    compared,
  }
}

export const resolvedView = (
  kit: Kit,
  call: Call,
  ctx: ServiceContext,
  options: { admin: boolean; compareWith?: string },
) => {
  const { variables, compared } = describeVariables(
    kit,
    call,
    {
      kind: 'service',
      ctx,
      compareWith: options.compareWith,
    },
    options,
  )

  return {
    service_id: ctx.service.id,
    environment_id: ctx.environment.id,
    compared_with: compared?.id ?? null,
    variables,
    exports: exportsOf(kit.deps.db, ctx.service),
  }
}

export const sandboxResolvedView = (
  kit: Kit,
  call: Call,
  ctx: SandboxContext,
  options: { admin: boolean },
) => ({
  sandbox_id: ctx.sandbox.id,
  environment_id: ctx.environment.id,
  variables: describeVariables(
    kit,
    call,
    {
      kind: 'sandbox',
      ctx,
    },
    options,
  ).variables,
})
