import { eq } from 'drizzle-orm'

import {
  settingDefault,
  type ResolvedSetting,
  type SettingKey,
  type SettingValue,
} from '@stationly/protocol'

import type { Db } from './client.ts'
import { setting } from './schema.ts'

export const storedSetting = <K extends SettingKey>(db: Db, key: K) =>
  db.select().from(setting).where(eq(setting.key, key)).get()?.value as SettingValue<K> | undefined

export const readSetting = <K extends SettingKey>(db: Db, key: K) =>
  (storedSetting(db, key) ?? settingDefault(key)) as ResolvedSetting<K>

export const settingsSnapshot = (db: Db) => {
  const rows = new Map(
    db
      .select({
        key: setting.key,
        value: setting.value,
      })
      .from(setting)
      .all()
      .map((row) => [row.key, row.value]),
  )
  return <K extends SettingKey>(key: K) =>
    ((rows.get(key) as SettingValue<K> | undefined) ?? settingDefault(key)) as ResolvedSetting<K>
}

export const deleteSetting = (db: Db, key: SettingKey) =>
  db.delete(setting).where(eq(setting.key, key)).run()

export type SettingsSnapshot = ReturnType<typeof settingsSnapshot>

export const writeSetting = (
  db: Db,
  key: SettingKey,
  value: unknown,
  actor: (typeof setting.$inferInsert)['updated_by'],
) => {
  if (storedSetting(db, key) !== undefined)
    db.update(setting)
      .set({
        value,
        updated_by: actor,
      })
      .where(eq(setting.key, key))
      .run()
  else
    db.insert(setting)
      .values({
        key,
        value,
        updated_by: actor,
      })
      .run()
}
