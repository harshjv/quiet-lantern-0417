import { Type } from '@sinclair/typebox'
import { and, desc, eq } from 'drizzle-orm'
import { Elysia, t } from 'elysia'

import {
  personalTokenDefaultSeconds,
  personalTokenMaxSeconds,
  scopedTokenDefaultSeconds,
  scopedTokenMaxSeconds,
  v1Permission,
} from '../../auth/auth.ts'
import { revokeGrantArtifacts } from '../../auth/grants.ts'
import type { Principal } from '../../auth/principal.ts'
import { fullAdmin, scopeWithin, type Scope } from '../../auth/scopes.ts'
import { newId } from '../../db/ids.ts'
import { apikey, environment, project, token } from '../../db/schema.ts'
import { requireHuman } from '../access.ts'
import { audit } from '../context.ts'
import { fail, invalid, notFound } from '../errors.ts'
import { project as select } from '../fields.ts'
import type { Kit } from '../kit.ts'
import { before, collect, listQuery } from '../pagination.ts'
import { ScopeInput } from '../schemas.ts'
import { extend, models, Page, replies, Token } from '../shapes.ts'

const CreatedToken = extend(Token, {
  key: Type.String(),
})

const Revoked = Type.Object(
  {
    revoked: Type.Literal(true),
  },
  {
    additionalProperties: false,
  },
)

type TokenRow = typeof token.$inferSelect

const scopesOf = (row: TokenRow): Scope[] =>
  row.kind === 'personal' || row.kind === 'station_enroll' ? fullAdmin : row.scopes

export const manages = (principal: Principal, row: TokenRow) =>
  scopesOf(row).every((scope) => scopeWithin(principal.scopes, scope))

export const tokenRoutes = (kit: Kit) => {
  const { db } = kit.deps
  const tags = ['tokens']
  const view = (row: TokenRow) => select(kit.views.token, row, undefined)

  const validateScopes = (scopes: Scope[]) => {
    const issues: { path: string; message: string }[] = []
    scopes.forEach((scope, i) => {
      if (
        scope.project_id !== '*' &&
        !db
          .select({
            id: project.id,
          })
          .from(project)
          .where(eq(project.id, scope.project_id))
          .get()
      ) {
        issues.push({
          path: `/scopes/${i}/project_id`,
          message: 'unknown project',
        })
      }
      if (scope.environment_id !== '*') {
        const env = db
          .select()
          .from(environment)
          .where(eq(environment.id, scope.environment_id))
          .get()
        if (!env || env.project_id !== scope.project_id)
          issues.push({
            path: `/scopes/${i}/environment_id`,
            message: 'not an environment of that project',
          })
      }
    })
    if (issues.length) invalid(issues)
  }

  return new Elysia({
    prefix: '/v1',
    normalize: false,
  })
    .use(models())
    .use(kit.operations)
    .get(
      '/tokens',
      async ({ request, query }) => {
        const principal = await kit.principal(request)
        const page = collect(
          (cursor, size) =>
            db
              .select()
              .from(token)
              .where(
                and(
                  query.kind ? eq(token.kind, query.kind as TokenRow['kind']) : undefined,
                  before(token.id, cursor),
                ),
              )
              .orderBy(desc(token.id))
              .limit(size)
              .all(),
          query,
          (row) => manages(principal, row),
        )
        return {
          items: page.rows.map((row) => select(kit.views.token, row, kit.fields(query.fields))),
          next_cursor: page.next_cursor,
        }
      },
      {
        operation: {
          id: 'list_tokens',
          level: 'any',
        },
        query: t.Object({
          ...listQuery,
          kind: t.Optional(t.String()),
        }),
        response: replies({
          200: Page(Token),
        }),
        detail: {
          summary: 'List tokens the caller manages; never key material',
          tags,
        },
      },
    )
    .post(
      '/tokens',
      async ({ request, body, set }) => {
        const call = await kit.call(request)
        const kind = body.kind ?? 'scoped'
        let scopes: Scope[]
        let seconds: number
        if (kind === 'personal') {
          requireHuman(call.principal, 'Creating a personal token', {
            kind: 'personal',
          })
          if (body.scopes && body.scopes.length)
            invalid([
              {
                path: '/scopes',
                message: 'a personal token always holds admin on * and *',
              },
            ])
          scopes = []
          seconds = body.expires_in_s ?? personalTokenDefaultSeconds
          if (seconds > personalTokenMaxSeconds)
            invalid([
              {
                path: '/expires_in_s',
                message: `at most ${personalTokenMaxSeconds} for a personal token`,
              },
            ])
        } else {
          scopes = body.scopes ?? []
          if (!scopes.length)
            invalid([
              {
                path: '/scopes',
                message: 'a scoped token needs at least one scope',
              },
            ])
          validateScopes(scopes)
          const outside = scopes.find((scope) => !scopeWithin(call.principal.scopes, scope))
          if (outside) {
            fail(
              'FORBIDDEN_SCOPE',
              `Minting ${outside.level} on project ${outside.project_id}, environment ${outside.environment_id} needs admin there.`,
              'Request only scopes within your own admin scopes.',
              {
                required: {
                  project_id: outside.project_id,
                  environment_id: outside.environment_id,
                  level: 'admin',
                },
              },
            )
          }
          seconds = body.expires_in_s ?? scopedTokenDefaultSeconds
          if (seconds > scopedTokenMaxSeconds)
            invalid([
              {
                path: '/expires_in_s',
                message: `at most ${scopedTokenMaxSeconds} for a scoped token`,
              },
            ])
        }
        if (seconds < 3600)
          invalid([
            {
              path: '/expires_in_s',
              message: 'at least 3600',
            },
          ])
        const id = newId('token')
        const created = await kit.deps.auth.current.api.createApiKey({
          body: {
            userId: call.principal.user_id,
            expiresIn: seconds,
            metadata: {
              token_id: id,
            },
            permissions: v1Permission,
          },
        })
        db.insert(token)
          .values({
            id,
            user_id: call.principal.user_id,
            name: body.name,
            kind,
            scopes,
            expires_at: new Date(created.expiresAt ?? Date.now() + seconds * 1000),
            api_key_id: created.id,
          })
          .run()
        const row = db.select().from(token).where(eq(token.id, id)).get()!
        audit(
          db,
          call,
          'token.create',
          {
            entity: 'token',
            id,
          },
          {
            after: {
              name: body.name,
              kind,
              scopes: scopesOf(row),
              expires_at: row.expires_at.toISOString(),
            },
          },
        )
        set.status = 201
        return {
          ...view(row),
          key: created.key,
        }
      },
      {
        operation: {
          id: 'create_token',
          level: 'any',
          cli: {
            args: ['name'],
          },
        },
        body: t.Object(
          {
            name: t.String({
              minLength: 1,
              maxLength: 128,
            }),
            kind: t.Optional(t.Union([t.Literal('scoped'), t.Literal('personal')])),
            scopes: t.Optional(t.Array(ScopeInput)),
            expires_in_s: t.Optional(
              t.Integer({
                minimum: 1,
              }),
            ),
          },
          {
            additionalProperties: false,
          },
        ),
        response: replies({
          201: CreatedToken,
        }),
        detail: {
          summary: 'Create a token; the key is returned once',
          tags,
        },
      },
    )
    .post(
      '/tokens/:id/renew',
      async ({ request, params, body }) => {
        const call = await kit.call(request)
        requireHuman(call.principal, 'Renewing a personal token')
        const row =
          db.select().from(token).where(eq(token.id, params.id)).get() ??
          notFound('token', params.id)
        if (row.user_id !== call.principal.user_id) notFound('token', params.id)
        if (row.kind !== 'personal' || !row.api_key_id)
          invalid([
            {
              path: '/id',
              message: `only personal tokens renew; this one is ${row.kind}`,
            },
          ])
        const seconds = body?.expires_in_s ?? personalTokenDefaultSeconds
        if (seconds > personalTokenMaxSeconds || seconds < 3600)
          invalid([
            {
              path: '/expires_in_s',
              message: `between 3600 and ${personalTokenMaxSeconds}`,
            },
          ])
        const updated = await kit.deps.auth.current.api.updateApiKey({
          body: {
            keyId: row.api_key_id!,
            userId: row.user_id,
            expiresIn: seconds,
          },
        })
        const expires = new Date(updated.expiresAt ?? Date.now() + seconds * 1000)
        db.update(token)
          .set({
            expires_at: expires,
          })
          .where(eq(token.id, row.id))
          .run()
        audit(
          db,
          call,
          'token.renew',
          {
            entity: 'token',
            id: row.id,
          },
          {
            before: {
              expires_at: row.expires_at.toISOString(),
            },
            after: {
              expires_at: expires.toISOString(),
            },
          },
        )
        return view(db.select().from(token).where(eq(token.id, row.id)).get()!)
      },
      {
        operation: {
          id: 'renew_token',
          level: 'any',
          mcp: false,
        },
        params: t.Object({
          id: t.String(),
        }),
        body: t.Optional(
          t.Object(
            {
              expires_in_s: t.Optional(
                t.Integer({
                  minimum: 1,
                }),
              ),
            },
            {
              additionalProperties: false,
            },
          ),
        ),
        response: replies({
          200: Token,
        }),
        detail: {
          summary: 'Renew a personal token; human only',
          tags,
        },
      },
    )
    .delete(
      '/tokens/:id',
      async ({ request, params }) => {
        const call = await kit.call(request)
        const row =
          db.select().from(token).where(eq(token.id, params.id)).get() ??
          notFound('token', params.id)
        const self = call.principal.token_id === row.id
        if (!self && !manages(call.principal, row)) {
          fail(
            'FORBIDDEN_SCOPE',
            'Revoking this token needs admin on every one of its scopes.',
            'Revoke it with a credential that holds admin on those scopes, or with the token itself.',
            {
              required: scopesOf(row).map((scope) => ({
                ...scope,
                level: 'admin',
              })),
            },
          )
        }
        db.transaction((tx) => {
          if (row.api_key_id) tx.delete(apikey).where(eq(apikey.id, row.api_key_id)).run()
          if (row.kind === 'oauth') revokeGrantArtifacts(tx, row.id)
          tx.delete(token).where(eq(token.id, row.id)).run()
        })
        audit(
          db,
          call,
          'token.revoke',
          {
            entity: 'token',
            id: row.id,
          },
          {
            before: {
              name: row.name,
              kind: row.kind,
            },
          },
        )
        return {
          revoked: true as const,
        }
      },
      {
        operation: {
          id: 'revoke_token',
          level: 'any',
        },
        params: t.Object({
          id: t.String(),
        }),
        response: replies({
          200: Revoked,
        }),
        detail: {
          summary: 'Revoke a token',
          tags,
        },
      },
    )
}
