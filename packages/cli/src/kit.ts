import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createApiClient, type ApiClient } from '@stationly/api-client'
import { currentInstance, normalizeInstance, readCredentials, type Credentials } from './config.ts'
import { DryRun, Exit, apiFailure, exitCodes, notLoggedIn, unreachable } from './errors.ts'
import { acrossOutageOnce } from './outage.ts'
import { proofFor } from './proof.ts'
import { need } from './prompt.ts'
import { version } from './version.ts'

export type Globals = {
  json?: boolean
  dryRun?: boolean
  instance?: string
  project?: string
  environment?: string
  service?: string
}

export type Context = { instance?: string; project?: string; environment?: string; service?: string }

export const userAgent = `sly/${version}`

export const tokenEnv = 'STATIONLY_TOKEN'
export const apiUrlEnv = 'STATIONLY_API_URL'

const contextPath = () => join(process.cwd(), '.stationly', 'context.json')

const readContext = async (): Promise<Context> => {
  try {
    return JSON.parse(await readFile(contextPath(), 'utf8')) as Context
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

export const writeContext = async (context: Context) => {
  await mkdir(join(process.cwd(), '.stationly'), { recursive: true })
  await writeFile(contextPath(), `${JSON.stringify(context, null, 2)}\n`)
  return contextPath()
}

const redactSealed = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactSealed)
  if (value === null || typeof value !== 'object') return value
  const object = value as Record<string, unknown>
  const redacted = Object.fromEntries(Object.entries(object).map(([k, v]) => [k, redactSealed(v)]))
  if (object.kind === 'sealed' && typeof object.value === 'string') redacted.value = `[sealed, ${object.value.length} characters, not shown]`
  return redacted
}

const describeRequest = (url: string, init: RequestInit | undefined) => {
  const headers = Object.fromEntries(new Headers(init?.headers).entries())
  if (headers.authorization) headers.authorization = 'Bearer [redacted]'
  if (headers.dpop) headers.dpop = '[redacted]'
  const body = typeof init?.body === 'string' ? (() => { try { return redactSealed(JSON.parse(init.body as string)) } catch { return init.body } })() : init?.body ?? null
  return { method: init?.method ?? 'GET', url, headers, body }
}

export type Selection = { project?: string; environment?: string; service?: string }

export type Run = {
  globals: Globals
  selection: Selection
  credentials: Credentials
  api: ApiClient
  get: <T = Record<string, unknown>>(path: string) => Promise<T>
  raw: (path: string, init?: RequestInit) => Promise<Response>
}

export const resolveInstance = async (globals: Globals) => {
  const context = await readContext()
  const chosen = globals.instance ?? (process.env[apiUrlEnv] || undefined) ?? context.instance ?? (await currentInstance())
  return { instance: chosen ? normalizeInstance(chosen) : null, context }
}

const envCredentials = (instance: string, token: string): Credentials => ({ instance, kind: 'token', token, token_id: null, expires_at: null, proof_key: null, mcp: {} })

export const connect = async (globals: Globals): Promise<Run> => {
  const { instance, context } = await resolveInstance(globals)
  const envToken = process.env[tokenEnv]
  if (envToken) {
    if (!instance) throw notLoggedIn(null, `Set ${apiUrlEnv} or pass --instance with ${tokenEnv}.`)
    return connectWith(globals, envCredentials(instance, envToken), context)
  }
  if (!instance) throw notLoggedIn(null)
  const credentials = await readCredentials(instance)
  if (!credentials) throw notLoggedIn(instance)
  return connectWith(globals, credentials, context)
}

export const proofHeaders = (credentials: Credentials, method: string, url: string): Record<string, string> =>
  credentials.kind === 'session' && credentials.proof_key ? { dpop: proofFor(credentials.proof_key, method, url, credentials.token) } : {}

export const credentialHeaders = (credentials: Credentials, method: string, url: string): Record<string, string> => ({
  authorization: `Bearer ${credentials.token}`,
  ...proofHeaders(credentials, method, url)
})

const mutating = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export const connectWith = (globals: Globals, credentials: Credentials, context: Context = {}): Run => {
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (globals.dryRun && method !== 'GET' && method !== 'HEAD') throw new DryRun(describeRequest(url, init))
    const attempt = async (idempotencyKey?: string) => {
      const headers = new Headers(init?.headers)
      for (const [name, value] of Object.entries(proofHeaders(credentials, method, url))) headers.set(name, value)
      if (idempotencyKey && !headers.has('idempotency-key')) headers.set('idempotency-key', idempotencyKey)
      try {
        return await fetch(input, { ...init, headers })
      } catch (error) {
        throw unreachable(credentials.instance, error)
      }
    }
    return mutating.has(method) ? acrossOutageOnce(attempt) : attempt()
  }) as typeof fetch
  const api = createApiClient(credentials.instance, { token: credentials.token, userAgent, fetcher })
  const get = async <T,>(path: string) => {
    const response = await fetcher(`${credentials.instance}${path}`, { headers: { authorization: `Bearer ${credentials.token}`, 'user-agent': userAgent } })
    if (!response.ok) throw apiFailure(response.status, await response.json().catch(() => null))
    return (await response.json()) as T
  }
  const raw = (path: string, init: RequestInit = {}) =>
    fetcher(`${credentials.instance}${path}`, { ...init, headers: { authorization: `Bearer ${credentials.token}`, 'user-agent': userAgent, ...(init.headers as Record<string, string> | undefined) } })
  return {
    globals,
    selection: { project: globals.project ?? context.project, environment: globals.environment ?? context.environment, service: globals.service ?? context.service },
    credentials,
    api,
    get,
    raw
  }
}

export type Sent = { status: number; data: unknown }

type EdenResult = { data: unknown; error: { status: unknown; value: unknown } | null; status: number }

export const send = async (call: Promise<EdenResult>): Promise<Sent> => {
  const result = await call
  const value = result.error?.value
  if (value instanceof Exit || value instanceof DryRun) throw value
  if (result.error) throw apiFailure(result.status, value)
  return { status: result.status, data: result.data }
}

export const body = async <T = Record<string, unknown>>(call: Promise<EdenResult>) => (await send(call)).data as T

const seg = encodeURIComponent

export const projectRef = async (run: Run) => need(run.selection.project, { what: 'Project', flag: '--project <id or name>' })

export const environmentId = async (run: Run, ref = run.selection.environment): Promise<string> => {
  if (ref?.startsWith('env_')) return ref
  const project = await projectRef(run)
  if (!ref) return (await run.get<{ default_environment_id: string }>(`/v1/projects/${seg(project)}`)).default_environment_id
  return (await run.get<{ id: string }>(`/v1/projects/${seg(project)}/environments/${seg(ref)}`)).id
}

export const serviceId = async (run: Run): Promise<string> => {
  const ref = await need(run.selection.service, { what: 'Service', flag: '--service <id or name>' })
  if (ref.startsWith('svc_')) return ref
  const project = await projectRef(run)
  const environment = await environmentId(run)
  return (await run.get<{ id: string }>(`/v1/projects/${seg(project)}/environments/${environment}/services/${seg(ref)}`)).id
}

export const portId = async (run: Run, service: string, port: number) => {
  const ports = await run.get<{ items: { id: string; port: number }[] }>(`/v1/services/${service}/ports`)
  const found = ports.items.find(p => p.port === port)
  if (!found) throw new Exit(exitCodes.api, { error: { code: 'NOT_FOUND', explanation: `The service has no port ${port}.`, fix: 'Run sly services describe to list its ports.' } })
  return found.id
}
