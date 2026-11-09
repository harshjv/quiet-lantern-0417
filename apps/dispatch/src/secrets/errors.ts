import type { ErrorCode } from '@stationly/protocol'

export class SecretsError extends Error {
  readonly code: ErrorCode
  readonly details: Record<string, unknown>

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.code = code
    this.details = details
  }

  toJSON() {
    return { code: this.code, explanation: this.message, details: this.details }
  }
}
