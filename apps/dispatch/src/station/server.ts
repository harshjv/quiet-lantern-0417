import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { STATUS_CODES, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { gzipSync } from 'node:zlib'

import canonicalize from 'canonicalize'
import { Cron } from 'croner'
import { and, asc, eq, inArray, isNull, lt, or } from 'drizzle-orm'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'

import {
  closeCodes,
  limits,
  networkLayout,
  protocolVersion,
  stationConnectPath,
  subprotocol,
  type Capability,
  type ErrorCode,
  type Generation,
  type MessageBody,
  type MessageType,
  type Observed,
} from '@stationly/protocol'

import { recordAudit } from '../db/audit.ts'
import type { Db } from '../db/client.ts'
import { newId } from '../db/ids.ts'
import { build, deployment, run, sandbox, service, station, token, variable } from '../db/schema.ts'
import { readSetting, storedSetting, writeSetting } from '../db/settings.ts'
import { env } from '../env.ts'
import { DomainError } from '../errors.ts'
import { GenerationError } from '../generation/build.ts'
import { cloneUrl } from '../github/client.ts'
import type { GitHub } from '../github/service.ts'
import { log as defaultLog, type Log } from '../log.ts'
import {
  cidrProblem,
  contains,
  parseCidr,
  registryAddress,
  slash24Index,
  slash24sFrom,
} from '../net/cidr.ts'
import { projectRepository } from '../platform/registry.ts'
import { upstreamBlob, UpstreamError } from '../platform/sigstore.ts'
import { ingestObservedSandboxes } from '../sandboxes/lifecycle.ts'
import { ephemeralDelivery } from '../secrets/deliver.ts'
import { secretsDeliver } from '../secrets/deploy.ts'
import { SecretsError } from '../secrets/errors.ts'
import type { Keyring } from '../secrets/keyring.ts'
import { sandboxDeliver, sandboxEnv } from '../secrets/sandbox.ts'

import { mintGrant, serveBlob, storeBlob, sweepBlobs } from './blobs.ts'
import { ingestRoutes } from './domains.ts'
import { decode, encode, type RawEnvelope } from './envelope.ts'
import { emitEvent } from './events.ts'
import { ensureDesired, latestGeneration, reconnectRule, recordAck } from './generations.ts'
import {
  issueChallenge,
  recordSkewMs,
  sameDigest,
  tokenDigest,
  verifyEnroll,
  verifyHello,
  type Challenge,
  type EnrollToken,
  type Refusal,
} from './handshake.ts'
import { evaluateDrift, mergeObserved } from './observed.ts'
import {
  committedSeq,
  deploymentSubject,
  emitBuildFinished,
  failedPayload,
  ingest,
  outboxedTypes,
} from './outbox.ts'
import { recordDeletes, retentionItems } from './registry.ts'
import { runStartBody } from './run-start.ts'
import { setServiceStatus, signalFromHeartbeat } from './signal.ts'

const pingIntervalMs = 20_000
const challengeTimeoutMs = 30_000
const offlineAfterMs = 60_000
const asleepAfterMs = 90_000
const reconcileEveryMs = 2_000
const ackEveryMs = 1_000
const ackEveryRecords = 100
const requestTimeoutMs = 30_000
const dispatchCapabilities: Capability[] = [
  'generation.v1',
  'secrets.v1',
  'registry.v1',
  'platform.v1',
  'doctor.v1',
  'volumes.v1',
  'logs.follow',
  'metrics.v1',
  'network.v1',
  'exec.tty',
  'forward.tcp',
  'sandbox.v1',
]
const streamHighWater = 1024 * 1024
const streamLowWater = 256 * 1024
const creditBatch = limits.streamWindowBytes / 4
const generationBlobTtlMs = 24 * 3600 * 1000
const retentionEveryMs = 3600 * 1000

export const toBuffer = (data: RawData) =>
  Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)])

const stationActor = (stationId: string) => ({
  type: 'station' as const,
  id: stationId,
  client: 'dispatch/station-protocol',
})

type Pending = {
  type: MessageType
  resolve: (envelope: RawEnvelope) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

type StreamRequest = 'logs.follow' | 'metrics.subscribe' | 'network.subscribe' | 'forward.open'

const streamCapability: Record<StreamRequest, Capability> = {
  'logs.follow': 'logs.follow',
  'metrics.subscribe': 'metrics.v1',
  'network.subscribe': 'network.v1',
  'forward.open': 'forward.tcp',
}

export type StreamHandlers = {
  onData?: (items: unknown[], bytes: number) => void
  onBinary?: (channel: number, payload: Buffer) => void
  onEnd: (reason: string, exitCode: number | null) => void
}

type Stream = {
  number: number
  handlers: StreamHandlers
  allowance: number
  owed: number
  sendCredit: number
  pending: Buffer[]
  ended: boolean
}

export class StationRequestError extends DomainError<string> {
  constructor(code: string, explanation: string, details: Record<string, unknown> = {}) {
    super(code, explanation, undefined, details)
  }
}

export type StreamHandle = {
  stream: number
  credit: (bytes: number) => void
  write: (channel: number, payload: Buffer) => void
  cancel: () => void
  resize: (rows: number, cols: number) => Promise<void>
}

type Connection = {
  id: string
  ws: WebSocket
  remote: string
  phase: 'challenged' | 'ready' | 'closed'
  challenge: Challenge
  challengeTimer: NodeJS.Timeout
  alive: boolean
  stationId?: string
  sessionId?: string
  epoch?: string
  capabilities: Set<string>
  versionSkew: 'ok' | 'behind' | 'ahead' | 'unsupported'
  applied: number
  sentGeneration: number
  withheld: boolean
  delivered: Set<string>
  undeliverable: Set<string>
  requestedBuilds: Set<string>
  requestedRuns: Set<string>
  pending: Map<string, Pending>
  ack: { upTo: number; count: number }
  observed?: Observed
  stats: { applied: number; duplicate: number; firstSeq: number | null; lastSeq: number | null }
  streams: Map<number, Stream>
  streamOut: Buffer[]
  streamPaused: boolean
  streamTimer?: NodeJS.Timeout
}

export type HostAdmin = (
  stationId: string,
  op: string,
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>

export class HostAdminError extends DomainError {
  declare readonly fix: string

  constructor(code: ErrorCode, message: string, fix: string) {
    super(code, message, fix)
  }
}

export type StationServerOptions = {
  db: Db
  keyring: Keyring
  blobDir: string
  version: string
  github: GitHub
  hostAdmin?: HostAdmin
  onRecord?: (stationId: string, type: string, body: unknown) => void
  log?: Log
}

export const installProposalProblem = (proposal: {
  ipam_pool: string
  registry_subnet: string
}) => {
  const poolProblem = cidrProblem(proposal.ipam_pool)
  if (poolProblem) return `ipam_pool ${poolProblem}`
  const pool = parseCidr(proposal.ipam_pool)
  const subnet = parseCidr(proposal.registry_subnet)
  if (!pool || pool.bits > 22)
    return `ipam_pool ${proposal.ipam_pool} is not a CIDR of /22 or wider`
  if (!subnet || subnet.bits !== 24)
    return `registry_subnet ${proposal.registry_subnet} is not a /24`
  if (!contains(pool, subnet))
    return `registry_subnet ${proposal.registry_subnet} lies outside ipam_pool ${proposal.ipam_pool}`
  if (slash24Index(pool, subnet) <= networkLayout.ingressIndex)
    return `registry_subnet ${proposal.registry_subnet} is one of the system and ingress /24s`
  return null
}

const offeredSubprotocols = (req: IncomingMessage) =>
  (req.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

const refuseUpgrade = (socket: Duplex, status: number) => {
  const body = STATUS_CODES[status] ?? ''
  socket.end(
    `HTTP/1.1 ${status} ${body}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  )
}

const admissionStatus = (req: IncomingMessage) => {
  if (new URL(req.url ?? '/', 'http://dispatch').pathname !== stationConnectPath) return 404
  if (req.headers.origin !== undefined) return 403
  if (!offeredSubprotocols(req).includes(subprotocol)) return 400
  return null
}

const minorOf = (version: string) => {
  const m = /^v?(\d+)\.(\d+)\./.exec(version)
  return m ? Number(m[1]) * 1000 + Number(m[2]) : null
}

const skewOf = (dispatchVersion: string, stationdVersion: string) => {
  const d = minorOf(dispatchVersion)
  const s = minorOf(stationdVersion)
  if (d === null || s === null || d === 0 || s === 0) return 'ok' as const
  if (Math.abs(d - s) > 1) return 'unsupported' as const
  if (s < d) return 'behind' as const
  if (s > d) return 'ahead' as const
  return 'ok' as const
}

export const createStationServer = (options: StationServerOptions) => {
  const { db, keyring, blobDir, version, github, hostAdmin } = options
  const log = options.log ?? defaultLog
  mkdirSync(blobDir, {
    recursive: true,
  })
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: limits.readLimitBytes,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has(subprotocol) ? subprotocol : false),
  })
  const connections = new Set<Connection>()
  const byStation = new Map<string, Connection>()
  const observedByStation = new Map<string, Observed>()

  const generationOf = (stationId: string | undefined) =>
    stationId ? (latestGeneration(db, stationId)?.generation ?? 0) : 0

  const sendRaw = (conn: Connection, text: string) => {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(text)
  }

  const send = <T extends MessageType>(
    conn: Connection,
    type: T,
    body: MessageBody<T>,
    ref: string | null = null,
  ) => {
    const { id, text } = encode(type, body, {
      ref,
      generation: generationOf(conn.stationId),
    })
    sendRaw(conn, text)
    return id
  }

  const sendError = (
    conn: Connection,
    error: { code: ErrorCode; explanation: string; fix: string; details?: Record<string, unknown> },
    ref: string | null = null,
  ) =>
    send(
      conn,
      'error',
      {
        code: error.code,
        explanation: error.explanation,
        fix: error.fix,
        ...(error.details
          ? {
              details: error.details,
            }
          : {}),
      },
      ref,
    )

  const fatal = (conn: Connection, refusal: Refusal) => {
    log('station.refused', {
      connection: conn.id,
      station_id: conn.stationId ?? null,
      code: refusal.code,
      close: refusal.close,
      remote: conn.remote,
      details: refusal.details ?? null,
    })
    sendError(conn, refusal)
    conn.ws.close(refusal.close, refusal.code)
    conn.phase = 'closed'
  }

  const request = <T extends MessageType>(
    conn: Connection,
    type: T,
    body: MessageBody<T>,
    timeoutMs = requestTimeoutMs,
    onReply?: (envelope: RawEnvelope) => void,
  ) =>
    new Promise<RawEnvelope>((resolve, reject) => {
      if (conn.pending.size >= limits.pendingRequests)
        return reject(new Error('PROTOCOL_LIMIT: 256 requests are pending'))
      const id = send(conn, type, body)
      const timer = setTimeout(() => {
        conn.pending.delete(id)
        reject(new Error(`${type} timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      conn.pending.set(id, {
        type,
        resolve: (envelope) => {
          onReply?.(envelope)
          resolve(envelope)
        },
        reject,
        timer,
      })
    })

  const flushStreams = (conn: Connection) => {
    clearTimeout(conn.streamTimer)
    conn.streamTimer = undefined
    while (conn.streamOut.length && conn.ws.readyState === conn.ws.OPEN) {
      const buffered = conn.ws.bufferedAmount
      if (conn.streamPaused && buffered < streamLowWater) conn.streamPaused = false
      if (!conn.streamPaused && buffered > streamHighWater) conn.streamPaused = true
      if (conn.streamPaused) break
      conn.ws.send(conn.streamOut.shift()!, {
        binary: true,
      })
    }
    if (conn.streamOut.length && conn.ws.readyState === conn.ws.OPEN)
      conn.streamTimer = setTimeout(() => flushStreams(conn), 20)
  }

  const queueFrames = (conn: Connection, stream: Stream) => {
    while (stream.pending.length && stream.sendCredit > 0) {
      const frame = stream.pending[0]!
      const payload = frame.length - limits.binaryHeaderBytes
      if (payload > stream.sendCredit) break
      stream.pending.shift()
      stream.sendCredit -= payload
      conn.streamOut.push(frame)
    }
    flushStreams(conn)
  }

  const endStream = (
    conn: Connection,
    stream: Stream,
    reason: string,
    notify: boolean,
    exitCode: number | null = null,
  ) => {
    if (stream.ended) return
    stream.ended = true
    conn.streams.delete(stream.number)
    if (notify)
      send(conn, 'stream.end', {
        stream: stream.number,
        reason,
        exit_code: null,
      })
    stream.handlers.onEnd(reason, exitCode)
  }

  const registerStream = (
    conn: Connection,
    number: number,
    window: number,
    handlers: StreamHandlers,
  ) => {
    const stream: Stream = {
      number,
      handlers,
      allowance: window,
      owed: 0,
      sendCredit: limits.streamWindowBytes,
      pending: [],
      ended: false,
    }
    conn.streams.set(number, stream)
    return stream
  }

  const handleOf = (conn: Connection, stream: Stream): StreamHandle => ({
    stream: stream.number,
    credit: (bytes) => {
      if (stream.ended || bytes <= 0) return
      stream.owed += bytes
      if (stream.owed < creditBatch && stream.allowance > limits.streamWindowBytes / 2) return
      stream.allowance += stream.owed
      send(conn, 'stream.credit', {
        stream: stream.number,
        bytes: stream.owed,
      })
      stream.owed = 0
    },
    write: (channel, payload) => {
      if (stream.ended) return
      const chunks =
        payload.length === 0
          ? [payload]
          : Array.from(
              {
                length: Math.ceil(payload.length / limits.binaryPayloadBytes),
              },
              (_, i) =>
                payload.subarray(
                  i * limits.binaryPayloadBytes,
                  (i + 1) * limits.binaryPayloadBytes,
                ),
            )
      for (const chunk of chunks) {
        const frame = Buffer.alloc(limits.binaryHeaderBytes + chunk.length)
        frame.writeUInt32BE(stream.number, 0)
        frame.writeUInt8(channel, 4)
        chunk.copy(frame, limits.binaryHeaderBytes)
        stream.pending.push(frame)
      }
      queueFrames(conn, stream)
    },
    cancel: () => {
      if (stream.ended) return
      send(conn, 'stream.cancel', {
        stream: stream.number,
      })
      endStream(conn, stream, 'cancelled', false)
    },
    resize: async (rows, cols) => {
      const reply = await request(conn, 'exec.resize', {
        stream: stream.number,
        rows,
        cols,
      })
      if (reply.type === 'error') {
        const e = reply.body as MessageBody<'error'>
        throw new StationRequestError(e.code, e.explanation, e.details ?? {})
      }
    },
  })

  const onStreamData = (
    conn: Connection,
    number: number,
    bytes: number,
    deliver: (stream: Stream) => void,
  ) => {
    const stream = conn.streams.get(number)
    if (!stream)
      return sendError(conn, {
        code: 'STREAM_NOT_FOUND',
        explanation: `stream ${number} is not open on this connection`,
        fix: 'Send data only on streams Dispatch opened.',
        details: {
          stream: number,
        },
      })
    stream.allowance -= bytes
    if (stream.allowance < 0) {
      sendError(conn, {
        code: 'STREAM_CREDIT_EXCEEDED',
        explanation: `stream ${number} sent ${-stream.allowance} bytes beyond its credit`,
        fix: 'Never send more than the granted credit.',
        details: {
          stream: number,
        },
      })
      return endStream(conn, stream, 'STREAM_CREDIT_EXCEEDED', true)
    }
    deliver(stream)
  }

  const onBinary = (conn: Connection, data: Buffer) => {
    if (
      data.length < limits.binaryHeaderBytes ||
      data.length > limits.binaryHeaderBytes + limits.binaryPayloadBytes
    ) {
      return sendError(conn, {
        code: 'PROTOCOL_MESSAGE_TOO_LARGE',
        explanation: `binary frame of ${data.length} bytes is outside 5..${limits.binaryHeaderBytes + limits.binaryPayloadBytes}`,
        fix: 'Split stream data into 64 KiB frames.',
      })
    }
    const number = data.readUInt32BE(0)
    const channel = data.readUInt8(4)
    const payload = data.subarray(limits.binaryHeaderBytes)
    onStreamData(conn, number, payload.length, (stream) =>
      stream.handlers.onBinary?.(channel, payload),
    )
  }

  const flushAck = (conn: Connection) => {
    if (!conn.epoch || conn.ack.count === 0) return
    send(conn, 'outbox.ack', {
      epoch: conn.epoch,
      up_to_seq: conn.ack.upTo,
    })
    conn.ack.count = 0
  }

  const deliver = (
    conn: Connection,
    owner: { deployment_id: string } | { sandbox_id: string },
    build: (actor: ReturnType<typeof stationActor>) => MessageBody<'secrets.deliver'>,
    fix: string,
    ref: string | null,
  ) => {
    if (!conn.capabilities.has('secrets.v1') || !conn.stationId) return false
    const id = 'deployment_id' in owner ? owner.deployment_id : owner.sandbox_id
    try {
      const body = build(stationActor(conn.stationId))
      send(conn, 'secrets.deliver', body, ref)
      conn.delivered.add(`${id}|${body.env_digest}`)
      log('secrets.delivered', {
        station_id: conn.stationId,
        ...owner,
        purpose: body.purpose,
        values: body.values.length,
        redaction: body.redaction.length,
        env_digest: body.env_digest,
      })
      return true
    } catch (error) {
      const code = error instanceof SecretsError ? error.code : 'SECRETS_UNAVAILABLE'
      log('secrets.deliver_failed', {
        station_id: conn.stationId,
        ...owner,
        code,
        explanation: (error as Error).message,
      })
      if (ref)
        sendError(
          conn,
          {
            code,
            explanation: (error as Error).message,
            fix,
          },
          ref,
        )
      return false
    }
  }

  const deliverSecrets = (
    conn: Connection,
    deploymentId: string,
    envDigest: string,
    purpose: 'deploy' | 'redaction',
    ref: string | null,
  ) =>
    deliver(
      conn,
      {
        deployment_id: deploymentId,
      },
      (actor) => {
        const body = secretsDeliver(db, keyring, deploymentId, purpose, actor)
        if (body.env_digest !== envDigest)
          log('secrets.digest_mismatch', {
            station_id: conn.stationId,
            deployment_id: deploymentId,
            generation_digest: envDigest,
            delivery_digest: body.env_digest,
          })
        return body
      },
      'Re-enter the secret values, then redeploy.',
      ref,
    )

  const deliverSandboxSecrets = (conn: Connection, sandboxId: string, ref: string | null) =>
    deliver(
      conn,
      {
        sandbox_id: sandboxId,
      },
      (actor) => sandboxDeliver(db, keyring, sandboxId, actor),
      'Set the sandbox variables again.',
      ref,
    )

  const generationBlobs = new Map<string, string>()
  const unbuildable = new Map<string, string>()

  const sendGeneration = (
    conn: Connection,
    row: { generation: number; hash: string; document: Generation },
  ) => {
    const canonical = canonicalize(row.document)!
    const bytes = Buffer.byteLength(canonical, 'utf8')
    if (bytes <= limits.generationInlineBytes) {
      send(conn, 'generation', row.document)
      return {
        via: 'inline',
        bytes,
      }
    }
    const key = `${conn.stationId}|${row.generation}`
    let blobId = generationBlobs.get(key)
    if (!blobId) {
      blobId = storeBlob(db, blobDir, {
        kind: 'generation',
        bytes: gzipSync(Buffer.from(canonical, 'utf8')),
        ttlMs: generationBlobTtlMs,
      }).id
      generationBlobs.set(key, blobId)
    }
    const grant = mintGrant(db, conn.stationId!, blobId)
    send(conn, 'generation.available', {
      number: row.generation,
      hash: row.hash,
      blob: grant,
    })
    return {
      via: 'blob',
      bytes,
      blob_id: blobId,
      blob_size: grant.size,
    }
  }

  const syncGeneration = (conn: Connection) => {
    const stationId = conn.stationId
    if (
      !stationId ||
      conn.phase !== 'ready' ||
      conn.withheld ||
      conn.versionSkew === 'unsupported' ||
      !conn.capabilities.has('generation.v1')
    )
      return
    let row
    try {
      const desired = ensureDesired(db, stationId, conn.applied)
      row = desired.row
      if (desired.failed.length)
        log('generation.deployments_failed', {
          station_id: stationId,
          deployments: desired.failed,
          explanation: desired.excluded
            .filter((e) => desired.failed.includes(e.id))
            .map((e) => e.explanation),
        })
      if (desired.created && desired.excluded.length)
        log('generation.excluded', {
          station_id: stationId,
          number: row.generation,
          objects: desired.excluded.map((e) => ({
            key: e.key,
            carried: e.carried,
            explanation: e.explanation,
          })),
        })
    } catch (error) {
      if (error instanceof GenerationError || error instanceof SecretsError) {
        if (unbuildable.get(stationId) !== error.message) {
          log('generation.unbuildable', {
            station_id: stationId,
            explanation: error.message,
          })
          emitEvent(
            db,
            'doctor.finding',
            {
              entity: 'station',
              id: stationId,
            },
            {
              check: 'generation',
              station: stationId,
              severity: 'fail',
              previous: unbuildable.has(stationId) ? 'fail' : 'ok',
              code: 'GENERATION_INVALID',
              detail: `Dispatch cannot build station ${stationId}'s desired state: ${error.message}`,
              fix: 'Correct the station-wide setting the detail names; nothing reaches the station until it is fixed.',
            },
          )
        }
        unbuildable.set(stationId, error.message)
        return
      }
      throw error
    }
    unbuildable.delete(stationId)
    if (row.generation > conn.applied && row.ack === null && conn.sentGeneration < row.generation) {
      const via = sendGeneration(conn, row)
      conn.sentGeneration = row.generation
      log('generation.sent', {
        station_id: stationId,
        number: row.generation,
        hash: row.hash,
        previous: row.document.previous,
        services: Object.keys(row.document.services).length,
        deployments: Object.keys(row.document.deployments).length,
        ...via,
      })
    }
    if (
      row.ack === 'rejected' ||
      (row.generation > conn.applied && conn.sentGeneration < row.generation)
    )
      return
    for (const [id, dep] of Object.entries(row.document.deployments)) {
      if (dep.cancel || !dep.target.env.some((e) => !e.platform)) continue
      const key = `${id}|${dep.target.env_digest}`
      if (conn.delivered.has(key) || conn.undeliverable.has(key)) continue
      if (!deliverSecrets(conn, id, dep.target.env_digest, 'deploy', null))
        conn.undeliverable.add(key)
    }
    for (const [id, box] of Object.entries(row.document.sandboxes ?? {})) {
      if (box.status === 'destroy' || !sandboxEnv(db, id).env.length) continue
      const key = `${id}|${box.env_digest}`
      if (conn.delivered.has(key) || conn.undeliverable.has(key)) continue
      if (!deliverSandboxSecrets(conn, id, null)) conn.undeliverable.add(key)
    }
  }

  const scheduleBuilds = (conn: Connection) => {
    const stationId = conn.stationId
    if (!stationId || conn.phase !== 'ready' || conn.versionSkew === 'unsupported') return
    const queued = db
      .select({
        build: build,
        service_id: deployment.service_id,
      })
      .from(build)
      .innerJoin(deployment, eq(deployment.id, build.deployment_id))
      .innerJoin(service, eq(service.id, deployment.service_id))
      .where(and(eq(build.status, 'queued'), eq(service.station_id, stationId)))
      .orderBy(asc(build.created_at))
      .all()
    for (const { build: b, service_id } of queued) {
      if (conn.requestedBuilds.has(b.id) || b.detail.requested_at) continue
      conn.requestedBuilds.add(b.id)
      void startBuild(conn, b, service_id)
    }
  }

  const queuedRuns = (stationId: string, sandboxes: boolean) => [
    ...db
      .select({
        run,
      })
      .from(run)
      .innerJoin(service, eq(service.id, run.service_id))
      .where(
        and(
          eq(run.status, 'queued'),
          eq(run.kind, 'one_off'),
          eq(run.tty, false),
          eq(service.station_id, stationId),
        ),
      )
      .orderBy(asc(run.created_at))
      .all(),
    ...(sandboxes
      ? db
          .select({
            run,
          })
          .from(run)
          .innerJoin(sandbox, eq(sandbox.id, run.sandbox_id))
          .where(
            and(eq(run.status, 'queued'), eq(run.kind, 'exec'), eq(sandbox.station_id, stationId)),
          )
          .orderBy(asc(run.created_at))
          .all()
      : []),
  ]

  const scheduleRuns = (conn: Connection) => {
    const stationId = conn.stationId
    if (!stationId || conn.phase !== 'ready' || conn.versionSkew === 'unsupported') return
    for (const { run: r } of queuedRuns(stationId, conn.capabilities.has('sandbox.v1'))) {
      if (conn.requestedRuns.has(r.id) || !(r.deployment_id || r.sandbox_id) || r.exec?.attach)
        continue
      conn.requestedRuns.add(r.id)
      const owner = r.sandbox_id
        ? {
            sandbox_id: r.sandbox_id,
          }
        : {}
      request(
        conn,
        'run.start',
        runStartBody(r, r.actor ?? stationActor(stationId), {
          tty: false,
          attach: false,
          rows: null,
          cols: null,
        }),
      )
        .then((reply) => {
          if (reply.type === 'run.accepted') {
            if (r.exec?.stdin)
              db.update(run)
                .set({
                  exec: {
                    ...r.exec,
                    stdin: null,
                  },
                })
                .where(eq(run.id, r.id))
                .run()
            return log('run.accepted', {
              station_id: stationId,
              run_id: r.id,
              ...owner,
            })
          }
          const e = reply.body as MessageBody<'error'>
          db.update(run)
            .set({
              status: 'failed',
              failure: {
                phase: 'run',
                code: e.code,
                summary: e.explanation,
              },
              finished_at: new Date(),
            })
            .where(and(eq(run.id, r.id), eq(run.status, 'queued')))
            .run()
          log('run.refused', {
            station_id: stationId,
            run_id: r.id,
            code: e.code,
            explanation: e.explanation,
          })
        })
        .catch((error) => {
          conn.requestedRuns.delete(r.id)
          log('run.request_failed', {
            station_id: stationId,
            run_id: r.id,
            explanation: (error as Error).message,
          })
        })
    }
  }

  const startBuild = async (conn: Connection, b: typeof build.$inferSelect, serviceId: string) => {
    const stationId = conn.stationId!
    const st = db.select().from(station).where(eq(station.id, stationId)).get()!
    const svc = db.select().from(service).where(eq(service.id, serviceId)).get()!
    const source = b.source as {
      type: string
      blob_id?: string
      path?: string
      dockerfile?: string | null
      repo?: string
      branch?: string
      auth?: string | null
      sha?: string | null
      ref?: string | null
      fork?: boolean
    }
    const fail = (code: string, summary: string) => {
      db.update(build)
        .set({
          status: 'failed',
          failure: {
            phase: 'build',
            code,
            summary,
          },
        })
        .where(eq(build.id, b.id))
        .run()
      db.update(deployment)
        .set({
          status: 'failed',
          failure: {
            phase: 'build',
            code,
            summary,
          },
          finished_at: new Date(),
        })
        .where(eq(deployment.id, b.deployment_id))
        .run()
      const dep = db
        .select({
          number: deployment.number,
        })
        .from(deployment)
        .where(eq(deployment.id, b.deployment_id))
        .get()
      emitBuildFinished(db, b.id, b.deployment_id, 'failed', null, code)
      emitEvent(
        db,
        'deployment.failed',
        deploymentSubject(db, b.deployment_id),
        failedPayload(b.deployment_id, dep?.number ?? 0, {
          phase: 'build',
          code,
          summary,
        }),
      )
      log('build.failed', {
        station_id: stationId,
        build_id: b.id,
        code,
        summary,
      })
    }
    if (source.type !== 'blob' && source.type !== 'git')
      return fail(
        'SOURCE_UNREACHABLE',
        `build ${b.id} has a ${source.type} source, which this Dispatch cannot build`,
      )
    if (source.type === 'blob' && !source.blob_id)
      return fail('SOURCE_UNREACHABLE', `build ${b.id} names no blob`)
    const buildSecretKeys = db
      .select({
        key: variable.key,
      })
      .from(variable)
      .where(
        and(
          eq(variable.build, true),
          or(
            eq(variable.service_id, serviceId),
            and(eq(variable.project_id, b.project_id), isNull(variable.service_id)),
          ),
        ),
      )
      .all()
      .map((v) => v.key)
    if (buildSecretKeys.length && !source.fork)
      return fail(
        'SECRETS_UNAVAILABLE',
        `build secrets (${buildSecretKeys.join(', ')}) are not delivered by this Dispatch yet`,
      )
    let buildSource: MessageBody<'build.start'>['source']
    if (source.type === 'git') {
      const repo = source.repo!
      let sha = source.sha ?? null
      let token: string | null = null
      try {
        if (!sha) sha = (await github.branchHead(repo, source.branch!)).sha
        if (!sha)
          return fail(
            'SOURCE_UNREACHABLE',
            `the head of ${repo} ${source.branch} could not be read`,
          )
        token = await github.cloneCredential(repo, source.auth ?? undefined)
      } catch (error) {
        conn.requestedBuilds.delete(b.id)
        return fail('SOURCE_UNREACHABLE', `${repo}: ${(error as Error).message}`)
      }
      const resolved = {
        ...source,
        sha,
      }
      db.update(build)
        .set({
          source: resolved,
        })
        .where(eq(build.id, b.id))
        .run()
      if (
        !db
          .select({
            trigger: deployment.trigger,
          })
          .from(deployment)
          .where(eq(deployment.id, b.deployment_id))
          .get()?.trigger.source_sha
      ) {
        const dep = db.select().from(deployment).where(eq(deployment.id, b.deployment_id)).get()!
        db.update(deployment)
          .set({
            trigger: {
              ...dep.trigger,
              source_sha: sha,
            },
          })
          .where(eq(deployment.id, dep.id))
          .run()
      }
      const delivery = ephemeralDelivery(
        {
          build_id: b.id,
        },
        'build',
        token ? [['STATIONLY_GIT_TOKEN', token]] : [],
      )
      if (token) {
        const ack = await request(conn, 'secrets.deliver', delivery).catch((error: Error) => error)
        if (ack instanceof Error || ack.type !== 'secrets.ack') {
          conn.requestedBuilds.delete(b.id)
          log('build.secrets_failed', {
            station_id: stationId,
            build_id: b.id,
            explanation: ack instanceof Error ? ack.message : ack.type,
          })
          return
        }
        recordAudit(db, {
          actor: stationActor(stationId),
          action: 'secret.deliver',
          target: {
            entity: 'build',
            id: b.id,
          },
          requestId: `build_${b.id}`,
          purpose: 'build',
          after: {
            keys: delivery.values.map((v) => v.key),
          },
        })
      }
      github.buildStarted(db.select().from(build).where(eq(build.id, b.id)).get()!, svc, sha)
      buildSource = {
        type: 'git',
        repo,
        url: cloneUrl(repo),
        sha,
        ref: source.ref ?? null,
        path: source.path ?? '.',
        dockerfile: source.dockerfile ?? null,
      }
      log('build.git_source', {
        station_id: stationId,
        build_id: b.id,
        repo,
        sha,
        ref: source.ref ?? null,
        fork: Boolean(source.fork),
        auth: source.auth ?? null,
        credential: Boolean(token),
      })
    } else {
      const grant = mintGrant(db, stationId, source.blob_id!)
      buildSource = {
        type: 'blob',
        blob: grant,
        path: source.path ?? '.',
        dockerfile: source.dockerfile ?? null,
      }
    }
    const body: MessageBody<'build.start'> = {
      build_id: b.id,
      deployment_id: b.deployment_id,
      project_id: b.project_id,
      service_id: serviceId,
      builder: b.builder,
      source: buildSource,
      railpack: null,
      build_args: svc.build_args ?? null,
      build_secret_keys: [],
      cache_key: b.cache_key,
      export_name: `${st.registry_address}/${projectRepository(b.project_id, serviceId)}:${b.deployment_id}`,
      attest: {
        sbom: true,
        provenance: 'mode=max,version=v1',
      },
    }
    log('build.requested', {
      station_id: stationId,
      build_id: b.id,
      deployment_id: b.deployment_id,
      source: buildSource.type,
      blob_id: buildSource.type === 'blob' ? buildSource.blob.blob_id : null,
    })
    try {
      const reply = await request(conn, 'build.start', body)
      if (reply.type === 'build.accepted') {
        db.update(build)
          .set({
            status: 'running',
            detail: {
              ...b.detail,
              requested_at: new Date().toISOString(),
              station_id: stationId,
            },
          })
          .where(eq(build.id, b.id))
          .run()
        db.update(deployment)
          .set({
            status: 'building',
          })
          .where(and(eq(deployment.id, b.deployment_id), eq(deployment.status, 'queued')))
          .run()
        log('build.accepted', {
          station_id: stationId,
          build_id: b.id,
        })
        return
      }
      const e = reply.body as MessageBody<'error'>
      fail(e.code, e.explanation)
    } catch (error) {
      conn.requestedBuilds.delete(b.id)
      log('build.request_failed', {
        station_id: stationId,
        build_id: b.id,
        explanation: (error as Error).message,
      })
    }
  }

  const onHeartbeat = (conn: Connection, body: MessageBody<'heartbeat'>) => {
    const stationId = conn.stationId!
    const st = db.select().from(station).where(eq(station.id, stationId)).get()!
    const appliedNumber =
      body.applied.status && body.applied.status !== 'rejected'
        ? body.applied.number
        : st.generation
    db.update(station)
      .set({
        last_seen_at: new Date(),
        resources: body.resources,
        generation: Math.max(appliedNumber, 0),
        status: 'online',
      })
      .where(eq(station.id, stationId))
      .run()
    if (st.status === 'offline' || st.status === 'asleep' || st.status === 'enrolling') {
      emitEvent(
        db,
        'station.online',
        {
          entity: 'station',
          id: stationId,
        },
        {
          from: st.status,
          session_id: conn.sessionId,
        },
      )
      log('station.online', {
        station_id: stationId,
        from: st.status,
      })
    }
    const ids = Object.keys(body.services)
    if (!ids.length) return
    for (const svc of db.select().from(service).where(inArray(service.id, ids)).all()) {
      const hb = body.services[svc.id]!
      if (!svc.current_deployment_id) continue
      if (hb.health.state === 'none' && svc.health !== null) continue
      setServiceStatus(db, svc.id, signalFromHeartbeat(hb.status_hint, hb.health.state), {
        source: 'heartbeat',
        status_hint: hb.status_hint,
        health: hb.health.state,
      })
    }
  }

  const onOutboxed = (conn: Connection, envelope: RawEnvelope) => {
    const stationId = conn.stationId!
    const body = envelope.body as { seq: number }
    const result = ingest(db, keyring, stationId, conn.epoch!, envelope.type, body)
    conn.stats[result.status === 'applied' ? 'applied' : 'duplicate']++
    conn.stats.firstSeq ??= body.seq
    conn.stats.lastSeq = body.seq
    log(result.status === 'applied' ? 'outbox.record' : 'outbox.duplicate', {
      station_id: stationId,
      epoch: conn.epoch,
      seq: body.seq,
      type: envelope.type,
      generation: envelope.generation,
    })
    conn.ack.upTo = Math.max(conn.ack.upTo, body.seq)
    conn.ack.count++
    if (conn.ack.count >= ackEveryRecords) flushAck(conn)
    if (result.reconcile) syncGeneration(conn)
    if (result.status === 'applied' && envelope.type === 'deployment.finished')
      scheduleRetention(stationId)
    if (result.status === 'applied') options.onRecord?.(stationId, envelope.type, envelope.body)
    if (result.status === 'applied' && envelope.type === 'disk.pressure')
      runGc(stationId, 'disk_pressure').catch((error) =>
        log('registry.gc_failed', {
          station_id: stationId,
          explanation: (error as Error).message,
        }),
      )
  }

  const onReady = (conn: Connection, envelope: RawEnvelope, frameBytes: number) => {
    const stationId = conn.stationId!
    const pendingReply = envelope.ref ? conn.pending.get(envelope.ref) : undefined
    if (pendingReply) {
      conn.pending.delete(envelope.ref!)
      clearTimeout(pendingReply.timer)
      pendingReply.resolve(envelope)
      return
    }
    if (outboxedTypes.has(envelope.type)) return onOutboxed(conn, envelope)
    switch (envelope.type) {
      case 'heartbeat':
        return onHeartbeat(conn, envelope.body as MessageBody<'heartbeat'>)
      case 'generation.ack': {
        const ack = envelope.body as MessageBody<'generation.ack'>
        const recorded = recordAck(db, stationId, ack)
        if (ack.status !== 'rejected') conn.applied = Math.max(conn.applied, ack.number)
        log('generation.ack', {
          station_id: stationId,
          number: ack.number,
          status: ack.status,
          results: ack.results.length,
          duration_ms: ack.duration_ms,
          known: recorded.known,
          failure: ack.failure ?? null,
          failed: ack.results,
        })
        if (ack.status === 'rejected')
          emitEvent(
            db,
            'doctor.finding',
            {
              entity: 'station',
              id: stationId,
            },
            {
              finding: 'generation_rejected',
              number: ack.number,
              failure: ack.failure ?? null,
            },
          )
        return
      }
      case 'observed.report': {
        const observed = envelope.body as Observed
        observedByStation.set(stationId, observed)
        conn.observed = observed
        ingestObservedSandboxes(db, stationId, observed)
        const drift = evaluateDrift(db, stationId, observed)
        const domains = ingestRoutes(db, stationId, observed)
        log('observed.report', {
          station_id: stationId,
          applied: observed.applied,
          services: Object.keys(observed.services).length,
          drift_opened: drift.opened,
          drift_resolved: drift.resolved,
          domains_changed: domains,
        })
        return
      }
      case 'observed.update': {
        const merged = mergeObserved(
          observedByStation.get(stationId),
          envelope.body as MessageBody<'observed.update'>,
        )
        if (merged) {
          observedByStation.set(stationId, merged)
          const update = envelope.body as MessageBody<'observed.update'>
          if (update.station || update.sandboxes || update.sandbox_snapshots)
            ingestObservedSandboxes(db, stationId, merged)
          evaluateDrift(db, stationId, merged)
          if ((envelope.body as MessageBody<'observed.update'>).gateway) {
            const domains = ingestRoutes(db, stationId, merged)
            if (domains.length)
              log('domains.changed', {
                station_id: stationId,
                domains,
              })
          }
        }
        return
      }
      case 'secrets.request': {
        const body = envelope.body as MessageBody<'secrets.request'>
        if ('sandbox_id' in body.target) {
          log('secrets.requested', {
            station_id: stationId,
            sandbox_id: body.target.sandbox_id,
            purpose: body.purpose,
            env_digest: body.env_digest,
          })
          return void deliverSandboxSecrets(conn, body.target.sandbox_id, envelope.id)
        }
        const depId = 'deployment_id' in body.target ? body.target.deployment_id : undefined
        if (!depId)
          return sendError(
            conn,
            {
              code: 'SECRETS_UNAVAILABLE',
              explanation:
                'secrets.request names a target this Dispatch resends only for deployments',
              fix: 'Request values for a deployment.',
            },
            envelope.id,
          )
        log('secrets.requested', {
          station_id: stationId,
          deployment_id: depId,
          purpose: body.purpose,
          env_digest: body.env_digest,
        })
        return deliverSecrets(
          conn,
          depId,
          body.env_digest,
          body.purpose === 'redaction' ? 'redaction' : 'deploy',
          envelope.id,
        )
      }
      case 'stream.data': {
        const body = envelope.body as MessageBody<'stream.data'>
        return onStreamData(conn, body.stream, frameBytes, (stream) =>
          stream.handlers.onData?.(body.items, frameBytes),
        )
      }
      case 'stream.credit': {
        const body = envelope.body as MessageBody<'stream.credit'>
        const stream = conn.streams.get(body.stream)
        if (!stream) return
        stream.sendCredit += body.bytes
        return queueFrames(conn, stream)
      }
      case 'stream.end': {
        const body = envelope.body as MessageBody<'stream.end'>
        const stream = conn.streams.get(body.stream)
        if (stream) endStream(conn, stream, body.reason, false, body.exit_code)
        return
      }
      case 'secrets.ack': {
        const body = envelope.body as MessageBody<'secrets.ack'>
        log('secrets.ack', {
          station_id: stationId,
          target: body.target,
          env_digest: body.env_digest,
        })
        return
      }
      case 'error': {
        const body = envelope.body as MessageBody<'error'>
        log('station.error', {
          station_id: stationId,
          ref: envelope.ref,
          code: body.code,
          explanation: body.explanation,
        })
        return
      }
      case 'host.admin': {
        const body = envelope.body as MessageBody<'host.admin'>
        const hosts = db
          .select({
            hosts: station.hosts_dispatch,
          })
          .from(station)
          .where(eq(station.id, stationId))
          .get()?.hosts
        if (!hosts || !hostAdmin)
          return sendError(
            conn,
            {
              code: 'HOST_ADMIN_FORBIDDEN',
              explanation:
                'This station does not run the Dispatch container, so it cannot relay root socket operations.',
              fix: 'Run the command on the station that hosts Dispatch.',
            },
            envelope.id,
          )
        log('host.admin', {
          station_id: stationId,
          op: body.op,
        })
        hostAdmin(stationId, body.op, body.params)
          .then((result) =>
            send(
              conn,
              'host.admin.result',
              {
                result,
              },
              envelope.id,
            ),
          )
          .catch((error) => {
            const known = error instanceof HostAdminError
            log('host.admin_failed', {
              station_id: stationId,
              op: body.op,
              code: known ? error.code : 'INTERNAL_ERROR',
              explanation: (error as Error).message,
            })
            sendError(
              conn,
              {
                code: known ? error.code : 'INTERNAL_ERROR',
                explanation: (error as Error).message,
                fix: known ? error.fix : 'Check the Dispatch log.',
              },
              envelope.id,
            )
          })
        return
      }
      case 'blob.grant': {
        const body = envelope.body as MessageBody<'blob.grant'>
        if (!body.blob_id && body.upstream) {
          const upstream = body.upstream
          const started = Date.now()
          upstreamBlob(db, blobDir, upstream)
            .then((stored) => {
              log('blob.upstream', {
                station_id: stationId,
                upstream,
                blob_id: stored.id,
                size: stored.size_bytes,
                took_ms: Date.now() - started,
              })
              send(conn, 'blob.granted', mintGrant(db, stationId, stored.id), envelope.id)
            })
            .catch((error) => {
              const code = error instanceof UpstreamError ? error.code : 'SOURCE_UNREACHABLE'
              log('blob.upstream_failed', {
                station_id: stationId,
                upstream,
                code,
                explanation: (error as Error).message,
              })
              sendError(
                conn,
                {
                  code,
                  explanation: (error as Error).message,
                  fix:
                    code === 'NOT_FOUND'
                      ? 'The upstream has no such file.'
                      : 'Check Dispatch egress to the Sigstore and signature hosts.',
                },
                envelope.id,
              )
            })
          return
        }
        if (!body.blob_id)
          return sendError(
            conn,
            {
              code: 'PROTOCOL_INVALID_MESSAGE',
              explanation: 'blob.grant names neither a blob_id nor an upstream',
              fix: 'Name a blob_id or an upstream.',
            },
            envelope.id,
          )
        try {
          return void send(
            conn,
            'blob.granted',
            mintGrant(db, stationId, body.blob_id),
            envelope.id,
          )
        } catch (error) {
          return sendError(
            conn,
            {
              code: 'NOT_FOUND',
              explanation: (error as Error).message,
              fix: 'Name a blob Dispatch holds.',
            },
            envelope.id,
          )
        }
      }
      default:
        if (['hello', 'enroll'].includes(envelope.type))
          return sendError(
            conn,
            {
              code: 'PROTOCOL_INVALID_MESSAGE',
              explanation: `${envelope.type} after the handshake`,
              fix: 'Send hello once per connection.',
            },
            envelope.id,
          )
        return sendError(
          conn,
          {
            code: 'PROTOCOL_UNKNOWN_TYPE',
            explanation: `${envelope.type} is not handled by Dispatch`,
            fix: 'Send a type Dispatch accepts.',
          },
          envelope.id,
        )
    }
  }

  const enrollToken = (presentedToken: string): EnrollToken | undefined => {
    const bootstrap = env().STATIONLY_BOOTSTRAP_ENROLL_SHA256
    const presented = tokenDigest(presentedToken)
    if (bootstrap && sameDigest(presented, bootstrap.toLowerCase())) {
      const hosts = db
        .select({
          id: station.id,
        })
        .from(station)
        .where(and(eq(station.hosts_dispatch, true), isNull(station.revoked_at)))
        .all()
      if (!hosts.some((h) => byStation.has(h.id)))
        return {
          kind: 'bootstrap',
          sha256: presented,
        }
    }
    const row = db
      .select({
        id: token.id,
        expiresAt: token.expires_at,
        stationId: station.id,
      })
      .from(token)
      .innerJoin(station, eq(station.id, token.station_id))
      .where(
        and(
          eq(token.kind, 'station_enroll'),
          eq(token.secret_sha256, presented),
          isNull(token.used_at),
          eq(station.status, 'enrolling'),
          isNull(station.identity_key),
          isNull(station.revoked_at),
        ),
      )
      .get()
    return row
      ? {
          kind: 'row',
          id: row.id,
          stationId: row.stationId,
          sha256: presented,
          expiresAt: row.expiresAt,
        }
      : undefined
  }

  const allocateRegistry = () => {
    const taken = new Set(
      db
        .select({
          subnet: station.registry_subnet,
        })
        .from(station)
        .all()
        .map((s) => s.subnet),
    )
    for (const { subnet } of slash24sFrom(
      readSetting(db, 'ipam.pool'),
      networkLayout.registryFirstIndex,
    )) {
      if (!taken.has(subnet))
        return {
          registry_subnet: subnet,
          registry_address: registryAddress(subnet),
        }
    }
    throw new Error('no free /24 left in ipam.pool for a registry subnet')
  }

  const onEnroll = (conn: Connection, envelope: RawEnvelope) => {
    const body = envelope.body as MessageBody<'enroll'>
    const now = Date.now()
    const enrolledWith = enrollToken(body.token)
    const verified = verifyEnroll(body, enrolledWith, conn.challenge, now)
    if (!verified.ok) return fatal(conn, verified.refusal)
    const instanceId = readSetting(db, 'instance.id')
    if (!instanceId)
      return fatal(conn, {
        code: 'ENROLL_TOKEN_INVALID',
        close: closeCodes.revoked,
        explanation: 'Dispatch has no instance.id yet',
        fix: 'Run sly setup first.',
      })
    const proposal = enrolledWith?.kind === 'bootstrap' ? body.install : undefined
    const stationId =
      enrolledWith?.kind === 'row'
        ? enrolledWith.stationId
        : (proposal?.station_id ?? newId('station'))
    if (body.install && !proposal)
      log('station.enroll_install_ignored', {
        connection: conn.id,
        reason: 'only the bootstrap enrollment carries install-time values',
      })
    if (proposal) {
      const problem = installProposalProblem(proposal)
      const stored = storedSetting(db, 'ipam.pool')
      const refusal =
        problem ??
        (stored !== undefined && stored !== proposal.ipam_pool
          ? `ipam.pool is ${stored} in Dispatch, the installer chose ${proposal.ipam_pool}`
          : null)
      if (refusal)
        return fatal(conn, {
          code: 'VALIDATION_FAILED',
          close: closeCodes.revoked,
          explanation: `The installer's values were refused: ${refusal}.`,
          fix: 'Reinstall so that the installer and Dispatch start from the same ipam.pool.',
        })
    }
    const registry = db.transaction(() => {
      let allocated: { registry_subnet: string; registry_address: string }
      if (proposal) {
        allocated = {
          registry_subnet: proposal.registry_subnet,
          registry_address: registryAddress(proposal.registry_subnet),
        }
        if (storedSetting(db, 'ipam.pool') === undefined)
          writeSetting(db, 'ipam.pool', proposal.ipam_pool, {
            type: 'station',
            id: stationId,
            client: 'bootstrap-enroll',
          })
      } else allocated = allocateRegistry()
      const enrolled = {
        public_key: body.public_key,
        os: body.os as (typeof station.$inferInsert)['os'],
        arch: body.arch as (typeof station.$inferInsert)['arch'],
        capabilities: body.capabilities,
        routes: body.routes,
        resources: body.resources,
        identity_key: body.identity_key,
        ...allocated,
      }
      if (enrolledWith?.kind === 'row') {
        db.update(station).set(enrolled).where(eq(station.id, stationId)).run()
        db.update(token)
          .set({
            used_at: new Date(),
          })
          .where(eq(token.id, enrolledWith.id))
          .run()
      } else {
        if (enrolledWith?.kind === 'bootstrap')
          db.update(station)
            .set({
              hosts_dispatch: false,
              status: 'offline',
              revoked_at: new Date(),
            })
            .where(and(eq(station.hosts_dispatch, true), isNull(station.revoked_at)))
            .run()
        db.insert(station)
          .values({
            id: stationId,
            name: `station-${stationId.slice(-6).toLowerCase()}`,
            status: 'enrolling',
            hosts_dispatch: true,
            ...enrolled,
          })
          .run()
      }
      return {
        ...allocated,
        adopted: Boolean(proposal),
      }
    })
    send(conn, 'enrolled', {
      station_id: stationId,
      instance_id: instanceId,
      registry_subnet: registry.registry_subnet,
      registry_address: registry.registry_address,
      settings: {
        'ipam.pool': readSetting(db, 'ipam.pool'),
        'ipam.virtual_prefix': readSetting(db, 'ipam.virtual_prefix'),
      },
    })
    log('station.enrolled', {
      station_id: stationId,
      connection: conn.id,
      token: enrolledWith?.kind,
      ...registry,
      skew_ms: verified.skewMs,
      remote: conn.remote,
    })
    conn.phase = 'closed'
    conn.ws.close(closeCodes.normal, 'enrolled')
  }

  const onHello = (conn: Connection, envelope: RawEnvelope) => {
    const body = envelope.body as MessageBody<'hello'>
    const now = Date.now()
    const st = db.select().from(station).where(eq(station.id, body.station_id)).get()
    const verified = verifyHello(body, st, conn.challenge, now)
    if (!verified.ok) return fatal(conn, verified.refusal)
    const stationId = st!.id
    const instanceId = readSetting(db, 'instance.id')!
    const older = byStation.get(stationId)
    if (older && older !== conn) {
      log('station.duplicate', {
        station_id: stationId,
        older: older.id,
        newer: conn.id,
      })
      sendError(older, {
        code: 'PROTOCOL_DUPLICATE_CONNECTION',
        explanation: 'A newer connection authenticated for this station.',
        fix: 'Run one stationd per station.',
      })
      older.ws.close(closeCodes.duplicateConnection, 'PROTOCOL_DUPLICATE_CONNECTION')
      older.phase = 'closed'
    }
    conn.stationId = stationId
    conn.sessionId = randomUUID()
    conn.epoch = body.outbox.epoch
    conn.capabilities = new Set(
      body.capabilities.filter((c) => (dispatchCapabilities as string[]).includes(c)),
    )
    conn.versionSkew = skewOf(version, body.stationd_version)
    conn.applied =
      body.applied.status && body.applied.status !== 'rejected' ? body.applied.number : 0
    conn.phase = 'ready'
    byStation.set(stationId, conn)
    db.update(station)
      .set({
        version_skew: conn.versionSkew,
      })
      .where(eq(station.id, stationId))
      .run()
    const resume = committedSeq(db, stationId, conn.epoch)
    const rule = reconnectRule(db, stationId, body.applied)
    conn.withheld = rule.kind === 'drift'
    const latest = latestGeneration(db, stationId)
    send(conn, 'welcome', {
      session_id: conn.sessionId,
      protocol: protocolVersion,
      capabilities: [...conn.capabilities],
      version_skew: conn.versionSkew,
      resume_from_seq: resume,
      instance_id: instanceId,
      desired: {
        number: latest?.generation ?? 0,
        hash: latest?.hash ?? null,
      },
    })
    log('station.welcome', {
      station_id: stationId,
      connection: conn.id,
      session_id: conn.sessionId,
      skew_ms: verified.skewMs,
      skew_recorded: Math.abs(verified.skewMs) > recordSkewMs,
      applied: body.applied,
      outbox: body.outbox,
      resume_from_seq: resume,
      reconnect_rule: rule.kind,
      capabilities: [...conn.capabilities],
      version_skew: conn.versionSkew,
      remote: conn.remote,
    })
    syncGeneration(conn)
    scheduleBuilds(conn)
    scheduleRuns(conn)
  }

  const onMessage = (conn: Connection, data: RawData, isBinary: boolean) => {
    conn.alive = true
    if (conn.phase === 'closed') return
    if (isBinary) {
      if (conn.phase === 'ready') onBinary(conn, toBuffer(data))
      return
    }
    const text = toBuffer(data).toString()
    if (conn.phase === 'ready' && Buffer.byteLength(text) > limits.textFrameBytes) {
      return sendError(conn, {
        code: 'PROTOCOL_MESSAGE_TOO_LARGE',
        explanation: `a text frame of ${Buffer.byteLength(text)} bytes exceeds ${limits.textFrameBytes}`,
        fix: 'Split the message.',
      })
    }
    const decoded = decode(text)
    if (conn.phase === 'challenged') {
      clearTimeout(conn.challengeTimer)
      const type = decoded.ok ? decoded.envelope.type : decoded.envelope?.type
      if (type !== 'hello' && type !== 'enroll')
        return fatal(conn, {
          code: 'PROTOCOL_AUTH_FAILED',
          close: closeCodes.authFailed,
          explanation: `the first message must be hello or enroll, got ${type ?? 'an undecodable frame'}`,
          fix: 'Answer the challenge with hello.',
        })
      if (!decoded.ok)
        return fatal(conn, {
          code: 'PROTOCOL_INVALID_MESSAGE',
          close: closeCodes.authFailed,
          explanation: decoded.explanation,
          fix: 'Upgrade stationd.',
          details: {
            issues: decoded.issues,
          },
        })
      return type === 'hello' ? onHello(conn, decoded.envelope) : onEnroll(conn, decoded.envelope)
    }
    if (!decoded.ok)
      return sendError(
        conn,
        {
          code: decoded.code,
          explanation: decoded.explanation,
          fix: 'Send a message that matches the catalog.',
          details: {
            issues: decoded.issues,
          },
        },
        decoded.envelope?.id ?? null,
      )
    try {
      onReady(conn, decoded.envelope, Buffer.byteLength(text))
    } catch (error) {
      log('station.message_failed', {
        station_id: conn.stationId,
        type: decoded.envelope.type,
        explanation: (error as Error).message,
        stack: (error as Error).stack,
      })
      sendError(
        conn,
        {
          code: 'PROTOCOL_INVALID_MESSAGE',
          explanation: `Dispatch could not process ${decoded.envelope.type}: ${(error as Error).message}`,
          fix: 'Read the Dispatch log.',
        },
        decoded.envelope.id,
      )
    }
  }

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const now = Date.now()
    const conn: Connection = {
      id: randomUUID(),
      ws,
      remote: req.socket.remoteAddress ?? '',
      phase: 'challenged',
      challenge: issueChallenge(now),
      challengeTimer: setTimeout(() => {
        if (conn.phase === 'challenged')
          fatal(conn, {
            code: 'PROTOCOL_REPLAY',
            close: closeCodes.authFailed,
            explanation: 'no hello or enroll arrived within 30 s of the challenge',
            fix: 'Answer the challenge within 30 s.',
          })
      }, challengeTimeoutMs),
      alive: true,
      capabilities: new Set(),
      versionSkew: 'ok',
      applied: 0,
      sentGeneration: 0,
      withheld: false,
      delivered: new Set(),
      undeliverable: new Set(),
      requestedBuilds: new Set(),
      requestedRuns: new Set(),
      pending: new Map(),
      ack: {
        upTo: 0,
        count: 0,
      },
      stats: {
        applied: 0,
        duplicate: 0,
        firstSeq: null,
        lastSeq: null,
      },
      streams: new Map(),
      streamOut: [],
      streamPaused: false,
    }
    connections.add(conn)
    ws.on('pong', () => (conn.alive = true))
    ws.on('message', (data, isBinary) => onMessage(conn, data, isBinary))
    ws.on('error', (error) =>
      log('station.socket_error', {
        connection: conn.id,
        station_id: conn.stationId ?? null,
        explanation: error.message,
      }),
    )
    ws.on('close', (code, reason) => {
      clearTimeout(conn.challengeTimer)
      flushAck(conn)
      connections.delete(conn)
      if (conn.stationId && byStation.get(conn.stationId) === conn) byStation.delete(conn.stationId)
      for (const p of conn.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error('the station connection closed'))
      }
      clearTimeout(conn.streamTimer)
      for (const stream of [...conn.streams.values()])
        endStream(conn, stream, 'connection_closed', false)
      conn.phase = 'closed'
      log('station.closed', {
        connection: conn.id,
        station_id: conn.stationId ?? null,
        code,
        reason: reason.toString(),
        records: conn.stats,
      })
    })
    const { text } = encode(
      'challenge',
      {
        nonce: conn.challenge.nonce.toString('base64url'),
        dispatch_time: new Date(now).toISOString(),
      },
      {
        generation: 0,
      },
    )
    ws.send(text)
  })

  const pinger = setInterval(() => {
    for (const conn of connections) {
      if (!conn.alive) {
        log('station.terminated', {
          connection: conn.id,
          station_id: conn.stationId ?? null,
          reason: 'no frame and no pong between two pings',
        })
        conn.ws.terminate()
        continue
      }
      conn.alive = false
      conn.ws.ping()
    }
  }, pingIntervalMs)

  const acker = setInterval(() => {
    for (const conn of connections) flushAck(conn)
  }, ackEveryMs)

  const liveness = setInterval(() => {
    const now = Date.now()
    const stale = db
      .select()
      .from(station)
      .where(
        and(eq(station.status, 'online'), lt(station.last_seen_at, new Date(now - offlineAfterMs))),
      )
      .all()
    for (const st of stale) {
      const asleep = st.intermittent
      if (asleep && now - st.last_seen_at!.getTime() < asleepAfterMs) continue
      const status = asleep ? 'asleep' : 'offline'
      db.update(station)
        .set({
          status,
        })
        .where(eq(station.id, st.id))
        .run()
      emitEvent(
        db,
        asleep ? 'station.asleep' : 'station.offline',
        {
          entity: 'station',
          id: st.id,
        },
        {
          last_seen_at: st.last_seen_at!.toISOString(),
        },
      )
      log(`station.${status}`, {
        station_id: st.id,
        last_seen_at: st.last_seen_at,
      })
    }
  }, 5_000)

  const reconciler = setInterval(() => {
    for (const conn of byStation.values()) {
      try {
        syncGeneration(conn)
        scheduleBuilds(conn)
        scheduleRuns(conn)
      } catch (error) {
        log('reconcile.failed', {
          station_id: conn.stationId,
          explanation: (error as Error).message,
          stack: (error as Error).stack,
        })
      }
    }
  }, reconcileEveryMs)

  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy())
    const status = admissionStatus(req)
    if (status !== null) {
      log('station.upgrade_refused', {
        status,
        path: req.url,
        origin: req.headers.origin ?? null,
        protocols: offeredSubprotocols(req),
      })
      return refuseUpgrade(socket, status)
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  }

  const handleRequest = (req: IncomingMessage, res: ServerResponse) =>
    serveBlob(db, blobDir, req, res)

  const reconcile = (stationId?: string) => {
    for (const conn of stationId
      ? [byStation.get(stationId)].filter((c) => c !== undefined)
      : byStation.values()) {
      syncGeneration(conn)
      scheduleBuilds(conn)
      scheduleRuns(conn)
    }
  }

  const connectionFor = (stationId: string, capability?: Capability) => {
    const conn = byStation.get(stationId)
    if (!conn || conn.phase !== 'ready')
      throw new StationRequestError(
        'STATION_OFFLINE',
        `station ${stationId} is not connected to Dispatch`,
        {
          station_id: stationId,
        },
      )
    if (conn.versionSkew === 'unsupported')
      throw new StationRequestError(
        'STATION_VERSION_SKEW',
        `station ${stationId} runs a stationd outside the supported version window`,
        {
          station_id: stationId,
        },
      )
    if (capability && !conn.capabilities.has(capability))
      throw new StationRequestError(
        'STATION_VERSION_SKEW',
        `station ${stationId} did not negotiate ${capability}; upgrade stationd`,
        {
          station_id: stationId,
          capability,
        },
      )
    return conn
  }

  const failed = (reply: RawEnvelope) => {
    if (reply.type !== 'error') return
    const e = reply.body as MessageBody<'error'>
    throw new StationRequestError(e.code, e.explanation, {
      ...e.details,
      fix: e.fix,
    })
  }

  const ask = async <T extends MessageType>(
    stationId: string,
    type: T,
    body: MessageBody<T>,
    options: { timeoutMs?: number; capability?: Capability } = {},
  ) => {
    const conn = connectionFor(stationId, options.capability)
    let reply: RawEnvelope
    try {
      reply = await request(conn, type, body, options.timeoutMs ?? requestTimeoutMs)
    } catch (error) {
      throw new StationRequestError(
        'STATION_OFFLINE',
        `${type} to station ${stationId} failed: ${(error as Error).message}`,
        {
          station_id: stationId,
        },
      )
    }
    failed(reply)
    return reply
  }

  const openStream = async (
    stationId: string,
    type: StreamRequest,
    body: MessageBody<StreamRequest>,
    handlers: StreamHandlers,
  ): Promise<StreamHandle> => {
    const conn = connectionFor(stationId, streamCapability[type])
    if (conn.streams.size >= limits.concurrentStreams)
      throw new StationRequestError(
        'PROTOCOL_LIMIT',
        `station ${stationId} already has ${limits.concurrentStreams} open streams`,
      )
    let stream: Stream | undefined
    const reply = await request(conn, type, body as never, requestTimeoutMs, (envelope) => {
      if (envelope.type !== 'stream.opened') return
      const opened = envelope.body as MessageBody<'stream.opened'>
      stream = registerStream(conn, opened.stream, opened.window, handlers)
    }).catch((error) => {
      throw new StationRequestError(
        'STATION_OFFLINE',
        `${type} to station ${stationId} failed: ${(error as Error).message}`,
      )
    })
    failed(reply)
    if (!stream)
      throw new StationRequestError(
        'PROTOCOL_INVALID_MESSAGE',
        `station answered ${type} with ${reply.type}`,
      )
    return handleOf(conn, stream)
  }

  const startRun = async (
    stationId: string,
    body: MessageBody<'run.start'>,
    handlers?: StreamHandlers,
  ) => {
    const conn = connectionFor(stationId, body.attach ? 'exec.tty' : undefined)
    let stream: Stream | undefined
    const reply = await request(conn, 'run.start', body, requestTimeoutMs, (envelope) => {
      if (envelope.type !== 'run.accepted' || !handlers) return
      const accepted = envelope.body as MessageBody<'run.accepted'>
      if (accepted.stream !== null)
        stream = registerStream(conn, accepted.stream, limits.streamWindowBytes, handlers)
    }).catch((error) => {
      throw new StationRequestError(
        'STATION_OFFLINE',
        `run.start to station ${stationId} failed: ${(error as Error).message}`,
      )
    })
    failed(reply)
    return {
      accepted: reply.body as MessageBody<'run.accepted'>,
      handle: stream ? handleOf(conn, stream) : null,
    }
  }

  const revoke = (stationId: string, revokedAt: Date) => {
    const conn = byStation.get(stationId)
    if (!conn) return false
    fatal(conn, {
      code: 'STATION_REVOKED',
      close: closeCodes.revoked,
      explanation: `The station was removed at ${revokedAt.toISOString()}.`,
      fix: 'Enroll the host again with a new token from sly stations add.',
    })
    return true
  }

  const runRetention = async (stationId: string) => {
    const conn = byStation.get(stationId)
    if (!conn || !conn.capabilities.has('registry.v1'))
      return {
        requested: 0,
        pruned: 0,
      }
    const items = retentionItems(db, stationId)
    if (!items.length)
      return {
        requested: 0,
        pruned: 0,
      }
    const reply = await request(
      conn,
      'registry.delete',
      {
        items,
      },
      120_000,
    )
    failed(reply)
    const result = reply.body as MessageBody<'registry.delete.result'>
    const pruned = recordDeletes(db, stationId, result)
    log('registry.delete', {
      station_id: stationId,
      requested: items.length,
      deleted: result.items.filter((i) => i.status === 'deleted').length,
      absent: result.items.filter((i) => i.status === 'absent').length,
      failed: result.items.filter((i) => i.status === 'failed').length,
      deployments_pruned: pruned,
    })
    return {
      requested: items.length,
      pruned,
    }
  }

  const runGc = async (stationId: string, reason: 'schedule' | 'disk_pressure') => {
    const reply = await ask(
      stationId,
      'registry.gc',
      {
        reason,
      },
      {
        capability: 'registry.v1',
      },
    )
    log('registry.gc', {
      station_id: stationId,
      reason,
      reply: reply.type,
    })
    return reply.type
  }

  const retentionPending = new Set<string>()
  const scheduleRetention = (stationId: string) => {
    if (retentionPending.has(stationId)) return
    retentionPending.add(stationId)
    setTimeout(() => {
      retentionPending.delete(stationId)
      runRetention(stationId).catch((error) =>
        log('registry.retention_failed', {
          station_id: stationId,
          explanation: (error as Error).message,
        }),
      )
    }, 2_000).unref()
  }

  let gcPattern: { text: string; cron: Cron } | null = null
  let gcCheckedAt = new Date()
  const gcTick = () => {
    const text = readSetting(db, 'registry.gc_schedule')
    if (gcPattern?.text !== text) {
      try {
        gcPattern = {
          text,
          cron: new Cron(text, {
            timezone: 'UTC',
            paused: true,
          }),
        }
      } catch (error) {
        log('registry.gc_schedule_invalid', {
          schedule: text,
          explanation: (error as Error).message,
        })
        gcPattern = null
        return
      }
    }
    const now = new Date()
    const due = gcPattern.cron.nextRun(gcCheckedAt)
    gcCheckedAt = now
    if (!due || due > now) return
    for (const conn of byStation.values()) {
      if (!conn.stationId || !conn.capabilities.has('registry.v1')) continue
      runGc(conn.stationId, 'schedule').catch((error) =>
        log('registry.gc_failed', {
          station_id: conn.stationId,
          explanation: (error as Error).message,
        }),
      )
    }
  }

  const status = () =>
    [...byStation.values()].map((c) => ({
      station_id: c.stationId,
      session_id: c.sessionId,
      applied: c.applied,
      sent_generation: c.sentGeneration,
      withheld: c.withheld,
      capabilities: [...c.capabilities],
      version_skew: c.versionSkew,
      records: c.stats,
    }))

  const close = () =>
    new Promise<void>((resolve) => {
      for (const timer of [pinger, acker, liveness, reconciler, gcTimer, housekeeping])
        clearInterval(timer)
      for (const conn of connections) {
        flushAck(conn)
        conn.ws.close(closeCodes.goingAway, 'dispatch shutting down')
      }
      wss.close(() => resolve())
    })

  const gcTimer = setInterval(gcTick, 15_000)
  const housekeeping = setInterval(() => {
    for (const conn of byStation.values()) if (conn.stationId) scheduleRetention(conn.stationId)
    const swept = sweepBlobs(db, blobDir)
    if (swept)
      log('blobs.swept', {
        count: swept,
      })
  }, retentionEveryMs)

  for (const timer of [pinger, acker, liveness, reconciler, gcTimer, housekeeping]) timer.unref()

  const isConnected = (stationId: string) => byStation.get(stationId)?.phase === 'ready'

  const observedOf = (stationId: string) => observedByStation.get(stationId)

  return {
    handleUpgrade,
    handleRequest,
    reconcile,
    startRun,
    ask,
    openStream,
    revoke,
    runRetention,
    runGc,
    scheduleRetention,
    isConnected,
    observedOf,
    status,
    close,
  }
}

export type StationServer = ReturnType<typeof createStationServer>
