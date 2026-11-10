import { createPrivateKey, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'

import WebSocket from 'ws'

import { newId } from '../../src/db/ids.ts'
import { enrollMessage, helloMessage } from '../../src/station/handshake.ts'
import { toBuffer } from '../../src/station/server.ts'

type SandboxDoc = {
  hash: string
  name: string
  environment_id: string
  status: 'active' | 'destroy'
  desired_state: 'running' | 'stopped'
  stop_at: string | null
  network: string
  env_digest: string
  size: { cpu_millis: number; memory_bytes: number; disk_bytes: number }
  egress: { mode: string; domains: { domain: string; wildcard: boolean; ports: number[] }[] }
  image: { ref: string | null; digest: string; image_ref: string }
  disk: { from: unknown }
  reach: string[]
}

type SandboxSnapshotDoc = { hash: string; sandbox_id: string; status: 'active' | 'destroy' }

type Doc = {
  number: number
  hash: string
  environments: Record<string, { hash: string; network: { subnet: string } }>
  services: Record<
    string,
    {
      hash: string
      name: string
      environment_id: string
      kind: string
      desired_state: string
      current: { deployment_id: string } | null
    }
  >
  deployments: Record<
    string,
    { service_id: string; from_deployment_id: string | null; cancel: unknown }
  >
  gateway: {
    hash: string
    routes: Record<string, { hash: string; hostname: string; tls: unknown }>
  }
  port_allocations: Record<string, { hash: string }>
  station: {
    concurrency_cap: number
    intermittent?: boolean
    public_address: string | null
    settings: Record<string, unknown>
    sandbox_network?: { bridge_name: string; subnet: string; gateway: string } | null
  }
  sandboxes?: Record<string, SandboxDoc>
  sandbox_snapshots?: Record<string, SandboxSnapshotDoc>
}

type RouteConfig = {
  result?: string
  failure?: unknown
  blocked_by?: string
  certificate?: unknown
  probe?: unknown
}

export type FakeStationConfig = {
  hold?: string[]
  mismatch?: string[]
  silent?: boolean
  secret_name?: string
  routes?: Record<string, RouteConfig>
  autoFinish?: boolean
  verdict?: { verdict: string; path: string; rule: string }
  runOutput?: string[]
  sandboxes?: {
    hold?: boolean
    interactiveShell?: boolean
    growFailure?: { step: string | null; error: string }
    runOutput?: (command: string[], env: Record<string, string>) => string[]
  }
}

export type StationMessage = { type: string; id: string; body: Record<string, unknown> }

type Keys = { station_id: string; key: string }

const resources = {
  cpu_millis: 4000,
  memory_bytes: 274877906944,
  disk_bytes: 1e10,
  disk_free_bytes: 1e10,
}
const capabilities = {
  kernel: '6.8.0-fake',
  docker_version: '29.0.0',
  stationd_version: '0.0.0',
}
const sandboxCapability = {
  runsc_version: 'release-20261102.0',
  platform: 'systrap',
  filesystem_backing: 'loop_file',
  filesystem_bytes: 107374182400,
  filesystem_free_bytes: 85899345920,
  filesystem_max_bytes: 214748364800,
}
const withSandboxes = (enabled: boolean) =>
  enabled
    ? {
        ...capabilities,
        sandboxes: sandboxCapability,
      }
    : capabilities
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
const rawKey = (key: KeyObject) =>
  Buffer.from(
    (
      key.export({
        format: 'jwk',
      }) as { x: string }
    ).x,
    'base64url',
  ).toString('base64url')
const envelope = (type: string, body: unknown, ref: string | null = null) =>
  JSON.stringify({
    type,
    id: newId('message'),
    ref,
    generation: 0,
    sent_at: new Date().toISOString(),
    body,
  })
const prefixOf = (subnet: string) => subnet.split('/')[0]!.split('.').slice(0, 3).join('.')

const connect = (url: string) =>
  new Promise<{ ws: WebSocket; nonce: Buffer }>((resolve, reject) => {
    const ws = new WebSocket(
      `${url.replace(/^http/, 'ws')}/v1/stations/connect`,
      'stationly.station.v1',
    )
    ws.once('message', (data) =>
      resolve({
        ws,
        nonce: Buffer.from(JSON.parse(toBuffer(data).toString()).body.nonce, 'base64url'),
      }),
    )
    ws.once('error', reject)
  })

export const enrollFakeStation = async (
  url: string,
  enrollToken: string,
  sandboxes = false,
): Promise<Keys> => {
  const identity = generateKeyPairSync('ed25519')
  const wireguard = generateKeyPairSync('ed25519')
  const { ws, nonce } = await connect(url)
  const timestamp = Date.now()
  const signature = sign(
    null,
    enrollMessage(nonce, enrollToken, timestamp),
    identity.privateKey,
  ).toString('base64url')
  ws.send(
    envelope('enroll', {
      token: enrollToken,
      identity_key: rawKey(identity.publicKey),
      public_key: rawKey(wireguard.publicKey),
      timestamp,
      signature,
      os: 'linux',
      arch: 'arm64',
      capabilities: withSandboxes(sandboxes),
      routes: [],
      resources,
      stationd_version: '0.0.0',
    }),
  )
  const reply = await new Promise<{ type: string; body: Record<string, unknown> }>((resolve) =>
    ws.once('message', (d) => resolve(JSON.parse(toBuffer(d).toString()))),
  )
  await new Promise<void>((resolve) => ws.once('close', () => resolve()))
  if (reply.type !== 'enrolled')
    throw new Error(`fake station enrollment answered ${reply.type}: ${JSON.stringify(reply.body)}`)
  return {
    station_id: reply.body.station_id as string,
    key: identity.privateKey.export({
      format: 'pem',
      type: 'pkcs8',
    }),
  }
}

export class FakeStation {
  readonly stationId: string
  readonly config: FakeStationConfig
  readonly generations: Doc[] = []
  readonly received: StationMessage[] = []
  private readonly ws: WebSocket
  private readonly timers: NodeJS.Timeout[] = []
  private applied = {
    number: 0,
    hash: null as string | null,
    status: null as string | null,
  }
  private seq = 0
  private last: Doc | null = null
  private readonly finished = new Set<string>()
  private readonly held = new Map<string, { blue: string; green: string }>()
  readonly secrets: {
    target: Record<string, string>
    purpose: string
    values: Record<string, string>
    digest: string
  }[] = []
  readonly sandboxStates = new Map<
    string,
    {
      status: string
      started_at: string | null
      stop_at: string | null
      address: string | null
      hash: string
    }
  >()
  readonly sandboxRuns = new Map<string, string[]>()
  readonly forwarded: { sandbox_id: string; port: number; data: string[] }[] = []
  private readonly snapshotsTaken = new Map<string, string>()
  private readonly sandboxEnvs = new Map<string, Record<string, string>>()
  private readonly runEnvs = new Map<string, Record<string, string>>()
  private readonly forwardStreams = new Map<
    number,
    { sandbox_id: string; port: number; data: string[] }
  >()
  private streams = 10
  private readonly shells = new Map<
    number,
    { run_id: string; rows: number; cols: number; line: string }
  >()
  readonly shellResizes: { run_id: string; rows: number; cols: number }[] = []

  private constructor(keys: Keys, ws: WebSocket, config: FakeStationConfig) {
    this.stationId = keys.station_id
    this.ws = ws
    this.config = config
  }

  static async start(url: string, keys: Keys, config: FakeStationConfig = {}) {
    const { ws, nonce } = await connect(url)
    const station = new FakeStation(keys, ws, config)
    station.attach(ws, nonce, keys)
    await station.untilWelcome()
    return station
  }

  static async enrollAndStart(url: string, enrollToken: string, config: FakeStationConfig = {}) {
    return FakeStation.start(
      url,
      await enrollFakeStation(url, enrollToken, Boolean(config.sandboxes)),
      config,
    )
  }

  private welcomed = Promise.withResolvers<void>()

  private untilWelcome() {
    return this.welcomed.promise
  }

  private send(type: string, body: unknown, ref: string | null = null) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(envelope(type, body, ref))
  }

  private record(type: string, body: Record<string, unknown>) {
    this.seq += 1
    this.send(type, {
      seq: this.seq,
      ...body,
    })
  }

  private heartbeat() {
    this.send('heartbeat', {
      applied: this.applied,
      resources,
      outbox: {
        last_seq: this.seq,
      },
      services: {},
    })
  }

  private attach(ws: WebSocket, nonce: Buffer, keys: Keys) {
    const timestamp = Date.now()
    const epoch = newId('station_outbox')
    this.send('hello', {
      station_id: keys.station_id,
      timestamp,
      signature: sign(
        null,
        helloMessage(nonce, keys.station_id, timestamp),
        createPrivateKey(keys.key),
      ).toString('base64url'),
      stationd_version: '0.0.0',
      protocol: 1,
      capabilities: [
        'generation.v1',
        'secrets.v1',
        'logs.follow',
        'metrics.v1',
        'network.v1',
        'exec.tty',
        'forward.tcp',
        ...(this.config.sandboxes ? ['sandbox.v1'] : []),
      ],
      applied: this.applied,
      outbox: {
        epoch,
        first_seq: 0,
        last_seq: 0,
      },
      boot_id: 'test-fake',
      started_at: new Date().toISOString(),
    })
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return this.onMessage(JSON.parse(toBuffer(data).toString()) as StationMessage)
      this.onBinary(toBuffer(data))
    })
    ws.on('close', () => {
      this.stopTimers()
      this.welcomed.reject(new Error('station connection closed before welcome'))
    })
  }

  private stopTimers() {
    for (const timer of this.timers) clearInterval(timer)
    this.timers.length = 0
  }

  async close() {
    this.stopTimers()
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      const closed = new Promise<void>((resolve) => this.ws.once('close', () => resolve()))
      this.ws.close()
      await Promise.race([closed, sleep(500)])
    }
  }

  async waitFor<T>(
    predicate: () => T | undefined | false | null,
    timeoutMs = 5000,
    label = 'condition',
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const value = predicate()
      if (value) return value
      if (Date.now() > deadline) throw new Error(`fake station timed out waiting for ${label}`)
      await sleep(20)
    }
  }

  waitForGeneration(predicate: (doc: Doc) => boolean = () => true, timeoutMs = 5000) {
    return this.waitFor(() => this.generations.find(predicate), timeoutMs, 'a matching generation')
  }

  report() {
    if (this.last) this.send('observed.report', this.observed(this.last))
  }

  private addresses(doc: Doc) {
    const out = new Map<string, string>()
    const byEnv = new Map<string, string[]>()
    for (const [id, svc] of Object.entries(doc.services).sort(([a], [b]) => a.localeCompare(b)))
      byEnv.set(svc.environment_id, [...(byEnv.get(svc.environment_id) ?? []), id])
    for (const [envId, ids] of byEnv)
      ids.forEach((id, i) =>
        out.set(id, `${prefixOf(doc.environments[envId]!.network.subnet)}.${10 + i}`),
      )
    return out
  }

  private step(
    deploymentId: string,
    name: string,
    status: string,
    detail: Record<string, unknown> = {},
  ) {
    this.record('deployment.step', {
      deployment_id: deploymentId,
      step: name,
      status,
      attempt: 1,
      detail,
      started_at: now(),
      finished_at: status === 'done' ? now() : null,
    })
  }

  private rollouts(doc: Doc, addr: Map<string, string>) {
    for (const [id, dep] of Object.entries(doc.deployments)) {
      if (dep.cancel || this.finished.has(id) || this.held.has(id)) continue
      const svc = doc.services[dep.service_id]!
      const blue = addr.get(dep.service_id)!
      const green = `${prefixOf(doc.environments[svc.environment_id]!.network.subnet)}.${100 + [...addr.keys()].indexOf(dep.service_id)}`
      for (const name of ['pull', 'namespace', 'baseline', 'service', 'health']) {
        this.step(id, name, 'running')
        this.step(id, name, 'done')
      }
      this.step(id, 'cutover', 'running')
      this.step(id, 'cutover', 'done', {
        from: dep.from_deployment_id ? blue : null,
        to: green,
      })
      if (this.config.hold?.includes(svc.name) && dep.from_deployment_id) {
        this.step(id, 'drain', 'running', {
          blue,
        })
        this.held.set(id, {
          blue,
          green,
        })
        continue
      }
      this.step(id, 'drain', 'done')
      this.step(id, 'cleanup', 'done')
      this.record('deployment.finished', {
        deployment_id: id,
        status: 'active',
        failure: null,
        cancel_reason: null,
      })
      this.finished.add(id)
    }
  }

  release(deploymentId: string) {
    if (!this.held.delete(deploymentId)) throw new Error(`${deploymentId} is not held`)
    this.step(deploymentId, 'drain', 'done')
    this.step(deploymentId, 'cleanup', 'done')
    this.record('deployment.finished', {
      deployment_id: deploymentId,
      status: 'active',
      failure: null,
      cancel_reason: null,
    })
    this.finished.add(deploymentId)
  }

  heldDeployments() {
    return [...this.held.keys()]
  }

  private observed(doc: Doc) {
    const addr = this.addresses(doc)
    const services: Record<string, unknown> = {}
    for (const [id, svc] of Object.entries(doc.services)) {
      const runs =
        svc.current &&
        svc.desired_state === 'running' &&
        (svc.kind === 'web' || svc.kind === 'worker')
      const hold = [...this.held.entries()].find(
        ([dep]) => doc.deployments[dep]?.service_id === id,
      )?.[1]
      const address = addr.get(id)!
      const container = (role: string) => ({
        role,
        deployment_id: svc.current!.deployment_id,
        run_id: null,
        container_id: `${role}-${id.slice(-6).toLowerCase()}`,
        address,
        state: 'running',
        exit_code: null,
        restarts: 0,
        started_at: now(),
      })
      const switchAddress = !runs
        ? null
        : this.config.mismatch?.includes(svc.name)
          ? `${prefixOf(doc.environments[svc.environment_id]!.network.subnet)}.250`
          : (hold?.green ?? address)
      services[id] = {
        applied_hash: svc.hash,
        result: 'ok',
        status_hint: runs ? 'running' : 'stopped',
        health: runs
          ? {
              state: 'passing',
              consecutive: 3,
              last_check: now(),
            }
          : {
              state: 'none',
              consecutive: 0,
              last_check: null,
            },
        containers: runs ? [container('coupler'), container('service')] : [],
        switch_address: switchAddress,
      }
    }
    return {
      station_id: this.stationId,
      observed_at: now(),
      applied: this.applied,
      station: {
        resources,
        routes: [],
        capabilities: withSandboxes(Boolean(this.config.sandboxes)),
        clock_skew_ms: 0,
        docker_version: '29.0.0',
        registry: {
          state: 'serving',
        },
      },
      components: {},
      environments: Object.fromEntries(
        Object.entries(doc.environments).map(([id, e]) => [
          id,
          {
            applied_hash: e.hash,
            result: 'ok',
            docker_network_id: `net-${id.slice(-6).toLowerCase()}`,
            bridge_up: true,
          },
        ]),
      ),
      services,
      deployments: {},
      volumes: {},
      runs: {},
      gateway: {
        applied_hash: doc.gateway.hash,
        routes: Object.fromEntries(
          Object.entries(doc.gateway.routes).map(([id, r]) => {
            const rc = this.config.routes?.[r.hostname] ?? {}
            const result = rc.result ?? 'ok'
            return [
              id,
              {
                applied_hash: result === 'ok' ? r.hash : null,
                result,
                ...(rc.failure
                  ? {
                      failure: rc.failure,
                    }
                  : {}),
                ...(rc.blocked_by
                  ? {
                      blocked_by: rc.blocked_by,
                    }
                  : {}),
                certificate: r.tls
                  ? (rc.certificate ?? {
                      status: 'pending',
                      not_before: null,
                      expires_at: null,
                      failure: null,
                    })
                  : null,
                probe: rc.probe ?? null,
              },
            ]
          }),
        ),
      },
      port_allocations: Object.fromEntries(
        Object.entries(doc.port_allocations).map(([id, p]) => [
          id,
          {
            applied_hash: p.hash,
            result: 'ok',
          },
        ]),
      ),
      workshops: {},
      system_targets: {},
      ...(this.config.sandboxes ? this.observedSandboxes(doc) : {}),
      unknown: [],
    }
  }

  private nextStream() {
    this.streams += 1
    return this.streams
  }

  private frame(stream: number, channel: number, payload: Buffer | string) {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
    const out = Buffer.alloc(5 + body.length)
    out.writeUInt32BE(stream, 0)
    out.writeUInt8(channel, 4)
    body.copy(out, 5)
    return out
  }

  private sandboxRecord(id: string, status: string, extra: Record<string, unknown> = {}) {
    this.record('sandbox.status', {
      sandbox_id: id,
      status,
      reason: null,
      exit_code: null,
      oom_killed: false,
      started_at: null,
      stopped_at: null,
      failure: null,
      ...extra,
    })
  }

  private observedSandboxes(doc: Doc) {
    return {
      sandboxes: Object.fromEntries(
        Object.entries(doc.sandboxes ?? {}).flatMap(([id, box]) => {
          const state = this.sandboxStates.get(id)
          if (!state) return []
          return [
            [
              id,
              {
                applied_hash: box.hash,
                result: 'ok',
                status: state.status,
                reason: null,
                started_at: state.started_at,
                stop_at: state.stop_at,
                address: state.address,
                disk: {
                  referenced_bytes: 734003200,
                  exclusive_bytes: 524288000,
                  limit_bytes: box.size.disk_bytes,
                },
                runsc_version: sandboxCapability.runsc_version,
              },
            ],
          ]
        }),
      ),
      sandbox_snapshots: Object.fromEntries(
        Object.entries(doc.sandbox_snapshots ?? {}).flatMap(([id, snap]) =>
          this.snapshotsTaken.has(id)
            ? [
                [
                  id,
                  {
                    applied_hash: snap.hash,
                    result: 'ok',
                    taken_at: this.snapshotsTaken.get(id),
                    referenced_bytes: 734003200,
                    exclusive_bytes: 1048576,
                  },
                ],
              ]
            : [],
        ),
      ),
      sandbox_bases: {},
    }
  }

  private applySandboxes(doc: Doc) {
    if (!this.config.sandboxes) return
    for (const [id, box] of Object.entries(doc.sandboxes ?? {})) {
      const state = this.sandboxStates.get(id)
      if (box.status === 'destroy') {
        this.sandboxStates.delete(id)
        this.sandboxRecord(id, 'deleted')
        continue
      }
      const wanted =
        box.desired_state === 'running' &&
        box.stop_at !== null &&
        Date.parse(box.stop_at) > Date.now()
      if (!state)
        this.sandboxStates.set(id, {
          status: 'stopped',
          started_at: null,
          stop_at: null,
          address: null,
          hash: box.hash,
        })
      const current = this.sandboxStates.get(id)!
      current.hash = box.hash
      if (wanted && current.status !== 'running') {
        if (this.config.sandboxes.hold) {
          if (current.status !== 'starting') {
            current.status = 'starting'
            this.sandboxRecord(id, 'creating')
          }
          continue
        }
        const startedAt = now()
        this.sandboxRecord(id, 'creating')
        this.sandboxRecord(id, 'starting')
        this.sandboxRecord(id, 'running', {
          started_at: startedAt,
        })
        Object.assign(current, {
          status: 'running',
          started_at: startedAt,
          stop_at: box.stop_at,
          address: `10.201.0.${10 + this.sandboxStates.size}`,
        })
      } else if (!wanted && current.status === 'running') {
        this.sandboxRecord(id, 'stopping', {
          reason: 'user',
        })
        this.sandboxRecord(id, 'stopped', {
          reason: 'user',
          stopped_at: now(),
        })
        Object.assign(current, {
          status: 'stopped',
          stop_at: null,
          address: null,
        })
      } else if (current.status === 'running') current.stop_at = box.stop_at
    }
    for (const [id, snap] of Object.entries(doc.sandbox_snapshots ?? {})) {
      if (snap.status === 'destroy') {
        this.snapshotsTaken.delete(id)
        this.record('sandbox.snapshot.status', {
          snapshot_id: id,
          status: 'deleted',
          taken_at: null,
          exclusive_bytes: 0,
          referenced_bytes: 0,
          failure: null,
        })
      } else if (!this.snapshotsTaken.has(id) && !this.config.sandboxes.hold) {
        const takenAt = now()
        this.snapshotsTaken.set(id, takenAt)
        this.record('sandbox.snapshot.status', {
          snapshot_id: id,
          status: 'ready',
          taken_at: takenAt,
          exclusive_bytes: 1048576,
          referenced_bytes: 734003200,
          failure: null,
        })
      }
    }
  }

  expireSandbox(
    id: string,
    reason: 'ttl' | 'exited' | 'oom' = 'ttl',
    exitCode: number | null = null,
  ) {
    const state = this.sandboxStates.get(id)
    if (!state || state.status !== 'running')
      throw new Error(`${id} is not running on the fake station`)
    this.sandboxRecord(id, 'stopped', {
      reason,
      stopped_at: now(),
      exit_code: exitCode,
      oom_killed: reason === 'oom',
    })
    Object.assign(state, {
      status: 'stopped',
      stop_at: null,
      address: null,
    })
  }

  failSandbox(id: string, failure: Record<string, unknown>) {
    this.sandboxRecord(id, 'failed', {
      failure,
    })
    const state = this.sandboxStates.get(id)
    if (state)
      Object.assign(state, {
        status: 'failed',
        address: null,
      })
  }

  releaseSandboxes() {
    if (this.config.sandboxes) this.config.sandboxes.hold = false
    if (this.last) this.applySandboxes(this.last)
    this.report()
  }

  private shellOutput(stream: number, text: string) {
    this.ws.send(this.frame(stream, 1, text), {
      binary: true,
    })
  }

  private shellInput(stream: number, payload: string) {
    const shell = this.shells.get(stream)!
    for (const char of payload) {
      if (char !== '\r') {
        shell.line += char
        this.shellOutput(stream, char === '\x7f' ? '\b \b' : char)
        continue
      }
      const line = shell.line.trim()
      shell.line = ''
      this.shellOutput(stream, '\r\n')
      if (line === 'exit') return this.endShell(stream)
      if (line === 'stty size') this.shellOutput(stream, `${shell.rows} ${shell.cols}\r\n`)
      else if (line.startsWith('echo ')) this.shellOutput(stream, `${line.slice(5)}\r\n`)
      else if (line) this.shellOutput(stream, `fake-shell: ${line}: command not found\r\n`)
      this.shellOutput(stream, 'agent@sandbox:~$ ')
    }
  }

  private endShell(stream: number) {
    const shell = this.shells.get(stream)
    if (!shell) return
    this.shells.delete(stream)
    const startedAt = now()
    this.record('run.exited', {
      run_id: shell.run_id,
      status: 'succeeded',
      exit_code: 0,
      started_at: startedAt,
      finished_at: now(),
      failure: null,
    })
    this.send('stream.end', {
      stream,
      reason: 'exited',
      exit_code: 0,
    })
  }

  private onBinary(frame: Buffer) {
    const stream = frame.readUInt32BE(0)
    if (this.shells.has(stream)) return this.shellInput(stream, frame.subarray(5).toString())
    const forward = this.forwardStreams.get(stream)
    if (!forward) return
    const payload = frame.subarray(5)
    forward.data.push(payload.toString())
    this.ws.send(this.frame(stream, 0, payload.toString().toUpperCase()), {
      binary: true,
    })
  }

  private sandboxExec(m: StationMessage) {
    const b = m.body as {
      run_id: string
      sandbox_id: string
      command: string[]
      attach: boolean
      stdin?: string
      kind?: string
      rows?: number | null
      cols?: number | null
    }
    const state = this.sandboxStates.get(b.sandbox_id)
    if (!state || state.status !== 'running')
      return this.send(
        'error',
        {
          code: 'SANDBOX_NOT_RUNNING',
          explanation: `sandbox ${b.sandbox_id} is not running`,
          fix: 'Start the sandbox.',
        },
        m.id,
      )
    const env = {
      ...this.sandboxEnvs.get(b.sandbox_id),
      ...this.runEnvs.get(b.run_id),
    }
    const lines = this.config.sandboxes?.runOutput?.(b.command, env) ?? [`$ ${b.command.join(' ')}`]
    this.sandboxRuns.set(
      b.run_id,
      b.stdin ? [...lines, `stdin: ${Buffer.from(b.stdin, 'base64url').toString()}`] : lines,
    )
    const code = b.command.includes('false') ? 1 : 0
    const finish = (stream: number | null) => {
      const startedAt = now()
      this.record('run.status', {
        run_id: b.run_id,
        status: 'running',
        exit_code: null,
        started_at: startedAt,
        finished_at: null,
        failure: null,
      })
      this.record('run.exited', {
        run_id: b.run_id,
        status: code === 0 ? 'succeeded' : 'failed',
        exit_code: code,
        started_at: startedAt,
        finished_at: now(),
        failure:
          code === 0
            ? null
            : {
                phase: 'run',
                code: 'EXIT_NONZERO',
                summary: `exited ${code}`,
              },
      })
      if (stream !== null)
        this.send('stream.end', {
          stream,
          reason: 'exited',
          exit_code: code,
        })
    }
    if (!b.attach) {
      this.send(
        'run.accepted',
        {
          run_id: b.run_id,
          stream: null,
        },
        m.id,
      )
      if (b.command.includes('sleep')) {
        this.record('run.status', {
          run_id: b.run_id,
          status: 'running',
          exit_code: null,
          started_at: now(),
          finished_at: null,
          failure: null,
        })
        return
      }
      setTimeout(() => finish(null), 20)
      return
    }
    const stream = this.nextStream()
    this.send(
      'run.accepted',
      {
        run_id: b.run_id,
        stream,
      },
      m.id,
    )
    if (b.kind === 'shell' && this.config.sandboxes?.interactiveShell) {
      this.shells.set(stream, {
        run_id: b.run_id,
        rows: b.rows ?? 24,
        cols: b.cols ?? 80,
        line: '',
      })
      this.record('run.status', {
        run_id: b.run_id,
        status: 'running',
        exit_code: null,
        started_at: now(),
        finished_at: null,
        failure: null,
      })
      setTimeout(
        () => this.shellOutput(stream, 'Welcome to the fake sandbox shell\r\nagent@sandbox:~$ '),
        20,
      )
      return
    }
    setTimeout(() => {
      this.ws.send(this.frame(stream, 1, `${this.sandboxRuns.get(b.run_id)!.join('\n')}\n`), {
        binary: true,
      })
      finish(stream)
    }, 20)
  }

  private sampleOf(doc: Doc | null, id: string, at: string) {
    const svc = doc?.services[id]
    const runs = svc && svc.current && svc.desired_state === 'running'
    const base = {
      service_id: id,
      at,
      conntrack: {
        entries: 0,
        truncated: false,
        stale: false,
        lossy: false,
        accounting: true,
        timestamps: true,
      },
      connections: [] as unknown[],
      refused: [] as unknown[],
      refused_truncated: false,
      names: {} as Record<string, string>,
    }
    if (!doc || !svc || !runs)
      return {
        ...base,
        deployment_id: null,
      }
    const peers = Object.entries(doc.services).filter(
      ([pid, p]) => pid !== id && p.environment_id === svc.environment_id && p.current,
    )
    const conn = (
      direction: string,
      peer: Record<string, unknown>,
      port: number,
      protocol: string,
      flows: number,
      k: number,
    ) => ({
      direction,
      peer,
      port,
      protocol,
      flows,
      established: protocol === 'tcp' ? flows : 0,
      bytes_out: 1000 * k,
      bytes_in: 4000 * k,
      bps_out: 200 * k,
      bps_in: 800 * k,
      counters_age_s: 5,
      oldest_s: 60 * k,
    })
    const connections = [
      ...peers.slice(0, 2).map(([pid, p], i) =>
        conn(
          'out',
          {
            kind: 'service',
            service_id: pid,
            deployment_id: p.current!.deployment_id,
          },
          5432 - i,
          'tcp',
          10 - i,
          3 + i,
        ),
      ),
      conn(
        'out',
        {
          kind: 'resolver',
        },
        53,
        'udp',
        2,
        1,
      ),
      conn(
        'in',
        {
          kind: 'gateway',
        },
        3000,
        'tcp',
        24,
        5,
      ),
      conn(
        'in',
        {
          kind: 'internet',
        },
        5432,
        'tcp',
        3,
        2,
      ),
      conn(
        'out',
        {
          kind: 'public',
          address: '93.184.215.14',
        },
        443,
        'tcp',
        2,
        2,
      ),
    ]
    const refused = [
      {
        path: 'host_address',
        address: '10.200.0.1',
        port: 7900,
        protocol: 'tcp',
        count: 3,
        expires_in_s: 590,
      },
      {
        path: 'cloud_metadata',
        address: '169.254.169.254',
        port: 80,
        protocol: 'tcp',
        count: 4,
        expires_in_s: 512,
      },
    ]
    const names: Record<string, string> = {
      '93.184.215.14': 'example.com',
    }
    if (this.config.secret_name && svc.name === 'web')
      names['198.51.100.77'] = `${this.config.secret_name}.leak.example`
    return {
      ...base,
      deployment_id: svc.current!.deployment_id,
      conntrack: {
        ...base.conntrack,
        entries: 41,
      },
      connections,
      refused,
      names,
    }
  }

  private sandboxSample(id: string) {
    return {
      sandbox_id: id,
      at: now(),
      conntrack: {
        entries: 3,
        truncated: false,
        stale: false,
        lossy: false,
        accounting: true,
        timestamps: true,
      },
      connections: [
        {
          direction: 'out',
          peer: {
            kind: 'public',
            address: '104.16.0.1',
          },
          port: 443,
          protocol: 'tcp',
          flows: 2,
          established: 2,
          bytes_out: 2000,
          bytes_in: 9000,
          bps_out: 100,
          bps_in: 400,
          counters_age_s: 5,
          oldest_s: 30,
        },
      ],
      refused: [
        {
          path: 'domain_not_allowed',
          address: '203.0.113.50',
          port: 443,
          protocol: 'tcp',
          count: 2,
          expires_in_s: 300,
        },
      ],
      refused_truncated: false,
      names: {
        '104.16.0.1': 'registry.npmjs.org',
      },
    }
  }

  private onMessage(m: StationMessage) {
    this.received.push(m)
    if (m.type === 'welcome') {
      this.heartbeat()
      this.timers.push(setInterval(() => this.heartbeat(), 2000))
      this.timers.push(setInterval(() => this.last && !this.config.silent && this.report(), 5000))
      this.welcomed.resolve()
    }
    if (m.type === 'error')
      this.welcomed.reject(new Error(`station refused: ${JSON.stringify(m.body)}`))
    if (m.type === 'generation') {
      const doc = m.body as unknown as Doc
      this.last = doc
      this.generations.push(doc)
      this.applied = {
        number: doc.number,
        hash: doc.hash,
        status: 'applied',
      }
      this.send('generation.ack', {
        number: doc.number,
        hash: doc.hash,
        status: 'applied',
        results: [],
        duration_ms: 3,
      })
      if (this.config.autoFinish !== false) this.rollouts(doc, this.addresses(doc))
      this.applySandboxes(doc)
      this.send('observed.report', this.observed(doc))
      this.heartbeat()
    }
    if (m.type === 'network.sample') {
      const body = m.body as { service_ids?: string[]; sandbox_ids?: string[] }
      const boxes = (body.sandbox_ids ?? []).flatMap((id) =>
        this.sandboxStates.get(id)?.status === 'running' ? [this.sandboxSample(id)] : [],
      )
      this.send(
        'network.sample.result',
        {
          samples: [
            ...(body.service_ids ?? []).map((id) => this.sampleOf(this.last, id, now())),
            ...boxes,
          ],
        },
        m.id,
      )
    }
    if (m.type === 'network.inspect') {
      const checks = (m.body as { checks: { kind: string; service_id?: string; port?: number }[] })
        .checks
      const results = checks.map((c) => {
        const dep = c.service_id
          ? (this.last?.services[c.service_id]?.current?.deployment_id ?? null)
          : null
        if (c.kind === 'container')
          return {
            kind: c.kind,
            address: '10.200.0.5',
            state: 'running',
            health: 'none',
            deployment_id: dep,
          }
        if (c.kind === 'verdict')
          return {
            kind: c.kind,
            ...(this.config.verdict ?? {
              verdict: 'accept',
              path: 'same_environment',
              rule: 'same_environment',
            }),
          }
        if (c.kind === 'switch')
          return {
            kind: c.kind,
            address: '10.200.0.5',
            rejected: false,
          }
        if (c.kind === 'listening')
          return {
            kind: c.kind,
            sockets: [
              {
                address: '0.0.0.0',
                port: c.port ?? 5432,
                protocol: 'tcp',
              },
            ],
          }
        return {
          kind: c.kind,
          error: 'unsupported by the fake',
        }
      })
      this.send(
        'network.inspect.result',
        {
          results,
        },
        m.id,
      )
    }
    if (m.type === 'network.probe') {
      const b = m.body as {
        service_id?: string
        sandbox_id?: string
        kind: string
        to: string
        port?: number
      }
      const deployment_id = b.service_id
        ? (this.last?.services[b.service_id]?.current?.deployment_id ?? null)
        : undefined
      const probe =
        b.kind === 'dns'
          ? {
              dns: {
                rcode: 'NOERROR',
                answers: ['100.64.0.2'],
                ms: 0.4,
              },
            }
          : {
              tcp: {
                address: '100.64.0.2',
                result: 'connected',
                ms: 1.2,
              },
              verdict: {
                verdict: 'accept',
                path: 'same_environment',
                rule: 'same_environment',
              },
            }
      this.send(
        'network.probe.result',
        {
          ...(b.service_id
            ? {
                service_id: b.service_id,
              }
            : {
                sandbox_id: b.sandbox_id,
              }),
          ...(deployment_id !== undefined
            ? {
                deployment_id,
              }
            : {}),
          kind: b.kind,
          to: b.to,
          port: b.port ?? null,
          ...probe,
          at: now(),
        },
        m.id,
      )
    }
    const logBody = m.body as { source?: string; run_id?: string; role?: string }
    if (
      m.type === 'logs.query' &&
      logBody.source === 'run' &&
      logBody.run_id &&
      this.sandboxRuns.has(logBody.run_id)
    ) {
      this.send(
        'logs.page',
        {
          lines: this.sandboxRuns.get(logBody.run_id)!.map((text, i) => ({
            at: now(),
            role: 'run',
            stream: 'stdout',
            text,
            level: null,
            cursor: `x${i}`,
          })),
          next_cursor: null,
          truncated: false,
        },
        m.id,
      )
    } else if (m.type === 'logs.query' && logBody.source === 'sandbox') {
      this.send(
        'logs.page',
        {
          lines: [
            {
              at: now(),
              role: logBody.role ?? 'init',
              stream: 'stdout',
              text: 'sandbox init started',
              level: null,
              cursor: 'i1',
            },
          ],
          next_cursor: null,
          truncated: false,
        },
        m.id,
      )
    } else if (
      m.type === 'logs.query' &&
      this.config.runOutput &&
      (m.body as { run_id?: string }).run_id
    ) {
      this.send(
        'logs.page',
        {
          lines: [],
          next_cursor: null,
          truncated: false,
        },
        m.id,
      )
    } else if (m.type === 'logs.follow' && logBody.source === 'sandbox') {
      const stream = this.nextStream()
      this.send(
        'stream.opened',
        {
          stream,
          window: 262144,
        },
        m.id,
      )
      this.send('stream.data', {
        stream,
        items: [
          {
            at: now(),
            role: logBody.role ?? 'init',
            stream: 'stdout',
            text: 'sandbox init started',
            level: null,
            cursor: 'i1',
          },
          {
            at: now(),
            role: logBody.role ?? 'init',
            stream: 'stdout',
            text: 'toolchain ready',
            level: null,
            cursor: 'i2',
          },
        ],
      })
    } else if (m.type === 'logs.follow' && this.config.runOutput) {
      const stream = 2
      this.send(
        'stream.opened',
        {
          stream,
          window: 262144,
        },
        m.id,
      )
      this.send('stream.data', {
        stream,
        items: this.config.runOutput.map((text, i) => ({
          at: now(),
          role: 'run',
          stream: 'stdout',
          text,
          cursor: `r${i}`,
        })),
      })
      this.send('stream.end', {
        stream,
        reason: 'run_finished',
        exit_code: null,
      })
    } else if (m.type === 'logs.query') {
      this.send(
        'logs.page',
        {
          lines: [
            {
              at: now(),
              role: 'service',
              stream: 'stdout',
              text: 'listening on :3000',
              level: null,
              cursor: 'c1',
            },
          ],
          next_cursor: null,
          truncated: false,
        },
        m.id,
      )
    }
    if (m.type === 'metrics.sample') {
      const body = m.body as { service_ids?: string[]; sandbox_ids?: string[] }
      const ids = body.service_ids ?? []
      const boxes = (body.sandbox_ids ?? []).flatMap((id) =>
        this.sandboxStates.get(id)?.status === 'running'
          ? [
              {
                sandbox_id: id,
                container_id: `sbx-${id.slice(-6).toLowerCase()}`,
                at: now(),
                cpu_pct: 2.5,
                memory_bytes: 268435456,
                memory_limit_bytes: 4294967296,
                net_rx_bps: 5,
                net_tx_bps: 7,
                blk_read_bps: 0,
                blk_write_bps: 0,
                restarts: null,
                disk_used_bytes: 734003200,
                disk_limit_bytes: 21474836480,
              },
            ]
          : [],
      )
      const samples = ids.flatMap((id) => {
        const svc = this.last?.services[id]
        if (!svc?.current || svc.desired_state !== 'running') return []
        return [
          {
            service_id: id,
            deployment_id: svc.current.deployment_id,
            container_id: `service-${id.slice(-6).toLowerCase()}`,
            at: now(),
            cpu_pct: 1.5,
            memory_bytes: 1048576,
            memory_limit_bytes: 536870912,
            net_rx_bps: 10,
            net_tx_bps: 20,
            blk_read_bps: 0,
            blk_write_bps: 0,
            restarts: 0,
          },
        ]
      })
      this.send(
        'metrics.sample.result',
        {
          samples: [...samples, ...boxes],
        },
        m.id,
      )
    }
    if (m.type === 'secrets.deliver') {
      const b = m.body as {
        target: Record<string, string>
        purpose: string
        env_digest: string
        values: { key: string; value: string }[]
      }
      const values = Object.fromEntries(
        b.values.map((v) => [v.key, Buffer.from(v.value, 'base64url').toString('utf8')]),
      )
      this.secrets.push({
        target: b.target,
        purpose: b.purpose,
        values,
        digest: b.env_digest,
      })
      if (b.target.sandbox_id) this.sandboxEnvs.set(b.target.sandbox_id, values)
      if (b.target.run_id) this.runEnvs.set(b.target.run_id, values)
      this.send(
        'secrets.ack',
        {
          target: b.target,
          env_digest: b.env_digest,
        },
        m.id,
      )
    }
    if (m.type === 'run.start' && (m.body as { sandbox_id?: string }).sandbox_id)
      this.sandboxExec(m)
    if (m.type === 'run.cancel')
      this.send(
        'run.cancelled',
        {
          run_id: (m.body as { run_id: string }).run_id,
        },
        m.id,
      )
    if (m.type === 'forward.open') {
      const b = m.body as { sandbox_id?: string; port: number }
      const state = b.sandbox_id ? this.sandboxStates.get(b.sandbox_id) : undefined
      if (!b.sandbox_id || !state || state.status !== 'running')
        this.send(
          'error',
          {
            code: 'SANDBOX_NOT_RUNNING',
            explanation: 'the sandbox is not running',
            fix: 'Start the sandbox.',
          },
          m.id,
        )
      else {
        const stream = this.nextStream()
        const record = {
          sandbox_id: b.sandbox_id,
          port: b.port,
          data: [] as string[],
        }
        this.forwarded.push(record)
        this.send(
          'stream.opened',
          {
            stream,
            window: 262144,
          },
          m.id,
        )
        if (b.port === 9)
          this.send('stream.end', {
            stream,
            reason: 'connect_failed',
            exit_code: null,
          })
        else this.forwardStreams.set(stream, record)
      }
    }
    if (m.type === 'stream.cancel') {
      const cancelled = (m.body as { stream: number }).stream
      this.forwardStreams.delete(cancelled)
      this.shells.delete(cancelled)
    }
    if (m.type === 'exec.resize') {
      const b = m.body as { stream: number; rows: number; cols: number }
      const shell = this.shells.get(b.stream)
      if (shell) {
        Object.assign(shell, {
          rows: b.rows,
          cols: b.cols,
        })
        this.shellResizes.push({
          run_id: shell.run_id,
          rows: b.rows,
          cols: b.cols,
        })
      }
      this.send(
        'exec.resized',
        {
          stream: b.stream,
        },
        m.id,
      )
    }
    if (m.type === 'sandbox.storage.grow') {
      const size = (m.body as { size_bytes: number }).size_bytes
      const failure = this.config.sandboxes?.growFailure
      this.send(
        'sandbox.storage.grown',
        failure
          ? {
              status: 'failed',
              step: failure.step,
              error: failure.error,
              filesystem_bytes: sandboxCapability.filesystem_bytes,
              filesystem_free_bytes: sandboxCapability.filesystem_free_bytes,
            }
          : {
              status: 'grown',
              step: null,
              error: null,
              filesystem_bytes: size,
              filesystem_free_bytes: size - 21474836480,
            },
        m.id,
      )
    }
    if (m.type === 'dns.log' && (m.body as { sandbox_id?: string }).sandbox_id) {
      this.send(
        'dns.log.result',
        {
          entries: [
            {
              at: now(),
              deployment_id: null,
              name: 'registry.npmjs.org',
              type: 'A',
              rcode: 'NOERROR',
              answers: ['104.16.0.1'],
              upstream: true,
              ms: 12,
              probe: false,
            },
            {
              at: now(),
              deployment_id: null,
              name: 'evil.example',
              type: 'A',
              rcode: 'NXDOMAIN',
              answers: [],
              upstream: false,
              ms: 0.1,
              probe: false,
              refused: 'domain_not_allowed',
            },
          ],
        },
        m.id,
      )
    } else if (m.type === 'dns.log') {
      const id = (m.body as { service_id: string }).service_id
      const dep = this.last?.services[id]?.current?.deployment_id ?? null
      this.send(
        'dns.log.result',
        {
          entries: [
            {
              at: now(),
              deployment_id: dep,
              name: 'db.internal',
              type: 'A',
              rcode: 'NOERROR',
              answers: ['100.64.0.2'],
              upstream: false,
              ms: 0.4,
              probe: false,
            },
          ],
        },
        m.id,
      )
    }
  }
}
