import type { ErrorCode } from '@stationly/protocol'

export class DomainError<C extends string = ErrorCode> extends Error {
  readonly code: C
  readonly fix: string | undefined
  readonly details: Record<string, unknown>

  constructor(code: C, message: string, fix?: string, details: Record<string, unknown> = {}) {
    super(message)
    this.code = code
    this.fix = fix
    this.details = details
  }
}
