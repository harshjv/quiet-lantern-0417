import { Type } from '@sinclair/typebox'
import { Elysia } from 'elysia'

import type { Kit } from '../kit.ts'
import { Actor, models, replies, Scope } from '../shapes.ts'

const Me = Type.Object(
  {
    actor: Actor,
    human: Type.Boolean(),
    token_kind: Type.String(),
    scopes: Type.Array(Scope),
    expires_at: Type.String(),
  },
  {
    additionalProperties: false,
  },
)

export const meRoutes = (kit: Kit) =>
  new Elysia({
    prefix: '/v1',
    normalize: false,
  })
    .use(models())
    .use(kit.operations)
    .get(
      '/me',
      async ({ request }) => {
        const principal = await kit.principal(request)
        return {
          actor: principal.actor,
          human: principal.human,
          token_kind: principal.token_kind,
          scopes: principal.scopes,
          expires_at: principal.expires_at.toISOString(),
        }
      },
      {
        operation: {
          id: 'whoami',
          level: 'any',
          mcp: {
            always_load: true,
          },
        },
        response: replies({
          200: Me,
        }),
        detail: {
          summary: 'The caller: actor, human flag, token kind, scopes and expiry',
          tags: ['identity'],
        },
      },
    )
