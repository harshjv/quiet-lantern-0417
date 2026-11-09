import { argon2Sync, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import type { Db } from '../db/client.ts'
import { data_key, master_key_wrap } from '../db/schema.ts'
import { newId } from '../db/ids.ts'
import { SecretsError } from './errors.ts'

const keyBytes = 32
const nonceBytes = 12
const tagBytes = 16

export const masterKeyEnv = 'STATIONLY_MASTER_KEY'

export const passwordKdf = { algorithm: 'argon2id', memory: 65536, passes: 3, parallelism: 4 } as const

export const parseMasterKey = (encoded: string | undefined) => {
  if (!encoded) throw new SecretsError('MASTER_KEY_MISMATCH', `${masterKeyEnv} is not set; stationd passes the master key from host.toml`)
  const key = Buffer.from(encoded, 'base64url')
  if (key.length !== keyBytes) throw new SecretsError('MASTER_KEY_MISMATCH', `${masterKeyEnv} must be ${keyBytes} bytes in base64url, got ${key.length}`)
  return key
}

export const masterKeyFromEnv = () => parseMasterKey(process.env[masterKeyEnv])

export const seal = (key: Buffer, plaintext: Buffer, aad: string) => {
  const nonce = randomBytes(nonceBytes)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: tagBytes })
  cipher.setAAD(Buffer.from(aad, 'utf8'))
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([nonce, cipher.getAuthTag(), body])
}

export const valueBytes = (sealed: Buffer) => sealed.length - nonceBytes - tagBytes

export const open = (key: Buffer, sealed: Buffer, aad: string) => {
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, nonceBytes), { authTagLength: tagBytes })
  decipher.setAAD(Buffer.from(aad, 'utf8'))
  decipher.setAuthTag(sealed.subarray(nonceBytes, nonceBytes + tagBytes))
  return Buffer.concat([decipher.update(sealed.subarray(nonceBytes + tagBytes)), decipher.final()])
}

export class Keyring {
  private readonly keys = new Map<string, Buffer>()
  private readonly db: Db
  private readonly masterKey: Buffer

  constructor(db: Db, masterKey: Buffer) {
    this.db = db
    this.masterKey = masterKey
    for (const row of db.select().from(data_key).all()) this.unwrap(row)
  }

  private unwrap(row: { id: string; wrapped: Buffer }) {
    try {
      const key = open(this.masterKey, row.wrapped, row.id)
      this.keys.set(row.id, key)
      return key
    } catch {
      throw new SecretsError('MASTER_KEY_MISMATCH', `data key ${row.id} does not unwrap under the master key Dispatch runs with`)
    }
  }

  private key(id: string) {
    const known = this.keys.get(id)
    if (known) return known
    const row = this.db.select().from(data_key).where(eq(data_key.id, id)).get()
    return row ? this.unwrap(row) : undefined
  }

  activeKey() {
    const newest = this.db.select({ id: data_key.id }).from(data_key).orderBy(desc(data_key.created_at), desc(data_key.id)).limit(1).get()
    if (newest) return { id: newest.id, key: this.key(newest.id)! }
    return this.rotateDataKey()
  }

  rotateDataKey() {
    const id = newId('data_key')
    const key = randomBytes(keyBytes)
    this.db.insert(data_key).values({ id, wrapped: seal(this.masterKey, key, id) }).run()
    this.keys.set(id, key)
    return { id, key }
  }

  encrypt(secretValueId: string, plaintext: string) {
    const { id, key } = this.activeKey()
    return { data_key_id: id, ciphertext: seal(key, Buffer.from(plaintext, 'utf8'), secretValueId) }
  }

  decrypt(secretValueId: string, dataKeyId: string, ciphertext: Buffer) {
    const key = this.key(dataKeyId)
    if (!key) throw new SecretsError('SECRETS_NEED_REENTRY', `data key ${dataKeyId} is unknown`, { secret_value_id: secretValueId })
    return open(key, ciphertext, secretValueId).toString('utf8')
  }

  wrapForPassword(userId: string, password: string) {
    const salt = randomBytes(16)
    const kek = deriveKek(password, salt)
    const kdf = { ...passwordKdf, salt: salt.toString('base64url') }
    const wrapped = seal(kek, this.masterKey, `master_key_wrap:${userId}`)
    const existing = this.db.select({ id: master_key_wrap.id }).from(master_key_wrap).where(eq(master_key_wrap.user_id, userId)).get()
    if (existing) {
      this.db.update(master_key_wrap).set({ kdf, wrapped, wrapped_next: null }).where(eq(master_key_wrap.id, existing.id)).run()
      return existing.id
    }
    const id = newId('master_key_wrap')
    this.db.insert(master_key_wrap).values({ id, user_id: userId, kdf, wrapped }).run()
    return id
  }
}

const deriveKek = (password: string, salt: Buffer) =>
  argon2Sync(passwordKdf.algorithm, {
    message: password,
    nonce: salt,
    memory: passwordKdf.memory,
    passes: passwordKdf.passes,
    parallelism: passwordKdf.parallelism,
    tagLength: keyBytes
  })

export const unwrapWithPassword = (db: Db, userId: string, password: string) => {
  const row = db.select().from(master_key_wrap).where(eq(master_key_wrap.user_id, userId)).get()
  if (!row) throw new SecretsError('MASTER_KEY_MISMATCH', `no password wrap of the master key exists for ${userId}`)
  const kek = argon2Sync(row.kdf.algorithm, {
    message: password,
    nonce: Buffer.from(row.kdf.salt, 'base64url'),
    memory: row.kdf.memory,
    passes: row.kdf.passes,
    parallelism: row.kdf.parallelism,
    tagLength: keyBytes
  })
  try {
    return open(kek, row.wrapped, `master_key_wrap:${userId}`)
  } catch {
    throw new SecretsError('MASTER_KEY_MISMATCH', 'the password does not unwrap the master key')
  }
}

export const sameKey = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b)
