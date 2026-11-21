import { and, eq } from 'drizzle-orm'

import type { MessageBody } from '@stationly/protocol'

import type { Db } from '../db/client.ts'
import { machine, task } from '../db/schema.ts'
import { emitEvent } from '../station/events.ts'
import { membersOf, touchMemberKey } from '../team/keys.ts'

type CredentialUse = NonNullable<MessageBody<'heartbeat'>['credentials']>[number]

const keyOf = (placeholders: Record<string, string> | null | undefined, placeholder: string) =>
  Object.entries(placeholders ?? {}).find(([, value]) => value === placeholder)?.[0]

const credentialOwner = (db: Db, box: typeof machine.$inferSelect, placeholder: string) => {
  if (box.workspace?.kind === 'project') {
    for (const member of membersOf(db, box.id)) {
      const key = keyOf(member.key_placeholders, placeholder)

      if (key) {
        return {
          key,
          user_id: member.user_id,
        }
      }
    }

    return null
  }

  const key = keyOf(box.workspace?.credential_placeholders, placeholder)
  const owner = db
    .select({
      owner: task.owner,
    })
    .from(task)
    .where(and(eq(task.machine_id, box.id), eq(task.isolated, true)))
    .get()?.owner.id

  return key
    ? {
        key,
        user_id: owner ?? null,
      }
    : null
}

export const noteCredentialUse = (
  db: Db,
  stationId: string,
  use: CredentialUse,
  now = new Date(),
) => {
  const box = db.select().from(machine).where(eq(machine.id, use.sandbox_id)).get()

  if (!box || box.server_id !== stationId) {
    return
  }

  const found = credentialOwner(db, box, use.placeholder)

  if (!found) {
    return
  }

  if (use.used > 0 && found.user_id) {
    touchMemberKey(db, found.user_id, found.key, now)
  }

  if (use.misdirected > 0) {
    emitEvent(
      db,
      'credential.misdirected',
      {
        entity: 'machine',
        id: box.id,
      },
      {
        key: found.key,
        count: use.misdirected,
      },
    )
  }
}
