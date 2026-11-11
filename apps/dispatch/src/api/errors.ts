import { errorCatalog, type ErrorCode } from '@stationly/protocol'

import { DomainError } from '../errors.ts'

import { requestIdOf } from './context.ts'

const httpStatus = new Map<string, number>(
  errorCatalog.filter((e) => e.http !== null).map((e) => [e.code, e.http as number]),
)

export type ApiCode = ErrorCode | 'INTERNAL_ERROR'

const defaultFix: Partial<Record<ApiCode, string>> = {
  UNAUTHENTICATED:
    'Send Authorization: Bearer <token> with a valid Stationly token, or sign in again.',
  NOT_FOUND: 'Check the id or name; list the parent collection to find it.',
  VALIDATION_FAILED: 'Correct the fields listed in details.issues and send the request again.',
  NAME_TAKEN: 'Pick another name, or address the existing entity.',
  IDEMPOTENCY_MISMATCH: 'Use a new Idempotency-Key for a different request body.',
  WRONG_HOST:
    'Send API requests to the API hostname and dashboard requests to the dashboard hostname.',
  RATE_LIMITED: 'Wait for the time in Retry-After, then retry.',
  VARIABLE_REFERENCE_INVALID: 'Fix the reference syntax at details.offset.',
  VARIABLE_UNRESOLVED: 'Create the referenced variable or value, or send allow_unresolved = true.',
  VARIABLE_TARGET_MISSING: 'Create the referenced service, or correct the reference.',
  VARIABLE_NOT_GRANTED: 'Grant the global variable to this project first.',
  VARIABLE_CYCLE: 'Break the reference cycle listed in details.cycle.',
  VARIABLE_PROTECTED_SOURCE: 'Set a project default value or a value for this environment.',
  SEALED_VALUE_UNREADABLE: 'Sealed values are write-only; set a new value instead of reading it.',
  SECRETS_NEED_REENTRY: 'Re-enter the values listed in details.',
  STATION_OFFLINE: 'Wait for the station to reconnect, or place the service on an online station.',
  INTERNAL_ERROR: 'Retry; if it keeps failing, report the request_id.',
}

export class ApiError extends DomainError<ApiCode> {
  declare readonly fix: string
  readonly headers: Record<string, string>

  constructor(
    code: ApiCode,
    explanation: string,
    fix?: string,
    details: Record<string, unknown> = {},
    headers: Record<string, string> = {},
  ) {
    super(
      code,
      explanation,
      fix ?? defaultFix[code] ?? 'Read the explanation, correct the request and retry.',
      details,
    )
    this.headers = headers
  }

  get status() {
    return httpStatus.get(this.code) ?? 500
  }
}

export const fail = (
  code: ErrorCode,
  explanation: string,
  fix?: string,
  details?: Record<string, unknown>,
): never => {
  throw new ApiError(code, explanation, fix, details)
}

export const notFoundError = (entity: string, ref: string) =>
  new ApiError('NOT_FOUND', `${entity} ${ref} does not exist or is not visible to this credential.`)

export const notFound = (entity: string, ref: string): never => {
  throw notFoundError(entity, ref)
}

export const apiErrorOf = (error: unknown) =>
  error instanceof ApiError
    ? error
    : error instanceof DomainError
      ? new ApiError(error.code as ApiCode, error.message, error.fix, error.details)
      : undefined

export const failureOf = (error: Error) => {
  const known = apiErrorOf(error)

  return {
    code: known?.code ?? 'INTERNAL_ERROR',
    explanation: error.message,
    fix: known?.fix ?? null,
  }
}

export const issue = (path: string, message: string) => ({
  path,
  message,
})

export const invalid = (issues: { path: string; message: string }[]): never =>
  fail('VALIDATION_FAILED', issues.map((i) => `${i.path}: ${i.message}`).join('; '), undefined, {
    issues,
  })

export const envelope = (error: ApiError, requestId: string) => ({
  error: {
    code: error.code,
    explanation: error.message,
    fix: error.fix,
    ...(Object.keys(error.details).length > 0
      ? {
          details: error.details,
        }
      : {}),
    request_id: requestId,
  },
})

export const stamped = (request: Request, response: Response, version: string) => {
  response.headers.set('x-request-id', requestIdOf(request))
  response.headers.set('x-stationly-version', version)

  return response
}

export const refusal = (request: Request, error: ApiError, version: string) =>
  stamped(
    request,
    new Response(JSON.stringify(envelope(error, requestIdOf(request))), {
      status: error.status,
      headers: {
        'content-type': 'application/json',
      },
    }),
    version,
  )
