import type { AuthService } from '../auth/auth.ts'
import type { Principal } from '../auth/principal.ts'
import { mintRequestId, recordAudit } from '../db/audit.ts'
import type { Db } from '../db/client.ts'
import type { GitHub } from '../github/service.ts'
import type { ReadRepository } from '../sandboxes/repository-access.ts'
import type { Keyring } from '../secrets/keyring.ts'
import { emitEvent } from '../station/events.ts'
import type { StationServer } from '../station/server.ts'

export type Deps = {
  db: Db
  keyring: Keyring
  auth: AuthService
  version: string
  stations: StationServer
  blobDir: string
  github: GitHub
  readRepository: ReadRepository
  upgrades?: { kick(): void }
}

const requestIds = new WeakMap<Request, string>()
const idempotencyKeys = new WeakMap<Request, string>()

export const assignRequestId = (request: Request) => {
  const sent = request.headers.get('x-request-id')
  const id = sent && /^[A-Za-z0-9_.:-]{1,128}$/.test(sent) ? sent : mintRequestId()

  requestIds.set(request, id)

  return id
}

export const requestIdOf = (request: Request) => requestIds.get(request) ?? assignRequestId(request)

export const rememberIdempotencyKey = (request: Request, key: string) =>
  idempotencyKeys.set(request, key)

export type Call = {
  principal: Principal
  request_id: string
  idempotency_key: string | null
}

export const callOf = (request: Request, principal: Principal): Call => ({
  principal,
  request_id: requestIdOf(request),
  idempotency_key: idempotencyKeys.get(request) ?? null,
})

type Json = Record<string, unknown>

export const audit = (
  db: Db,
  call: Call,
  action: string,
  target: { entity: string; id: string },
  change: { before?: Json | null; after?: Json | null; purpose?: string } = {},
) =>
  recordAudit(db, {
    actor: call.principal.actor,
    action,
    target,
    requestId: call.request_id,
    idempotencyKey: call.idempotency_key,
    ...change,
  })

export const emit = (
  db: Db,
  type: string,
  subject: { entity: string; id: string } & Json,
  payload: Json = {},
) => emitEvent(db, type, subject, payload)
