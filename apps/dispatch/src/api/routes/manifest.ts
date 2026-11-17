import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { Type, type Static } from '@sinclair/typebox'
import { eq } from 'drizzle-orm'
import { t } from 'elysia'

import {
  validateSchema,
  type Issue as LocatedIssue,
  type ManifestDoc,
} from '@stationly/manifest-schema'
import { JsonObject, Nullable } from '@stationly/protocol'

import { app, project } from '../../db/schema.ts'
import { exportManifest, manifestYaml } from '../../manifest/export.ts'
import { planManifest, requireDiffLevel } from '../../manifest/plan.ts'
import { seesProject } from '../access.ts'
import { commit, stripValues } from '../changes.ts'
import { ApiError } from '../errors.ts'
import type { Kit } from '../kit.ts'
import {
  isProduction,
  previewIdOf,
  previewInProject,
  projectByRef,
  scopeOf,
  targetInProject,
  type ProjectRow,
  type TargetRow,
} from '../lookup.ts'
import type { TargetInput } from '../route-meta.ts'
import { Actor, ApprovalDetail, Change, Deployment, extend, replies } from '../shapes.ts'

import { respond } from './services.ts'

const ManifestWarning = Type.Object(
  {
    code: Type.String(),
    explanation: Type.String(),
    path: Type.Optional(Type.String()),
  },
  {
    additionalProperties: false,
  },
)

const Unmanaged = Type.Object(
  {
    entity: Type.String(),
    id: Type.String(),
    app: Type.Optional(Type.String()),
    name: Type.Optional(Type.String()),
    hostname: Type.Optional(Type.String()),
    port: Type.Optional(Type.Integer()),
    mount_path: Type.Optional(Type.String()),
  },
  {
    additionalProperties: false,
  },
)

const planned = {
  unmanaged: Type.Array(Unmanaged),
  warnings: Type.Array(ManifestWarning),
}

const unrecorded = {
  id: Type.Null(),
  project_id: Type.String(),
  preview_id: Nullable(Type.String()),
  source: Type.Literal('manifest'),
  requested_by: Actor,
  changes: Type.Array(Change),
  refs: Type.Record(Type.String(), Type.String()),
  ...planned,
}

const ManifestPlan = Type.Object(
  {
    ...unrecorded,
    status: Type.Union([Type.Literal('plan'), Type.Literal('approved')]),
    deployments: Type.Array(Type.String()),
  },
  {
    additionalProperties: false,
  },
)

const ManifestApplied = Type.Object(
  {
    ...unrecorded,
    status: Type.Literal('approved'),
    deployments: Type.Array(Deployment),
  },
  {
    additionalProperties: false,
  },
)

const ManifestWaiting = extend(ApprovalDetail, planned)

const LocatedIssueSchema = Type.Object(
  {
    path: Type.String(),
    code: Type.String(),
    message: Type.String(),
    line: Type.Optional(Type.Integer()),
    column: Type.Optional(Type.Integer()),
  },
  {
    additionalProperties: false,
  },
)

const Validation = Type.Object(
  {
    valid: Type.Boolean(),
    issues: Type.Array(LocatedIssueSchema),
    warnings: Type.Array(ManifestWarning),
  },
  {
    additionalProperties: false,
  },
)

const ManifestExport = Type.Union([
  JsonObject,
  Type.String({
    description: 'canonical YAML',
  }),
])

const schemaText = readFileSync(
  createRequire(import.meta.url).resolve('@stationly/manifest-schema/schema.json'),
  'utf8',
)
const schemaEtag = `"${createHash('sha256').update(schemaText).digest('hex').slice(0, 32)}"`

const ManifestInput = t.Union(
  [
    t.String({
      description: 'YAML or JSON text',
    }),
    t.Record(t.String(), t.Unknown(), {
      description: 'The parsed Manifest object',
    }),
  ],
  {
    description: 'An stationly.yaml Manifest, validated against /schema/manifest.json',
  },
)

const validationError = (issues: LocatedIssue[]) =>
  new ApiError(
    'VALIDATION_FAILED',
    `The Manifest has ${issues.length} problem${issues.length === 1 ? '' : 's'}.`,
    'Correct each issue at its path and run apply with plan again.',
    {
      issues,
    },
  )

export const manifestRoutes = (kit: Kit) => {
  const { db, keyring } = kit.deps

  const evaluate = async (
    input: unknown,
    proj: ProjectRow,
    place: TargetRow,
    options: { prune: boolean; allowUnresolved: boolean },
  ) => {
    const parsed = validateSchema(input)

    if (parsed.issues.length) {
      throw validationError(parsed.issues)
    }

    const doc = parsed.value as ManifestDoc
    const plan = await planManifest({
      db,
      keyring,
      project: proj,
      place,
      doc,
      prune: options.prune,
      allowUnresolved: options.allowUnresolved,
      resolveRepo: (repo) => kit.deps.github.resolveRepo(repo),
    })
    const locate = (issue: { path: string; code: string; message: string }) => parsed.locate(issue)

    return {
      plan,
      locate,
      doc,
    }
  }

  const target = (proj: ProjectRow, ref: string | undefined) => {
    const place = targetInProject(db, proj, ref)

    return {
      place,
      scope: scopeOf(place),
    }
  }

  const placeIds = (place: TargetRow) => ({
    project_id: place.project_id,
    preview_id: previewIdOf(place),
  })

  return kit
    .router('manifest', '')
    .get(
      '/schema/manifest.json',
      ({ request }) => {
        const headers = {
          'cache-control': 'max-age=3600',
          etag: schemaEtag,
        }

        if (request.headers.get('if-none-match') === schemaEtag) {
          return new Response(null, {
            status: 304,
            headers,
          })
        }

        return new Response(schemaText, {
          headers: {
            ...headers,
            'content-type': 'application/schema+json',
          },
        })
      },
      {
        operation: {
          id: 'get_manifest_schema',
          summary: 'The Manifest JSON Schema',
          level: 'public',
          mcp: false,
        },
      },
    )
    .post(
      '/v1/projects/:project/manifest/apply',
      async ({
        request,
        params,
        body,
        set,
      }): Promise<
        | Static<typeof ManifestPlan>
        | Static<typeof ManifestApplied>
        | Static<typeof ManifestWaiting>
      > => {
        const call = await kit.call(request)
        const proj = projectByRef(db, params.project)
        const { place, scope } = target(proj, body.preview)
        const planOnly = body.plan ?? true
        const { plan, locate } = await evaluate(body.manifest, proj, place, {
          prune: body.prune ?? false,
          allowUnresolved: body.allow_unresolved ?? true,
        })

        if (plan.issues.length) {
          throw validationError(plan.issues.map((i) => locate(i)))
        }

        const warnings = plan.warnings.map((w) => ({
          code: w.code,
          explanation: w.explanation,
          ...(w.path
            ? {
                path: w.path,
              }
            : {}),
        }))
        const changes = plan.set.changes

        if (planOnly) {
          const downtime = changes.some(
            (c) => c.entity === 'deployment' && c.op === 'add' && isReplace(c.parent, changes, db),
          )

          return {
            id: null,
            ...placeIds(place),
            status: 'plan' as const,
            source: 'manifest' as const,
            requested_by: call.principal.actor,
            changes: stripValues(changes),
            refs: {},
            deployments: [],
            unmanaged: plan.unmanaged,
            warnings: downtime
              ? [
                  ...warnings,
                  {
                    code: 'DOWNTIME_EXPECTED',
                    explanation:
                      'An app with strategy = replace stops its old container before the new one is healthy.',
                  },
                ]
              : warnings,
          }
        }

        requireDiffLevel(call.principal, scope, changes)

        if (plan.set.empty) {
          return {
            id: null,
            ...placeIds(place),
            status: 'approved' as const,
            source: 'manifest' as const,
            requested_by: call.principal.actor,
            changes: [],
            refs: {},
            deployments: [],
            unmanaged: plan.unmanaged,
            warnings,
          }
        }

        const result = commit(
          kit.deps,
          call,
          {
            target: place,
            protect: isProduction(place),
            source: 'manifest',
          },
          plan.set,
        )

        if (!result.applied) {
          return {
            ...kit.approvalBody(result, set),
            unmanaged: plan.unmanaged,
            warnings,
          }
        }

        return respond(
          kit,
          set,
          result,
          () => ({
            id: null,
            ...placeIds(place),
            status: 'approved' as const,
            source: 'manifest' as const,
            requested_by: call.principal.actor,
            changes: stripValues(changes),
            refs: result.refs,
            unmanaged: plan.unmanaged,
          }),
          warnings,
        ) as Static<typeof ManifestApplied>
      },
      {
        operation: {
          id: 'apply_manifest',
          summary: 'Validate and plan or apply a Manifest against production or one preview',
          level: 'deploy',
          cli: false,
          target: ({ params, body }: TargetInput) =>
            target(projectByRef(db, params.project!), (body as { preview?: string }).preview).scope,
        },
        body: t.Object(
          {
            manifest: ManifestInput,
            preview: t.Optional(
              t.String({
                description: 'A preview by id or name; production when omitted',
              }),
            ),
            plan: t.Optional(
              t.Boolean({
                description: 'Return the diff without applying it; default true',
              }),
            ),
            prune: t.Optional(
              t.Boolean({
                description: 'Remove entities a managed collection does not list; default false',
              }),
            ),
            allow_unresolved: t.Optional(
              t.Boolean({
                description: 'Report unresolved references as warnings; default true',
              }),
            ),
          },
          {
            additionalProperties: false,
          },
        ),
        response: replies({
          200: Type.Union([ManifestPlan, ManifestApplied]),
          202: ManifestWaiting,
        }),
      },
    )
    .post(
      '/v1/manifest/validate',
      async ({ request, body }) => {
        const call = await kit.call(request)
        const parsed = validateSchema(body.manifest)

        if (parsed.issues.length) {
          return {
            valid: false,
            issues: parsed.issues,
            warnings: [],
          }
        }

        const doc = parsed.value as ManifestDoc
        const proj = db.select().from(project).where(eq(project.name, doc.project)).get()

        if (!proj || !seesProject(call.principal, proj.id)) {
          return {
            valid: true,
            issues: [],
            warnings: [
              {
                code: 'SEMANTIC_SKIPPED',
                explanation: `Project ${doc.project} is not visible to this credential, so only the schema pass ran.`,
              },
            ],
          }
        }

        const { place } = target(proj, body.preview)
        const { plan, locate } = await evaluate(body.manifest, proj, place, {
          prune: false,
          allowUnresolved: true,
        })

        return {
          valid: plan.issues.length === 0,
          issues: plan.issues.map((i) => locate(i)),
          warnings: plan.warnings,
        }
      },
      {
        operation: {
          id: 'validate_manifest',
          summary:
            'Validate a Manifest: the schema pass, then the semantic pass when its project is visible',
          level: 'any',
          cli: false,
        },
        body: t.Object(
          {
            manifest: ManifestInput,
            preview: t.Optional(t.String()),
          },
          {
            additionalProperties: false,
          },
        ),
        response: replies({
          200: Validation,
        }),
      },
    )
    .get(
      '/v1/projects/:project/manifest',
      ({ request, params, query }) => {
        const proj = projectByRef(db, params.project)
        const place = query.preview ? previewInProject(db, proj, query.preview) : null
        const doc = exportManifest(db, keyring, proj, place)

        if ((request.headers.get('accept') ?? '').includes('application/json')) {
          return doc
        }

        return manifestYaml(doc, `${kit.deps.auth.surface.apiOrigin}/schema/manifest.json`)
      },
      {
        operation: {
          id: 'export_manifest',
          summary: 'Export the current configuration as a canonical Manifest',
          level: 'read',
          cli: false,
          target: ({ params, query }: TargetInput) =>
            query.preview
              ? target(projectByRef(db, params.project!), query.preview).scope
              : {
                  project_id: projectByRef(db, params.project!).id,
                  target: '*',
                },
        },
        mapResponse: ({ responseValue, set }) => {
          if (typeof responseValue !== 'string') {
            return
          }

          return new Response(responseValue, {
            status: typeof set.status === 'number' ? set.status : 200,
            headers: {
              ...(set.headers as Record<string, string>),
              'content-type': 'text/yaml; charset=utf-8',
            },
          })
        },
        query: t.Object({
          preview: t.Optional(
            t.String({
              description:
                'Export this preview alone; omit to export production with named previews as overrides',
            }),
          ),
        }),
        response: replies({
          200: ManifestExport,
        }),
      },
    )
}

const isReplace = (
  parent: string | null,
  changes: {
    op: string
    entity: string
    ref?: string
    id?: string
    path?: string
    after?: unknown
  }[],
  db: Kit['deps']['db'],
) => {
  if (!parent) {
    return false
  }

  const added = changes.find((c) => c.op === 'add' && c.entity === 'app' && c.ref === parent)

  if (added) {
    return (added.after as { strategy?: string }).strategy === 'replace'
  }

  const changed = changes.find(
    (c) => c.op === 'update' && c.entity === 'app' && c.id === parent && c.path === '/strategy',
  )

  if (changed) {
    return changed.after === 'replace'
  }

  return (
    db
      .select({
        strategy: app.strategy,
      })
      .from(app)
      .where(eq(app.id, parent))
      .get()?.strategy === 'replace'
  )
}
