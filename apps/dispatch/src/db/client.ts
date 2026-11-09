import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from './schema.ts'

export type Db = BetterSQLite3Database<typeof schema>

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url))

export const replicatedFromEnv = () => process.env.STATIONLY_LITESTREAM === '1'

export const openDb = (path: string, options: { replicated?: boolean } = {}) => {
  const sqlite = new Database(path)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('busy_timeout = 5000')
  sqlite.pragma(`wal_autocheckpoint = ${options.replicated ? 0 : 1000}`)
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder })
  return db
}
