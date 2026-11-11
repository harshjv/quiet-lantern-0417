import { randomUUID } from 'node:crypto'

import ky, { isHTTPError, type KyInstance, type KyRequest, type NormalizedOptions } from 'ky'

import type { Credentials } from './config.ts'
import { DryRun, failureOf, isEnvelope, proxyStatuses } from './errors.ts'
import { progress } from './output.ts'
import { proofFor } from './proof.ts'

export type HttpOptions = {
  instance: string
  userAgent: string
  dryRun?: boolean
  credentials?: Credentials
  outageBudgetMs?: number
}

type Outage = { startedAt: number; deadline: number; retrying: boolean }

const oneShotOutageBudgetMs = 60_000
const firstDelayMs = 250
const maxDelayMs = 2_000
const mutatingMethods = ['post', 'put', 'patch', 'delete']
const readMethods = ['GET', 'HEAD']

export const credentialHeaders = async (
  credentials: Credentials,
  method: string,
  url: string,
): Promise<Record<string, string>> => ({
  authorization: `Bearer ${credentials.token}`,
  ...(credentials.kind === 'session' && credentials.proof_key
    ? {
        dpop: await proofFor(credentials.proof_key, method, url, credentials.token),
      }
    : {}),
})

const redactSealed = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(redactSealed)
  }

  if (value === null || typeof value !== 'object') {
    return value
  }

  const object = value as Record<string, unknown>
  const redacted = Object.fromEntries(Object.entries(object).map(([k, v]) => [k, redactSealed(v)]))

  if (object.kind === 'sealed' && typeof object.value === 'string') {
    redacted.value = `[sealed, ${object.value.length} characters, not shown]`
  }

  return redacted
}

const bodyOf = async (request: Request) => {
  const text = await request.clone().text()

  if (text === '') {
    return null
  }

  try {
    return redactSealed(JSON.parse(text))
  } catch {
    return text
  }
}

const describeRequest = async (request: Request) => {
  const headers = Object.fromEntries(request.headers.entries())

  if (headers.authorization) {
    headers.authorization = 'Bearer [redacted]'
  }

  if (headers.dpop) {
    headers.dpop = '[redacted]'
  }

  return {
    method: request.method,
    url: request.url,
    headers,
    body: await bodyOf(request),
  }
}

const outageOf = (options: Readonly<NormalizedOptions>) => options.context.outage as Outage

const secondsSince = (since: number) => ((Date.now() - since) / 1000).toFixed(1)

export const createHttp = ({
  instance,
  userAgent,
  dryRun = false,
  credentials,
  outageBudgetMs = oneShotOutageBudgetMs,
}: HttpOptions): KyInstance => {
  const sign = async ({ request }: { request: KyRequest }) => {
    if (!credentials) {
      return
    }

    for (const [name, value] of Object.entries(
      await credentialHeaders(credentials, request.method, request.url),
    )) {
      request.headers.set(name, value)
    }
  }

  return ky.create({
    baseUrl: instance,
    headers: {
      'user-agent': userAgent,
    },
    timeout: false,
    retry: {
      limit: Number.MAX_SAFE_INTEGER,
      methods: mutatingMethods,
      statusCodes: proxyStatuses,
      afterStatusCodes: [],
      delay: (attempt) => firstDelayMs * 2 ** (attempt - 1),
      backoffLimit: maxDelayMs,
      shouldRetry: ({ error }) =>
        isHTTPError(error) && isEnvelope(error.data) ? false : undefined,
    },
    hooks: {
      init: [
        (options) => {
          const startedAt = Date.now()
          const waitDeadline = options.context?.waitDeadline as number | undefined

          options.context = {
            ...options.context,
            outage: {
              startedAt,
              deadline: waitDeadline ?? startedAt + outageBudgetMs,
              retrying: false,
            } satisfies Outage,
          }
        },
      ],
      beforeRequest: [
        sign,
        async ({ request }) => {
          if (dryRun && !readMethods.includes(request.method)) {
            throw new DryRun(await describeRequest(request))
          }
        },
        ({ request }) => {
          const mutating = mutatingMethods.includes(request.method.toLowerCase())

          if (mutating && !request.headers.has('idempotency-key')) {
            request.headers.set('idempotency-key', randomUUID())
          }
        },
      ],
      beforeRetry: [
        async ({ request, options, error }) => {
          const outage = outageOf(options)
          const { deadline } = outage

          if (Date.now() >= deadline) {
            throw error
          }

          if (!outage.retrying) {
            outage.retrying = true
            progress(
              `${failureOf(instance, error).message} Retrying until ${new Date(deadline).toISOString()}.`,
            )
          }

          await sign({
            request,
          })
        },
      ],
      afterResponse: [
        ({ options, response }) => {
          const outage = outageOf(options)

          if (!outage.retrying || proxyStatuses.includes(response.status)) {
            return
          }

          progress(`Dispatch is reachable again after ${secondsSince(outage.startedAt)} s`)
          outage.retrying = false
        },
      ],
      beforeError: [({ error }) => failureOf(instance, error)],
    },
  })
}

export const waitingHttp = (http: KyInstance, deadline?: number) =>
  http.extend({
    retry: {
      methods: ['get'],
    },
    context: {
      waitDeadline: deadline,
    },
  })
