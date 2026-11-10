import type { ErrorCode } from '@stationly/protocol'
import { apiUrlEnv, tokenEnv } from './env.ts'

export type EnvelopeCode = ErrorCode | 'CONNECTION_FAILED'

export type Envelope = { error: { code: EnvelopeCode; explanation: string; fix?: string; details?: Record<string, unknown>; request_id?: string } }

export const exitCodes = { ok: 0, api: 1, usage: 2, staged: 3, deployFailed: 4, connection: 5, brokenPipe: 141 } as const

export class Exit extends Error {
  readonly code: number
  readonly envelope: Envelope | null

  constructor(code: number, envelope: Envelope | null = null) {
    super(envelope?.error.explanation ?? `exit ${code}`)
    this.code = code
    this.envelope = envelope
  }
}

export class DryRun extends Error {
  readonly request: Record<string, unknown>

  constructor(request: Record<string, unknown>) {
    super('dry run')
    this.request = request
  }
}

const envelopeOf = (code: EnvelopeCode, explanation: string, fix: string): Envelope => ({ error: { code, explanation, fix } })

export const inputRequired = (what: string, flag: string) =>
  new Exit(exitCodes.usage, envelopeOf('INPUT_REQUIRED', `${what} is required and there is no TTY to prompt for it.`, `Pass ${flag}.`))

export const usage = (explanation: string, fix: string) => new Exit(exitCodes.usage, envelopeOf('VALIDATION_FAILED', explanation, fix))

export const notLoggedIn = (instance: string | null, fix?: string) =>
  new Exit(
    exitCodes.connection,
    envelopeOf(
      'UNAUTHENTICATED',
      instance ? `No credential is stored for ${instance}.` : 'No instance is selected and none is logged in.',
      fix ?? (instance ? `Run sly login --instance ${instance}, or set ${tokenEnv}.` : `Run sly login --instance <https://api host>, or set ${tokenEnv} and ${apiUrlEnv}.`)
    )
  )

export const unreachable = (url: string, cause: unknown) =>
  new Exit(
    exitCodes.connection,
    envelopeOf('CONNECTION_FAILED', `Dispatch at ${url} could not be reached: ${cause instanceof Error ? (cause.cause instanceof Error ? cause.cause.message : cause.message) : String(cause)}.`, 'Check the instance URL and that Dispatch is running, then retry.')
  )

export const isEnvelope = (value: unknown): value is Envelope =>
  typeof value === 'object' && value !== null && 'error' in value && typeof (value as Envelope).error?.code === 'string'

const proxyStatuses = new Set([502, 503, 504])

export const isConnectionFailure = (error: unknown) => error instanceof Exit && error.envelope?.error.code === 'CONNECTION_FAILED'

export const apiFailure = (status: number, body: unknown) => {
  if (!isEnvelope(body) && proxyStatuses.has(status))
    return new Exit(exitCodes.connection, envelopeOf('CONNECTION_FAILED', `Dispatch could not be reached: the proxy in front of it answered HTTP ${status}.`, 'Check that Dispatch is running, then retry.'))
  const envelope = isEnvelope(body) ? body : envelopeOf('INTERNAL_ERROR', `Dispatch answered HTTP ${status} without an error envelope.`, 'Retry; if it keeps failing, report it.')
  const auth = status === 401 || envelope.error.code === 'UNAUTHENTICATED'
  return new Exit(auth ? exitCodes.connection : exitCodes.api, envelope)
}
