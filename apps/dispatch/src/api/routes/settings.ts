import { Elysia, t } from 'elysia'
import { requireInstance } from '../access.ts'
import { audit } from '../context.ts'
import { commit } from '../changes.ts'
import type { Kit } from '../kit.ts'
import { listSettings, planSettings, readSetting, resetPasskeys } from '../settings.ts'
import { Nullable } from '@stationly/protocol'
import { Type } from '@sinclair/typebox'
import { Actor, models, Page, replies, Staged } from '../shapes.ts'

const Setting = Type.Object(
  { key: Type.String(), value: Type.Unknown(), frozen: Type.Boolean(), updated_by: Nullable(Actor), updated_at: Nullable(Type.String()) },
  { title: 'Setting', additionalProperties: false }
)

export const settingRoutes = (kit: Kit) => {
  const { db } = kit.deps
  const tags = ['settings']

  return new Elysia({ prefix: '/v1', normalize: false }).use(models())
    .get(
      '/settings',
      async ({ request, query }) => {
        requireInstance(await kit.principal(request), 'admin')
        return { items: listSettings(db, query.prefix), next_cursor: null }
      },
      { query: t.Object({ prefix: t.Optional(t.String()) }), response: replies({ 200: Page(Setting) }), detail: { summary: 'Read instance settings', tags } }
    )
    .patch(
      '/settings',
      async ({ request, body, query, set }) => {
        const call = await kit.call(request)
        requireInstance(call.principal, 'admin')
        const plan = planSettings(db, call.principal, body, query.reset_passkeys ?? false)
        if (plan.set.empty) return { items: listSettings(db, undefined).filter(s => plan.keys.includes(s.key)), next_cursor: null }
        const protect = Boolean(readSetting<boolean>(db, 'platform.protected')) && !call.principal.human
        const result = db.transaction(() => {
          const committed = commit(kit.deps, call, { environment: null, protect }, plan.set)
          if (committed.applied && plan.passkeyReset) {
            resetPasskeys(db)
            audit(db, call, 'auth.passkey_reset', { entity: 'setting', id: 'auth.passkey_rp_id' }, { after: { reason: 'rp id changed' } })
          }
          return committed
        })
        if (!result.applied) return kit.stagedBody(result, set)
        audit(db, call, 'settings.update', { entity: 'setting', id: plan.keys.join(',') }, { after: Object.fromEntries(plan.keys.map(key => [key, body[key] ?? readSetting(db, key)])) })
        if (plan.surface) kit.deps.auth.rebuild()
        return { items: listSettings(db, undefined).filter(s => plan.keys.includes(s.key)), next_cursor: null }
      },
      {
        body: t.Record(t.String(), t.Unknown()),
        query: t.Object({ reset_passkeys: t.Optional(t.BooleanString()) }),
        response: replies({ 200: Page(Setting), 202: Staged }),
        detail: { summary: 'Change instance settings, all or nothing; frozen keys refuse with SETTING_FROZEN', tags }
      }
    )
}
