import { Type } from '@sinclair/typebox'

import type { Kit } from '../kit.ts'
import { Actor, replies, Scope } from '../shapes.ts'

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
  kit.router('identity', '/v1').get(
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
        summary: 'The caller: actor, human flag, token kind, scopes and expiry',
        level: 'any',
        mcp: {
          always_load: true,
        },
      },
      response: replies({
        200: Me,
      }),
    },
  )
