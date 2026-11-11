import { lt, type SQL } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import { t } from 'elysia'

import { fail } from './errors.ts'

export const defaultLimit = 50
export const maxLimit = 200

export const getQuery = {
  fields: t.Optional(
    t.String({
      description: 'Fields to add to the summary, comma separated: a,b,c.d, or * for every field',
    }),
  ),
}

export const listQuery = {
  limit: t.Optional(
    t.Numeric({
      minimum: 1,
      maximum: maxLimit,
      description: `Items per page (default ${defaultLimit}, at most ${maxLimit})`,
    }),
  ),
  cursor: t.Optional(
    t.String({
      description: 'The next_cursor of the previous page',
    }),
  ),
  ...getQuery,
}

const timeFormat = 'an RFC 3339 time, or a duration back from now such as 15m or 24h'

export const since = t.Optional(
  t.String({
    description: `From this time on: ${timeFormat}`,
  }),
)

export const until = t.Optional(
  t.String({
    description: `Up to this time: ${timeFormat}`,
  }),
)

export const filterOne = (values: readonly string[]) =>
  t.Optional(
    t.String({
      description: `One of ${values.join(', ')}`,
    }),
  )

export const filterMany = (values: readonly string[]) =>
  t.Optional(
    t.String({
      description: `One or more of ${values.join(', ')}, comma separated`,
    }),
  )

const encode = (id: string) => Buffer.from(id, 'utf8').toString('base64url')

const decode = (cursor: string) => {
  const id = Buffer.from(cursor, 'base64url').toString('utf8')

  if (!/^[a-z]{2,4}_[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) {
    fail('VALIDATION_FAILED', 'cursor is not a cursor this API returned.', undefined, {
      issues: [
        {
          path: '/cursor',
          message: 'unknown cursor',
        },
      ],
    })
  }

  return id
}

export const before = (column: SQLiteColumn, cursor: string | undefined): SQL | undefined =>
  cursor ? lt(column, decode(cursor)) : undefined

export const collect = <T extends { id: string }>(
  fetch: (cursor: string | undefined, size: number) => T[],
  options: { limit?: number; cursor?: string },
  keep: (row: T) => boolean = () => true,
) => {
  const limit = options.limit ?? defaultLimit
  const items: T[] = []
  let cursor = options.cursor ? encode(decode(options.cursor)) : undefined
  let exhausted = false

  while (items.length <= limit && !exhausted) {
    const batch = fetch(cursor, limit + 1)

    if (batch.length < limit + 1) {
      exhausted = true
    }

    for (const row of batch) {
      if (keep(row)) {
        items.push(row)
      }

      if (items.length > limit) {
        break
      }
    }

    const last = batch.at(-1)

    if (!last) {
      break
    }

    cursor = encode(last.id)
  }

  const more = items.length > limit
  const pageItems = items.slice(0, limit)

  return {
    rows: pageItems,
    next_cursor: more && pageItems.length > 0 ? encode(pageItems.at(-1)!.id) : null,
  }
}
