import { createHash, randomBytes } from 'node:crypto'

import { Type } from '@sinclair/typebox'
import { eq } from 'drizzle-orm'
import { Elysia, t } from 'elysia'

import { githubRepositorySelectionValues, Nullable, StringEnum } from '@stationly/protocol'

import { surfaceOf } from '../../auth/principal.ts'
import { newId } from '../../db/ids.ts'
import {
  github_app,
  github_connect_state,
  github_delivery,
  github_installation,
} from '../../db/schema.ts'
import { readSetting } from '../../db/settings.ts'
import { gh, GitHubError, githubWeb } from '../../github/client.ts'
import { requireHuman } from '../access.ts'
import { audit } from '../context.ts'
import { fail } from '../errors.ts'
import type { Kit } from '../kit.ts'
import { models, replies } from '../shapes.ts'

const Installation = Type.Object(
  {
    id: Type.String(),
    installation_id: Type.Integer(),
    account: Type.String(),
    repository_selection: StringEnum(githubRepositorySelectionValues),
    suspended_at: Nullable(Type.String()),
  },
  {
    additionalProperties: false,
  },
)

const Connection = Type.Object(
  {
    apps: Type.Array(
      Type.Object(
        {
          id: Type.String(),
          app_id: Type.Integer(),
          slug: Type.String(),
          owner: Type.String(),
          webhooks: Type.Boolean(),
          install_url: Type.String(),
          installation: Nullable(Installation),
        },
        {
          additionalProperties: false,
        },
      ),
    ),
    connect_url: Type.String(),
  },
  {
    additionalProperties: false,
  },
)

const Installations = Type.Object(
  {
    items: Type.Array(Installation),
  },
  {
    additionalProperties: false,
  },
)

const Repositories = Type.Object(
  {
    items: Type.Array(
      Type.Object(
        {
          full_name: Type.String(),
          private: Type.Boolean(),
          default_branch: Type.String(),
        },
        {
          additionalProperties: false,
        },
      ),
    ),
  },
  {
    additionalProperties: false,
  },
)

const Disconnected = Type.Object(
  {
    disconnected: Type.Literal(true),
  },
  {
    additionalProperties: false,
  },
)

const stateTtlMs = 3600_000

const escapeHtml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')

const sha = (value: string) => createHash('sha256').update(value).digest('hex')

type Conversion = {
  id: number
  slug: string
  client_id: string
  client_secret: string
  webhook_secret: string | null
  pem: string
  owner: { login: string; type: string }
}
type InstallationData = {
  id: number
  app_id: number
  account: { login: string }
  repository_selection: 'all' | 'selected'
  suspended_at: string | null
}

export const githubRoutes = (kit: Kit) => {
  const { db, github, auth } = kit.deps
  const tags = ['github']

  const dashboardOrigin = (request: Request) =>
    surfaceOf(request, auth) === 'local'
      ? new URL(request.url).origin
      : auth.surface.dashboardOrigin

  const human = async (request: Request, what: string) => {
    const principal = await kit.principal(request)
    requireHuman(principal, what)
    return principal
  }

  const instanceSuffix = () => {
    const id = readSetting(db, 'instance.id')
    return (id ?? 'ins_local').slice(-6).toLowerCase()
  }

  return new Elysia({
    normalize: false,
  })
    .use(models())
    .use(kit.operations)
    .get(
      '/github/connect',
      async ({ request, query, set }) => {
        const principal = await human(request, 'Connecting a GitHub App')
        const state = randomBytes(32).toString('base64url')
        const origin = dashboardOrigin(request)
        const webhooks = auth.surface.apiOrigin.startsWith('https://')
        db.insert(github_connect_state)
          .values({
            state_sha256: sha(state),
            user_id: principal.user_id,
            org: query.org ?? null,
            webhooks,
            dashboard_origin: origin,
            expires_at: new Date(Date.now() + stateTtlMs),
          })
          .run()
        const manifest = {
          name: `stationly-${instanceSuffix()}${query.org ? `-${query.org.toLowerCase()}` : ''}`,
          url: origin,
          hook_attributes: {
            url: `${auth.surface.apiOrigin}/github/webhook/pending`,
            active: webhooks,
          },
          redirect_url: `${origin}/github/manifest/callback`,
          setup_url: `${origin}/github/setup`,
          setup_on_update: true,
          public: false,
          default_permissions: {
            contents: 'read',
            metadata: 'read',
            pull_requests: 'read',
            statuses: 'write',
            deployments: 'write',
          },
          default_events: ['push', 'pull_request'],
        }
        const action = `${githubWeb()}${query.org ? `/organizations/${encodeURIComponent(query.org)}` : ''}/settings/apps/new?state=${state}`
        set.headers['content-type'] = 'text/html; charset=utf-8'
        set.headers['cache-control'] = 'no-store'
        return `<!doctype html><html><head><meta charset="utf-8"><title>Connect GitHub</title></head><body><form id="f" method="post" action="${escapeHtml(action)}"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}"><button type="submit">Create the GitHub App</button></form><script>document.getElementById('f').submit()</script></body></html>`
      },
      {
        operation: {
          id: 'connect_github',
          level: 'instance admin',
          mcp: false,
        },
        query: t.Object({
          org: t.Optional(
            t.String({
              pattern: '^[A-Za-z0-9-]{1,39}$',
            }),
          ),
        }),
        detail: {
          hide: true,
        },
      },
    )
    .get(
      '/github/manifest/callback',
      async ({ request, query, set }) => {
        const principal = await human(request, 'Connecting a GitHub App')
        const row = query.state
          ? db
              .select()
              .from(github_connect_state)
              .where(eq(github_connect_state.state_sha256, sha(query.state)))
              .get()
          : undefined
        if (
          !row ||
          row.used_at ||
          row.expires_at.getTime() < Date.now() ||
          row.user_id !== principal.user_id
        ) {
          fail(
            'GITHUB_STATE_INVALID',
            'The state in the GitHub callback is unknown, used, expired or belongs to another session.',
            'Start again from /github/connect.',
          )
        }
        db.update(github_connect_state)
          .set({
            used_at: new Date(),
          })
          .where(eq(github_connect_state.state_sha256, row!.state_sha256))
          .run()
        const conversion = (
          await gh<Conversion>(`/app-manifests/${encodeURIComponent(query.code)}/conversions`, {
            method: 'POST',
          })
        ).data
        const owner = conversion.owner.login.toLowerCase()
        if (db.select().from(github_app).where(eq(github_app.owner, owner)).get())
          fail(
            'NAME_TAKEN',
            `A GitHub App for ${owner} is already connected.`,
            'Disconnect it first, or install the existing App.',
          )
        const id = newId('github_app')
        const pem = github.seal(id, 'private_key', conversion.pem)
        const clientSecret = github.seal(id, 'client_secret', conversion.client_secret)
        const webhookSecret =
          row!.webhooks && conversion.webhook_secret
            ? github.seal(id, 'webhook_secret', conversion.webhook_secret)
            : null
        db.insert(github_app)
          .values({
            id,
            app_id: conversion.id,
            slug: conversion.slug,
            client_id: conversion.client_id,
            owner,
            webhooks: row!.webhooks && conversion.webhook_secret !== null,
            private_key: pem.ciphertext,
            client_secret: clientSecret.ciphertext,
            webhook_secret: webhookSecret?.ciphertext ?? null,
            data_key_id: pem.data_key_id,
          })
          .run()
        const app = db.select().from(github_app).where(eq(github_app.id, id)).get()!
        if (app.webhooks)
          await gh('/app/hook/config', {
            method: 'PATCH',
            token: github.jwtFor(app),
            body: {
              url: `${auth.surface.apiOrigin}/github/webhook/${app.app_id}`,
              content_type: 'json',
            },
          })
        audit(
          db,
          {
            principal,
            request_id: `github_${app.app_id}`,
            idempotency_key: null,
          },
          'github.app.connect',
          {
            entity: 'github_app',
            id,
          },
          {
            after: {
              app_id: app.app_id,
              slug: app.slug,
              owner,
              webhooks: app.webhooks,
            },
          },
        )
        set.status = 302
        set.headers.location = github.installUrl(app)
        return ''
      },
      {
        operation: {
          id: 'finish_github_connect',
          level: 'instance admin',
          mcp: false,
        },
        query: t.Object({
          code: t.String({
            minLength: 1,
          }),
          state: t.String({
            minLength: 1,
          }),
        }),
        detail: {
          hide: true,
        },
      },
    )
    .get(
      '/github/setup',
      async ({ request, query, set }) => {
        const principal = await human(request, 'Installing a GitHub App')
        const installationId = Number(query.installation_id)
        for (const app of db.select().from(github_app).all()) {
          try {
            const data = (
              await gh<InstallationData>(`/app/installations/${installationId}`, {
                token: github.jwtFor(app),
              })
            ).data
            const row = github.upsertInstallation(app, data)
            audit(
              db,
              {
                principal,
                request_id: `github_${installationId}`,
                idempotency_key: null,
              },
              'github.installation.verify',
              {
                entity: 'github_installation',
                id: row.id,
              },
              {
                after: {
                  installation_id: installationId,
                  account: row.account,
                  setup_action: query.setup_action ?? null,
                },
              },
            )
            set.status = 302
            set.headers.location = `${dashboardOrigin(request)}/github?installation=${row.id}`
            return ''
          } catch (error) {
            if (error instanceof GitHubError && error.status === 404) continue
            throw error
          }
        }
        return fail(
          'NOT_FOUND',
          `No connected GitHub App owns installation ${query.installation_id}.`,
          'Install the App from its install_url in GET /v1/github.',
        )
      },
      {
        operation: {
          id: 'verify_github_installation',
          level: 'instance admin',
          mcp: false,
        },
        query: t.Object({
          installation_id: t.String({
            pattern: '^[0-9]+$',
          }),
          setup_action: t.Optional(t.String()),
        }),
        detail: {
          hide: true,
        },
      },
    )
    .post('/github/webhook/:app', ({ params, request }) => github.receive(params.app, request), {
      operation: {
        id: 'receive_github_webhook',
        level: 'public',
        mcp: false,
      },
      parse: 'none',
      params: t.Object({
        app: t.String(),
      }),
      detail: {
        hide: true,
      },
    })
    .get('/v1/github', () => github.connection(), {
      operation: {
        id: 'get_github_connection',
        level: 'instance read',
      },
      response: replies({
        200: Connection,
      }),
      detail: {
        summary:
          'GitHub Apps, their installations, and the links a human opens to connect or install',
        tags,
      },
    })
    .post(
      '/v1/github/installations/sync',
      async () => {
        const apps = db.select().from(github_app).all()
        if (!apps.length)
          fail(
            'GITHUB_NOT_CONNECTED',
            'No GitHub App is connected.',
            `A human opens ${github.connectUrl()} to connect one.`,
          )
        const items = []
        for (const app of apps) items.push(...(await github.syncInstallations(app)))
        return {
          items: items.map((i) => ({
            id: i.id,
            installation_id: i.installation_id,
            account: i.account,
            repository_selection: i.repository_selection,
            suspended_at: i.suspended_at?.toISOString() ?? null,
          })),
        }
      },
      {
        operation: {
          id: 'sync_github_installations',
          level: 'instance admin',
        },
        response: replies({
          200: Installations,
        }),
        detail: {
          summary: 'Re-read every installation from GitHub',
          tags,
        },
      },
    )
    .get(
      '/v1/github/installations/:id/repositories',
      async ({ params }) => {
        const row = db
          .select()
          .from(github_installation)
          .where(eq(github_installation.id, params.id))
          .get()
        if (!row) fail('GITHUB_NOT_CONNECTED', `Installation ${params.id} is not connected.`)
        const app = db.select().from(github_app).where(eq(github_app.id, row!.github_app_id)).get()!
        const token = await github.installationToken(app, row!.installation_id, null, {
          metadata: 'read',
        })
        const data = (
          await gh<{
            repositories: { full_name: string; private: boolean; default_branch: string }[]
          }>('/installation/repositories?per_page=100', {
            token,
          })
        ).data
        return {
          items: data.repositories.map((r) => ({
            full_name: r.full_name,
            private: r.private,
            default_branch: r.default_branch,
          })),
        }
      },
      {
        operation: {
          id: 'list_github_repositories',
          level: 'instance read',
        },
        params: t.Object({
          id: t.String(),
        }),
        response: replies({
          200: Repositories,
        }),
        detail: {
          summary: 'Repositories an installation covers',
          tags,
        },
      },
    )
    .delete(
      '/v1/github/apps/:id',
      async ({ request, params }) => {
        const principal = await human(request, 'Disconnecting a GitHub App')
        const app =
          db.select().from(github_app).where(eq(github_app.id, params.id)).get() ??
          fail('NOT_FOUND', `GitHub App ${params.id} is not connected.`)
        db.transaction((tx) => {
          tx.delete(github_installation).where(eq(github_installation.github_app_id, app.id)).run()
          tx.delete(github_delivery).where(eq(github_delivery.github_app_id, app.id)).run()
          tx.delete(github_app).where(eq(github_app.id, app.id)).run()
        })
        audit(
          db,
          {
            principal,
            request_id: `github_${app.app_id}`,
            idempotency_key: null,
          },
          'github.app.disconnect',
          {
            entity: 'github_app',
            id: app.id,
          },
          {
            before: {
              app_id: app.app_id,
              owner: app.owner,
            },
          },
        )
        return {
          disconnected: true as const,
        }
      },
      {
        operation: {
          id: 'disconnect_github_app',
          level: 'instance admin',
          mcp: false,
        },
        params: t.Object({
          id: t.String(),
        }),
        response: replies({
          200: Disconnected,
        }),
        detail: {
          summary: 'Disconnect a GitHub App (human only)',
          tags,
        },
      },
    )
}
