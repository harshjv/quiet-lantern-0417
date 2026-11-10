import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { env } from './env.ts'
import type { MachineKey } from './proof.ts'

export type McpClientToken = { token: string; token_id: string; expires_at: string }

export type Credentials = {
  instance: string
  kind: 'token' | 'session'
  token: string
  token_id: string | null
  expires_at: string | null
  proof_key: MachineKey | null
  mcp: Record<string, McpClientToken>
}

type Config = { current: string | null }

export const configDir = () => join(process.platform === 'win32' ? env.APPDATA : env.XDG_CONFIG_HOME, 'stationly')

const credentialsPath = (instance: string) => join(configDir(), 'credentials', `${new URL(instance).host.replace(/[^A-Za-z0-9.-]/g, '_')}.json`)

const configPath = () => join(configDir(), 'config.json')

const readJson = async <T>(path: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

const writePrivate = async (path: string, value: unknown) => {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
}

export const normalizeInstance = (instance: string) => {
  const url = new URL(instance)
  return `${url.protocol}//${url.host}`
}

export const currentInstance = async () => (await readJson<Config>(configPath()))?.current ?? null

export const readCredentials = (instance: string) => readJson<Credentials>(credentialsPath(instance))

export const saveCredentials = async (credentials: Credentials) => {
  await writePrivate(credentialsPath(credentials.instance), credentials)
  await writePrivate(configPath(), { current: credentials.instance } satisfies Config)
}

export const updateCredentials = (credentials: Credentials) => writePrivate(credentialsPath(credentials.instance), credentials)

export const removeCredentials = async (instance: string) => {
  await rm(credentialsPath(instance), { force: true })
  if ((await currentInstance()) === instance) await writePrivate(configPath(), { current: null } satisfies Config)
}
