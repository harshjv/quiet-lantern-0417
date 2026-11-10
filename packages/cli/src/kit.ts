import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createApiClient, type ApiClient } from '@stationly/api-client'
import { idPrefixes, tokenLevelValues, type IdEntity } from '@stationly/protocol'

import { currentInstance, normalizeInstance, readCredentials, type Credentials } from './config.ts'
import { apiUrlEnv, env, tokenEnv, version } from './env.ts'
import { apiFailure, DryRun, Exit, notFound, notLoggedIn, unreachable } from './errors.ts'
import { acrossOutageOnce } from './outage.ts'
import { need } from './prompt.ts'
import { proofFor } from './proof.ts'

export type Globals = {
  json?: boolean
  dryRun?: boolean
  instance?: string
  project?: string
  environment?: string
  service?: string
}

export type Context = {
  instance?: string
  project?: string
  environment?: string
  service?: string
}

export const userAgent = `sly/${version}`

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
  await mkdir(join(process.cwd(), '.stationly'), {
    recursive: true,
  })
  await writeFile(contextPath(), `${JSON.stringify(context, null, 2)}\n`)
  return contextPath()
}

const redactSealed = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactSealed)
  if (value === null || typeof value !== 'object') return value
  const object = value as Record<string, unknown>
  const redacted = Object.fromEntries(Object.entries(object).map(([k, v]) => [k, redactSealed(v)]))
  if (object.kind === 'sealed' && typeof object.value === 'string')
    redacted.value = `[sealed, ${object.value.length} characters, not shown]`
  return redacted
}

const describeRequest = (url: string, init: RequestInit | undefined) => {
  const headers = Object.fromEntries(new Headers(init?.headers).entries())
  if (headers.authorization) headers.authorization = 'Bearer [redacted]'
  if (headers.dpop) headers.dpop = '[redacted]'
  const body =
    typeof init?.body === 'string'
      ? (() => {
          try {
            return redactSealed(JSON.parse(init.body))
          } catch {
            return init.body
          }
        })()
      : (init?.body ?? null)
  return {
    method: init?.method ?? 'GET',
    url,
    headers,
    body,
  }
}

export type Selection = { project?: string; environment?: string; service?: string }

export type Run = {
  globals: Globals
  selection: Selection
  credentials: Credentials
  userAgent: string
  api: ApiClient
}

export const resolveInstance = async (globals: Globals) => {
  const context = await readContext()
  const chosen = globals.instance ?? env[apiUrlEnv] ?? context.instance ?? (await currentInstance())
  return {
    instance: chosen ? normalizeInstance(chosen) : null,
    context,
  }
}

export const tokenCredentials = (instance: string, token: string): Credentials => ({
  instance,
  kind: 'token',
  token,
  token_id: null,
  expires_at: null,
  proof_key: null,
  mcp: {},
})

export const connect = async (globals: Globals): Promise<Run> => {
  const { instance, context } = await resolveInstance(globals)
  const envToken = env[tokenEnv]
  if (envToken) {
    if (!instance) throw notLoggedIn(null, `Set ${apiUrlEnv} or pass --instance with ${tokenEnv}.`)
    return connectWith(globals, tokenCredentials(instance, envToken), context)
  }
  if (!instance) throw notLoggedIn(null)
  const credentials = await readCredentials(instance)
  if (!credentials) throw notLoggedIn(instance)
  return connectWith(globals, credentials, context)
}

export const proofHeaders = (
  credentials: Credentials,
  method: string,
  url: string,
): Record<string, string> =>
  credentials.kind === 'session' && credentials.proof_key
    ? {
        dpop: proofFor(credentials.proof_key, method, url, credentials.token),
      }
    : {}

export const credentialHeaders = (
  credentials: Credentials,
  method: string,
  url: string,
): Record<string, string> => ({
  authorization: `Bearer ${credentials.token}`,
  ...proofHeaders(credentials, method, url),
})

const mutating = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

export const connectWith = (
  globals: Globals,
  credentials: Credentials,
  context: Context = {},
  agent = userAgent,
): Run => {
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (globals.dryRun && method !== 'GET' && method !== 'HEAD')
      throw new DryRun(describeRequest(url, init))
    const attempt = async (idempotencyKey?: string) => {
      const headers = new Headers(init?.headers)
      for (const [name, value] of Object.entries(proofHeaders(credentials, method, url)))
        headers.set(name, value)
      if (idempotencyKey && !headers.has('idempotency-key'))
        headers.set('idempotency-key', idempotencyKey)
      try {
        return await fetch(input, {
          ...init,
          headers,
        })
      } catch (error) {
        throw unreachable(credentials.instance, error)
      }
    }
    return mutating.has(method) ? acrossOutageOnce(attempt) : attempt()
  }) as typeof fetch
  return {
    globals,
    selection: {
      project: globals.project ?? context.project,
      environment: globals.environment ?? context.environment,
      service: globals.service ?? context.service,
    },
    credentials,
    userAgent: agent,
    api: createApiClient(credentials.instance, {
      token: credentials.token,
      userAgent: agent,
      fetcher,
    }),
  }
}

export type Api = ApiClient['v1']

export type Reply =
  | { data: unknown; error: null; status: number; response: Response }
  | { data: null; error: { status: unknown; value: unknown }; status: number; response: Response }

type Ok<R> = R extends { error: null; data: infer D } ? D : never

export type Data<F extends (...args: never[]) => Promise<Reply>> = Ok<Awaited<ReturnType<F>>>

export type Sent<T = unknown> = { status: number; data: T }

export const settle = async <R extends Reply>(call: Promise<R>) => {
  const result = await call
  const value = result.error?.value
  if (value instanceof Exit || value instanceof DryRun) throw value
  return result
}

const succeeded = async <R extends Reply>(call: Promise<R>) => {
  const result: Reply = await settle(call)
  if (result.error) throw apiFailure(result.status, result.error.value)
  return result
}

export const send = async <R extends Reply>(call: Promise<R>): Promise<Sent<Ok<R>>> => {
  const { status, data } = await succeeded(call)
  return {
    status,
    data: data as Ok<R>,
  }
}

export const stream = async (call: Promise<Reply>) => (await succeeded(call)).response

export const document = async (call: Promise<Reply>) => {
  const { data, response } = await succeeded(call)
  return typeof data === 'string' ? data : response.text()
}

export const sseHeaders = (lastId: string | null): Record<string, string> => ({
  accept: 'text/event-stream',
  ...(lastId
    ? {
        'last-event-id': lastId,
      }
    : {}),
})

export const isId = (entity: IdEntity, ref: string) => ref.startsWith(`${idPrefixes[entity]}_`)

export const isOneOf = <T extends string>(values: readonly T[], value: string): value is T =>
  (values as readonly string[]).includes(value)

export const isLevel = (value: string) => isOneOf(tokenLevelValues, value)

export const found = <T>(
  items: readonly T[],
  match: (item: T) => boolean,
  explanation: string,
  fix: string,
): T => {
  const item = items.find(match)
  if (item === undefined) throw notFound(explanation, fix)
  return item
}

const slugId = async (run: Run, ...segments: string[]) =>
  (
    await send(
      run.api.v1
        .projects({
          project: segments.map(encodeURIComponent).join('/'),
        })
        .get(),
    )
  ).data.id

export const projectRef = async (run: Run) =>
  need(run.selection.project, {
    what: 'Project',
    flag: '--project <id or name>',
  })

export const projectId = (run: Run, ref: string) => slugId(run, ref)

export const environmentId = async (run: Run, ref = run.selection.environment): Promise<string> => {
  if (ref && isId('environment', ref)) return ref
  const project = await projectRef(run)
  if (!ref)
    return (
      await send(
        run.api.v1
          .projects({
            project: encodeURIComponent(project),
          })
          .get(),
      )
    ).data.default_environment_id
  return slugId(run, project, 'environments', ref)
}

const inEnvironment = async (run: Run, collection: 'services' | 'sandboxes', ref: string) =>
  slugId(run, await projectRef(run), 'environments', await environmentId(run), collection, ref)

export const serviceId = async (run: Run): Promise<string> => {
  const ref = await need(run.selection.service, {
    what: 'Service',
    flag: '--service <id or name>',
  })
  return isId('service', ref) ? ref : inEnvironment(run, 'services', ref)
}

export const sandboxId = async (run: Run, ref: string) =>
  isId('sandbox', ref) ? ref : inEnvironment(run, 'sandboxes', ref)

export const portId = async (run: Run, service: string, port: number) =>
  found(
    (
      await send(
        run.api.v1
          .services({
            service,
          })
          .ports.get(),
      )
    ).data.items,
    (p) => p.port === port,
    `The service has no port ${port}.`,
    'Run sly services describe to list its ports.',
  ).id
