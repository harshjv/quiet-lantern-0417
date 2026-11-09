import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { sandboxExecLimits } from '@stationly/protocol'
import { eq } from 'drizzle-orm'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { authenticate, type Principal } from '../auth/principal.ts'
import { run } from '../db/schema.ts'
import { StationRequestError, type StreamHandle } from '../station/server.ts'
import { can, requireHuman } from './access.ts'
import { assignRequestId, audit, type Deps } from './context.ts'
import { ApiError } from './errors.ts'
import { runOwner, sandboxById } from './lookup.ts'

const attachPath = /^\/v1\/runs\/(run_[0-9A-HJKMNP-TV-Z]{26})\/attach$/
const forwardPath = /^\/v1\/sandboxes\/(sbx_[0-9A-HJKMNP-TV-Z]{26})\/forward$/
const exitWaitMs = 10_000

const requestOf = (req: IncomingMessage) => {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || key === 'upgrade' || key === 'connection' || key.startsWith('sec-websocket')) continue
    headers.set(key, Array.isArray(value) ? value.join(', ') : value)
  }
  return new Request(`http://${req.headers.host ?? '127.0.0.1'}${req.url ?? '/'}`, { method: 'GET', headers })
}

const refuse = (socket: Duplex, error: ApiError, requestId: string) => {
  const body = JSON.stringify({ error: { code: error.code, explanation: error.message, fix: error.fix, details: error.details, request_id: requestId } })
  socket.end(`HTTP/1.1 ${error.status} ${error.code}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
}

const sameActor = (a: { type: string; id: string | null } | null, b: { type: string; id: string | null }) => !!a && a.type === b.type && a.id === b.id

const toBuffer = (data: RawData) => (Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data as ArrayBuffer)]))

const framed = (channel: number, payload: Buffer) => Buffer.concat([Buffer.from([channel]), payload])

export const createAttachServer = (deps: Deps) => {
  const { db, stations } = deps
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false })
  const sessions = new Set<WebSocket>()
  const forwards = new Map<string, number>()

  const pathOf = (req: IncomingMessage) => new URL(req.url ?? '/', 'http://dispatch').pathname

  const matches = (req: IncomingMessage) => attachPath.test(pathOf(req)) || forwardPath.test(pathOf(req))

  const admit = async (req: IncomingMessage) => {
    const request = requestOf(req)
    const requestId = assignRequestId(request)
    const runId = attachPath.exec(new URL(request.url).pathname)![1]!
    const principal: Principal = await authenticate(db, deps.auth, request)
    const r = db.select().from(run).where(eq(run.id, runId)).get()
    if (!r) throw new ApiError('NOT_FOUND', `run ${runId} does not exist or is not visible to this credential.`)
    const owner = runOwner(db, r)
    if (!can(principal, owner.target, 'deploy')) throw new ApiError('FORBIDDEN_SCOPE', 'Attaching to a shell needs deploy on its environment.', undefined, { required: { ...owner.target, level: 'deploy' } })
    const attachable = r.kind === 'shell' || (r.kind === 'exec' && r.exec?.attach === true)
    if (!attachable) throw new ApiError('VALIDATION_FAILED', `run ${runId} is a ${r.kind} run; only shells and execs created with attach attach.`)
    if (!sameActor(r.actor, principal.actor)) throw new ApiError('FORBIDDEN_SCOPE', 'Only the actor that created the shell can attach to it.')
    if (r.status !== 'queued') throw new ApiError('VALIDATION_FAILED', `run ${runId} is ${r.status}; a shell attaches once, before it starts.`)
    const url = new URL(request.url)
    const rows = Number(url.searchParams.get('rows') ?? 24) || 24
    const cols = Number(url.searchParams.get('cols') ?? 80) || 80
    return { request, requestId, principal, run: r, owner, rows, cols }
  }

  const admitForward = async (req: IncomingMessage) => {
    const request = requestOf(req)
    const requestId = assignRequestId(request)
    const url = new URL(request.url)
    const sandboxId = forwardPath.exec(url.pathname)![1]!
    const principal: Principal = await authenticate(db, deps.auth, request)
    const ctx = sandboxById(db, sandboxId)
    if (!can(principal, ctx.target, 'deploy')) throw new ApiError('FORBIDDEN_SCOPE', 'Forwarding a sandbox port needs deploy on its environment.', undefined, { required: { ...ctx.target, level: 'deploy' } })
    if (ctx.environment.protected) requireHuman(principal, 'A port forward in a protected environment', { environment_id: ctx.environment.id })
    if (ctx.sandbox.status !== 'running') {
      throw new ApiError('SANDBOX_NOT_RUNNING', `Sandbox ${ctx.sandbox.name} is ${ctx.sandbox.status}, so no port can be forwarded.`, 'Start the sandbox with start_sandbox, then forward again.', { status: ctx.sandbox.status })
    }
    const port = Number(url.searchParams.get('port'))
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ApiError('VALIDATION_FAILED', 'port must be an integer from 1 to 65535.', undefined, { issues: [{ path: '/port', message: 'must be an integer from 1 to 65535' }] })
    }
    if ((forwards.get(sandboxId) ?? 0) >= sandboxExecLimits.forwards) {
      throw new ApiError('RATE_LIMITED', `Sandbox ${ctx.sandbox.name} already has ${sandboxExecLimits.forwards} forwards open.`, 'Close one forward, then open another.', { limit: sandboxExecLimits.forwards })
    }
    if (!stations.isConnected(ctx.sandbox.station_id)) throw new ApiError('STATION_OFFLINE', `Station ${ctx.sandbox.station_id} is not connected to Dispatch.`, undefined, { station_id: ctx.sandbox.station_id })
    return { request, requestId, principal, ctx, port }
  }

  const session = async (ws: WebSocket, admitted: Awaited<ReturnType<typeof admit>>) => {
    const { run: r, principal, requestId } = admitted
    sessions.add(ws)
    const stationId = admitted.owner.station_id
    let handle: StreamHandle | null = null
    let owed = 0
    let closed = false
    const credit = (bytes: number) => (handle ? handle.credit(bytes) : (owed += bytes))
    const sendControl = (body: Record<string, unknown>) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(body))
    }
    const finish = async (reason: string, exitCode: number | null) => {
      const terminal = (status: string) => ['succeeded', 'failed', 'cancelled', 'skipped'].includes(status)
      const deadline = Date.now() + exitWaitMs
      let row = db.select().from(run).where(eq(run.id, r.id)).get()!
      while (exitCode === null && !terminal(row.status) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100))
        row = db.select().from(run).where(eq(run.id, r.id)).get()!
      }
      const status = terminal(row.status) || exitCode === null ? row.status : exitCode === 0 ? 'succeeded' : 'failed'
      sendControl({ type: 'exit', run_id: r.id, status, exit_code: exitCode ?? row.exit_code, reason })
      if (ws.readyState === ws.OPEN) ws.close(1000, 'exited')
    }
    const inbox: Array<[Buffer, boolean]> = []
    let handleMessage: ((buf: Buffer, isBinary: boolean) => void) | null = null
    ws.on('message', (data: RawData, isBinary: boolean) => {
      const buf = toBuffer(data)
      if (handleMessage) handleMessage(buf, isBinary)
      else inbox.push([buf, isBinary])
    })
    try {
      const started = await stations.startRun(
        stationId,
        {
          run_id: r.id,
          service_id: r.service_id,
          deployment_id: r.deployment_id,
          kind: r.kind,
          command: r.command,
          tty: r.tty,
          attach: true,
          rows: r.tty ? admitted.rows : null,
          cols: r.tty ? admitted.cols : null,
          actor: principal.actor,
          ...(r.sandbox_id
            ? {
                sandbox_id: r.sandbox_id,
                ...(r.exec?.user ? { user: r.exec.user } : {}),
                ...(r.exec?.cwd ? { cwd: r.exec.cwd } : {}),
                ...(r.exec?.timeout_s ? { timeout_s: r.exec.timeout_s } : {}),
                ...(r.exec?.stdin ? { stdin: r.exec.stdin } : {})
              }
            : {})
        },
        {
          onBinary: (channel, payload) => {
            if (ws.readyState !== ws.OPEN) return
            ws.send(framed(channel, payload), { binary: true }, () => credit(payload.length))
          },
          onEnd: (reason, exitCode) => {
            if (!closed) void finish(reason, exitCode)
          }
        }
      )
      handle = started.handle
      if (!handle) throw new StationRequestError('PROTOCOL_INVALID_MESSAGE', 'run.accepted carried no stream for an attached run')
      if (owed) handle.credit(owed)
      audit(db, { principal, request_id: requestId, idempotency_key: null }, 'run.attach', { entity: 'run', id: r.id }, { after: { stream: handle.stream, tty: r.tty } })
      sendControl({ type: 'attached', run_id: r.id, stream: handle.stream, tty: r.tty })
    } catch (error) {
      const explanation = error instanceof Error ? error.message : String(error)
      sendControl({ type: 'error', code: error instanceof StationRequestError ? error.code : 'STATION_OFFLINE', explanation })
      ws.close(1011, 'run.start failed')
      sessions.delete(ws)
      return
    }
    handleMessage = (buf, isBinary) => {
      if (isBinary) {
        if (buf.length === 0) return
        handle!.write(buf[0]!, buf.subarray(1))
        return
      }
      let message: { type?: string; rows?: number; cols?: number }
      try {
        message = JSON.parse(buf.toString('utf8'))
      } catch {
        return
      }
      if (message.type === 'resize' && message.rows && message.cols) void handle!.resize(message.rows, message.cols).catch(() => undefined)
      if (message.type === 'eof') handle!.write(0, Buffer.alloc(0))
    }
    for (const [buf, isBinary] of inbox.splice(0)) handleMessage(buf, isBinary)
    ws.on('close', () => {
      closed = true
      sessions.delete(ws)
      handle?.cancel()
    })
  }

  const forwardSession = async (ws: WebSocket, admitted: Awaited<ReturnType<typeof admitForward>>) => {
    const { ctx, port, principal, requestId } = admitted
    const sandboxId = ctx.sandbox.id
    sessions.add(ws)
    forwards.set(sandboxId, (forwards.get(sandboxId) ?? 0) + 1)
    let handle: StreamHandle | null = null
    let owed = 0
    let closed = false
    const credit = (bytes: number) => (handle ? handle.credit(bytes) : (owed += bytes))
    const sendControl = (body: Record<string, unknown>) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(body))
    }
    ws.on('close', () => {
      closed = true
      sessions.delete(ws)
      forwards.set(sandboxId, Math.max(0, (forwards.get(sandboxId) ?? 1) - 1))
      handle?.cancel()
    })
    const inbox: Buffer[] = []
    let ready = false
    const deliver = (buf: Buffer) => {
      if (buf.length > 0) handle!.write(buf[0]!, buf.subarray(1))
    }
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (!isBinary) return
      const buf = toBuffer(data)
      if (ready) deliver(buf)
      else inbox.push(buf)
    })
    try {
      handle = await stations.openStream(ctx.sandbox.station_id, 'forward.open', { sandbox_id: sandboxId, port }, {
        onBinary: (channel, payload) => {
          if (ws.readyState !== ws.OPEN) return
          ws.send(framed(channel, payload), { binary: true }, () => credit(payload.length))
        },
        onEnd: reason => {
          if (closed) return
          sendControl({ type: 'end', reason })
          if (ws.readyState === ws.OPEN) ws.close(1000, reason)
        }
      })
      if (owed) handle.credit(owed)
      if (closed) handle.cancel()
      audit(db, { principal, request_id: requestId, idempotency_key: null }, 'sandbox.forward', { entity: 'sandbox', id: sandboxId }, { after: { port } })
      sendControl({ type: 'forwarding', sandbox_id: sandboxId, port })
    } catch (error) {
      sendControl({ type: 'error', code: error instanceof StationRequestError ? error.code : 'STATION_OFFLINE', explanation: error instanceof Error ? error.message : String(error) })
      ws.close(1011, 'forward.open failed')
      return
    }
    ready = true
    for (const buf of inbox.splice(0)) deliver(buf)
  }

  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy())
    const forward = forwardPath.test(pathOf(req))
    const fail = (error: unknown) => {
      const apiError = error instanceof ApiError ? error : new ApiError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error))
      refuse(socket, apiError, `req_attach`)
    }
    if (forward) {
      admitForward(req)
        .then(admitted => wss.handleUpgrade(req, socket, head, ws => void forwardSession(ws, admitted)))
        .catch(fail)
      return
    }
    admit(req)
      .then(admitted => wss.handleUpgrade(req, socket, head, ws => void session(ws, admitted)))
      .catch(fail)
  }

  const close = () => {
    for (const ws of sessions) ws.close(1001, 'dispatch shutting down')
    wss.close()
  }

  return { matches, handleUpgrade, close }
}
