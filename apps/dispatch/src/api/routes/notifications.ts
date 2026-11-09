import { randomBytes } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import { Nullable, StringEnum } from '@stationly/protocol'
import { Type } from '@sinclair/typebox'
import { Elysia, t } from 'elysia'
import { newId } from '../../db/ids.ts'
import { notification_channel } from '../../db/schema.ts'
import { post, sealSecret } from '../../notify/webhooks.ts'
import { requireInstance } from '../access.ts'
import { audit } from '../context.ts'
import { fail, invalid, notFound } from '../errors.ts'
import { project as select } from '../fields.ts'
import type { Kit } from '../kit.ts'
import { before, collect, getQuery, listQuery } from '../pagination.ts'
import { Deleted, extend, models, NotificationChannel, Page, replies } from '../shapes.ts'

const CreatedChannel = extend(NotificationChannel, { secret: Type.Optional(Type.String()) })
const TestResult = Type.Object(
  { delivered: Type.Boolean(), status_code: Nullable(Type.Integer()), duration_ms: Type.Integer(), error: Type.Optional(Nullable(Type.String())), status: StringEnum(['active', 'failing']) },
  { additionalProperties: false }
)

const Filter = t.Object({ types: t.Optional(t.Array(t.String({ minLength: 1 }))), projects: t.Optional(t.Array(t.String({ minLength: 1 }))) }, { additionalProperties: false })
const WebhookConfig = t.Object({ url: t.String({ minLength: 1 }), secret: t.Optional(t.String({ minLength: 16 })) }, { additionalProperties: false })

type ChannelStatus = (typeof notification_channel.$inferSelect)['status']

const checkUrl = (url: string) => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return invalid([{ path: '/config/url', message: 'not a URL' }])
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') invalid([{ path: '/config/url', message: 'must be http or https' }])
  return parsed.toString()
}

export const notificationRoutes = (kit: Kit) => {
  const { db, keyring } = kit.deps
  const tags = ['notifications']
  const rowOf = (id: string) => db.select().from(notification_channel).where(eq(notification_channel.id, id)).get() ?? notFound('notification_channel', id)

  return new Elysia({ prefix: '/v1', normalize: false }).use(models())
    .get(
      '/notification-channels',
      async ({ request, query }) => {
        requireInstance(await kit.principal(request), 'admin')
        const page = collect(
          (cursor, size) =>
            db
              .select()
              .from(notification_channel)
              .where(
                and(
                  query.kind ? eq(notification_channel.kind, query.kind as 'webhook') : undefined,
                  query.status ? eq(notification_channel.status, query.status as ChannelStatus) : undefined,
                  before(notification_channel.id, cursor)
                )
              )
              .orderBy(desc(notification_channel.id))
              .limit(size)
              .all(),
          query
        )
        return { items: page.rows.map(row => select(kit.views.channel, row, kit.fields(query.fields))), next_cursor: page.next_cursor }
      },
      { query: t.Object({ ...listQuery, kind: t.Optional(t.String()), status: t.Optional(t.String()) }), response: replies({ 200: Page(NotificationChannel) }), detail: { summary: 'List notification channels', tags } }
    )
    .get(
      '/notification-channels/:id',
      async ({ request, params, query }) => {
        requireInstance(await kit.principal(request), 'admin')
        return select(kit.views.channel, rowOf(params.id), kit.fields(query.fields))
      },
      { params: t.Object({ id: t.String() }), query: t.Object(getQuery), response: replies({ 200: NotificationChannel }), detail: { summary: 'Get a notification channel', tags } }
    )
    .post(
      '/notification-channels',
      async ({ request, body, set }) => {
        const call = await kit.call(request)
        requireInstance(call.principal, 'admin')
        if (body.kind !== 'webhook') fail('VALIDATION_FAILED', `${body.kind} channels ship in 1b; 1a delivers webhooks.`, undefined, { issues: [{ path: '/kind', message: 'only webhook in 1a' }] })
        const id = newId('notification_channel')
        const url = checkUrl(body.config.url)
        const secret = body.config.secret ?? randomBytes(32).toString('base64url')
        db.insert(notification_channel)
          .values({ id, kind: 'webhook', config: { url, secret: sealSecret(keyring, id, secret) }, filter: body.filter ?? {} })
          .run()
        audit(db, call, 'notification_channel.create', { entity: 'notification_channel', id }, { after: { kind: 'webhook', url, filter: body.filter ?? {} } })
        set.status = 201
        return { ...select(kit.views.channel, rowOf(id), kit.fields('config')), ...(body.config.secret ? {} : { secret }) }
      },
      {
        body: t.Object({ kind: t.String(), config: WebhookConfig, filter: t.Optional(Filter) }, { additionalProperties: false }),
        response: replies({ 201: CreatedChannel }),
        detail: { summary: 'Add a webhook channel; a generated secret is returned once', tags }
      }
    )
    .patch(
      '/notification-channels/:id',
      async ({ request, params, body }) => {
        const call = await kit.call(request)
        requireInstance(call.principal, 'admin')
        const row = rowOf(params.id)
        const config = { ...row.config }
        if (body.config?.url) config.url = checkUrl(body.config.url)
        if (body.config?.secret) config.secret = sealSecret(keyring, row.id, body.config.secret)
        db.update(notification_channel)
          .set({ config, ...(body.filter ? { filter: body.filter } : {}) })
          .where(eq(notification_channel.id, row.id))
          .run()
        audit(db, call, 'notification_channel.update', { entity: 'notification_channel', id: row.id }, { before: { url: row.config.url, filter: row.filter }, after: { url: config.url, filter: body.filter ?? row.filter, secret_changed: Boolean(body.config?.secret) } })
        return select(kit.views.channel, rowOf(row.id), kit.fields('config'))
      },
      {
        params: t.Object({ id: t.String() }),
        body: t.Object({ config: t.Optional(t.Partial(WebhookConfig)), filter: t.Optional(Filter) }, { additionalProperties: false }),
        response: replies({ 200: NotificationChannel }),
        detail: { summary: 'Change a channel URL, secret or filter', tags }
      }
    )
    .delete(
      '/notification-channels/:id',
      async ({ request, params }) => {
        const call = await kit.call(request)
        requireInstance(call.principal, 'admin')
        const row = rowOf(params.id)
        db.delete(notification_channel).where(eq(notification_channel.id, row.id)).run()
        audit(db, call, 'notification_channel.delete', { entity: 'notification_channel', id: row.id }, { before: { url: row.config.url } })
        return { deleted: true as const }
      },
      { params: t.Object({ id: t.String() }), response: replies({ 200: Deleted }), detail: { summary: 'Remove a notification channel', tags } }
    )
    .post(
      '/notification-channels/:id/test',
      async ({ request, params }) => {
        const call = await kit.call(request)
        requireInstance(call.principal, 'admin')
        const row = rowOf(params.id)
        const testId = newId('event')
        const body = JSON.stringify({ id: testId, type: 'notification.test', subject: { entity: 'notification_channel', id: row.id }, payload: { test: true, actor: call.principal.actor }, created_at: new Date().toISOString() })
        const result = await post(keyring, row, 'notification.test', `${testId}.${row.id}`, body)
        if (result.ok && row.status === 'failing') db.update(notification_channel).set({ status: 'active', failing_since: null }).where(eq(notification_channel.id, row.id)).run()
        audit(db, call, 'notification_channel.test', { entity: 'notification_channel', id: row.id }, { after: { delivered: result.ok, status_code: result.status_code } })
        return { delivered: result.ok, status_code: result.status_code, duration_ms: result.duration_ms, ...(result.ok ? {} : { error: result.error }), status: rowOf(row.id).status }
      },
      { params: t.Object({ id: t.String() }), response: replies({ 200: TestResult }), detail: { summary: 'Send a test delivery; success returns a failing channel to active', tags } }
    )
}
