import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

type Journal = { entries: { idx: number; when: number; tag: string }[] }

const folder = fileURLToPath(new URL('../../drizzle', import.meta.url))
const journal = JSON.parse(readFileSync(`${folder}/meta/_journal.json`, 'utf8')) as Journal
const databasePath = process.env.STATIONLY_DATABASE
if (!databasePath) throw new Error('STATIONLY_DATABASE must name the SQLite file to check')
if (!process.argv.includes('--check')) {
  console.error('usage: dispatch migrate --check')
  process.exit(2)
}

const destructive = (sql: string) => {
  const statements = sql.split('--> statement-breakpoint').map(s => s.trim())
  const rebuilt = new Set(statements.flatMap(s => [...s.matchAll(/ALTER TABLE `__new_([A-Za-z0-9_]+)` RENAME TO `\1`/gi)].map(m => m[1]!.toLowerCase())))
  return statements.filter(s => {
    if (/\bDROP\s+COLUMN\b/i.test(s) || /^\s*DELETE\s+FROM\b/i.test(s)) return true
    const dropped = /^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?`?([A-Za-z0-9_]+)`?/i.exec(s)
    return dropped !== null && !rebuilt.has(dropped[1]!.toLowerCase())
  })
}

const known = journal.entries.map(e => ({ tag: e.tag, when: e.when }))
let applied: { hash: string; created_at: number }[] = []
if (existsSync(databasePath)) {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true })
  const table = db.prepare("select name from sqlite_master where type = 'table' and name = '__drizzle_migrations'").get()
  if (table) applied = db.prepare('select hash, created_at from __drizzle_migrations order by created_at').all() as typeof applied
  db.close()
}
const last = applied.reduce((max, a) => Math.max(max, Number(a.created_at)), 0)
const whens = new Set(known.map(k => k.when))
const pending = known.filter(k => k.when > last)
const unknownApplied = applied.filter(a => !whens.has(Number(a.created_at)))
const prefix = unknownApplied.length === 0 && applied.every((a, i) => known[i]?.when === Number(a.created_at))
const irreversible = pending.filter(p => destructive(readFileSync(`${folder}/${p.tag}.sql`, 'utf8')).length > 0).map(p => p.tag)
console.log(
  JSON.stringify({
    known: known.map(k => k.tag),
    applied: applied.map(a => known.find(k => k.when === Number(a.created_at))?.tag ?? `unknown@${a.created_at}`),
    pending: pending.map(p => p.tag),
    unknown_applied: unknownApplied.map(a => `unknown@${a.created_at}`),
    irreversible,
    prefix
  })
)
