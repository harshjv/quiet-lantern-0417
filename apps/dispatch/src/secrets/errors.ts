import type { ErrorCode } from '@stationly/protocol'

import { DomainError } from '../errors.ts'

export class SecretsError extends DomainError {
  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(code, message, undefined, details)
  }

  toJSON() {
    return {
      code: this.code,
      explanation: this.message,
      details: this.details,
    }
  }
}
