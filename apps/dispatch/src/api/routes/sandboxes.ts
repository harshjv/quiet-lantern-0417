import { createHash } from 'node:crypto'
import {
  dnsLogTail,
  probeTimeout,
  sandboxExecLimits,
  SandboxCreateBody,
  SandboxExecBody,
  SandboxPatchBody,
  SandboxShellBody,
  SandboxSnapshotBody,
  SandboxStartBody,
  SandboxStorageGrowRequest,
  SandboxVariablesPatchBody,
  sandboxSizeDefaults,
  type MessageBody
} from '@stationly/protocol'
import type { Static, TSchema } from '@sinclair/typebox'
import { and, desc, eq, gte, inArray, isNull } from 'drizzle-orm'
import { Elysia, t } from 'elysia'
import type { Db } from '../../db/client.ts'
import { newId } from '../../db/ids.ts'
import { run, sandbox, sandbox_snapshot, station, variable } from '../../db/schema.ts'
import { effectivePins } from '../../platform/lockfile.ts'
import { resolveImage, stationArch } from '../../platform/image-source.ts'
import { normalizeEgress, openEgress } from '../../sandboxes/egress.ts'
import { requireDiskRoom, requireQuota } from '../../sandboxes/limits.ts'
import { requestDeletion } from '../../sandboxes/lifecycle.ts'
import { growStorage, requireGrowable } from '../../sandboxes/storage.ts'
import { shapeSandboxSample } from '../../net/connections.ts'
import { probeTarget } from '../../net/explain.ts'
import { sendSandboxProbe } from '../../net/probe.ts'
import { can, requireHuman, requireInstance, requireLevel } from '../access.ts'
import { ChangeSet, commit } from '../changes.ts'
import { audit, type Call } from '../context.ts'
import { requireStationReady } from '../deployments.ts'
import { fail, invalid } from '../errors.ts'
import { project as select } from '../fields.ts'
import { ensureNetwork, ensureSandboxNetwork } from '../ipam.ts'
import { csv, parseTime, warning, type Kit } from '../kit.ts'
import { environmentById, sandboxById, sandboxInEnvironment, snapshotById, stationByRef, type EnvironmentRow, type SandboxContext, type SandboxRow, type SandboxSnapshotRow } from '../lookup.ts'
import { before, collect, getQuery, listQuery } from '../pagination.ts'
import { sandboxResolvedView, SandboxResolved } from '../resolved.ts'
import { sandboxRunOutput, waitForRun } from '../sandbox-runs.ts'
import {
  DnsLog,
  models,
  Page,
  replies,
  Run,
  Sandbox,
  SandboxConnections,
  SandboxCreated,
  SandboxDeleted,
  SandboxExec,
  SandboxNetworkProbe,
  SandboxShell,
  SandboxSnapshotDeleted,
  SandboxVariablesOutcome,
  SandboxMetricSample,
  SandboxSnapshot,
  SandboxSnapshotCreated,
  Staged,
  StorageGrown,
  Variable
} from '../shapes.ts'
import { readSetting } from '../settings.ts'
import { planVariables } from '../variable-changes.ts'
import { stationError } from './runs.ts'

const input = <S extends TSchema>(schema: S) => t.Unsafe<Static<S>>(schema)

const toolchainSource = 'ghcr.io/harshjv/stationly/sandbox-toolchain'

const snapshotWaitMs = 10_000

type RunStatus = (typeof run.$inferSelect)['status']

export const sandboxRoutes = (kit: Kit) => {
  const { db, stations, keyring } = kit.deps
  const tags = ['sandboxes']

  const stationRow = (id: string) => db.select().from(station).where(eq(station.id, id)).get()!

  const requireWrite = (call: Call, ctx: { target: SandboxContext['target']; environment: EnvironmentRow }) => {
    requireLevel(call.principal, ctx.target, 'deploy')
    if (ctx.environment.protected) requireHuman(call.principal, 'A sandbox operation in a protected environment', { environment_id: ctx.environment.id })
  }

  const requireConnected = (stationId: string) => {
    requireStationReady(db, stationId, { placement: false })
    if (!stations.isConnected(stationId)) fail('STATION_OFFLINE', `Station ${stationId} is not connected to Dispatch.`, undefined, { station_id: stationId })
  }

  const conflict = (row: SandboxRow, allowed: string[]) =>
    fail('SANDBOX_STATE_CONFLICT', `Sandbox ${row.name} is ${row.status}, which this operation does not allow.`, `Wait until the sandbox is ${allowed.join(' or ')}, then retry.`, { status: row.status, allowed })

  const shown = (row: SandboxRow, fields?: string) => select(kit.views.sandbox, row, kit.fields(fields))

  const metricsOf = async (row: SandboxRow) => {
    if (row.status !== 'running') return null
    try {
      const reply = await stations.ask(row.station_id, 'metrics.sample', { sandbox_ids: [row.id] }, { capability: 'metrics.v1' })
      const sample = (reply.body as MessageBody<'metrics.sample.result'>).samples.find(s => s.sandbox_id === row.id)
      if (!sample) return null
      const { service_id: _s, deployment_id: _d, restarts: _r, sandbox_id: _b, ...rest } = sample
      return { sandbox_id: row.id, ...rest }
    } catch {
      return null
    }
  }

  const wantsMetrics = (fields: string | undefined) => {
    const tree = kit.fields(fields)
    return Boolean(tree && (tree.has('*') || tree.has('metrics')))
  }

  const present = async (row: SandboxRow, fields: string | undefined) => {
    const body = shown(row, fields)
    return wantsMetrics(fields) ? { ...body, metrics: await metricsOf(row) } : body
  }

  const warningsFor = (row: SandboxRow) => (row.status === 'running' || row.status === 'starting' ? [warning('SANDBOX_SNAPSHOT_CRASH_CONSISTENT', 'The copy holds what reached the disk; data still in process buffers is not in it.')] : [])

  const sourceStateOf = (row: SandboxRow) => (row.desired_state === 'running' && row.status !== 'stopped' && row.status !== 'failed' ? ('running' as const) : ('stopped' as const))

  const rowOf = (id: string) => db.select().from(sandbox).where(eq(sandbox.id, id)).get()!

  const pickStation = (ref: string | undefined) => {
    if (ref) return stationByRef(db, ref)
    const capable = db
      .select()
      .from(station)
      .where(and(isNull(station.revoked_at), eq(station.status, 'online')))
      .all()
      .filter(s => s.capabilities?.sandboxes && stations.isConnected(s.id))
    if (capable.length === 1) return capable[0]!
    if (capable.length === 0) {
      fail('STATION_CAPABILITY_MISSING', 'No online station reports the sandbox capability.', 'Install sandbox support on a station (stationd install --sandbox-device or --sandbox-size) and wait for it to reconnect.', { missing: 'sandboxes' })
    }
    return invalid([{ path: '/station_id', message: `${capable.length} stations report sandboxes; name one of ${capable.map(s => s.name).join(', ')}` }])
  }

  const imageFor = async (st: typeof station.$inferSelect, ref: string | undefined) => {
    if (ref) {
      const resolved = await resolveImage(ref, stationArch(db, st.id), '/image/ref')
      return { ref, digest: resolved.digest }
    }
    const pin = effectivePins(db, st.arch).sandbox_toolchain
    if (!pin?.digest) {
      fail('STATION_CAPABILITY_MISSING', 'The platform lockfile pins no sandbox_toolchain image, so there is no default sandbox image.', 'Upgrade to a release that pins sandbox_toolchain with sly platform upgrade, or name an image.', { missing: 'sandbox_toolchain', source: toolchainSource })
    }
    return { ref: null, digest: pin!.digest! }
  }

  const sourceOf = (call: Call, ctx: { project: { id: string }; environment: EnvironmentRow }, from: NonNullable<Static<typeof SandboxCreateBody>['from']>) => {
    if ('snapshot' in from) {
      const snap = snapshotById(db, from.snapshot)
      requireWrite(call, snap)
      if (snap.project.id !== ctx.project.id) invalid([{ path: '/from/snapshot', message: 'a fork stays inside its project' }])
      if (snap.snapshot.status !== 'ready') fail('SANDBOX_STATE_CONFLICT', `Snapshot ${snap.snapshot.name ?? snap.snapshot.id} is ${snap.snapshot.status}, so it cannot be forked.`, 'Wait until the snapshot is ready, then fork it.', { status: snap.snapshot.status, allowed: ['ready'] })
      return { stationId: snap.snapshot.station_id, image: snap.snapshot.image, size: snap.snapshot.size, settings: snap.snapshot.settings, usedBytes: null, diskFrom: { snapshot_id: snap.snapshot.id }, forkedFrom: { sandbox_id: null, snapshot_id: snap.snapshot.id }, warnings: [] as ReturnType<typeof warning>[] }
    }
    const source = from.sandbox.startsWith('sbx_') ? sandboxById(db, from.sandbox) : null
    const named = source ? null : sandboxInEnvironment(db, ctx.environment.id, from.sandbox)
    const found = source ?? (named ? sandboxById(db, named.id) : null)
    if (!found) return fail('NOT_FOUND', `sandbox ${from.sandbox} does not exist or is not visible to this credential.`)
    requireWrite(call, found)
    if (found.project.id !== ctx.project.id) invalid([{ path: '/from/sandbox', message: 'a fork stays inside its project' }])
    if (found.sandbox.status === 'creating' || found.sandbox.status === 'deleting') conflict(found.sandbox, ['starting', 'running', 'stopping', 'stopped', 'failed'])
    return {
      stationId: found.sandbox.station_id,
      image: found.sandbox.image,
      size: found.sandbox.size,
      settings: { network: found.sandbox.network, docker: found.sandbox.docker, egress: found.sandbox.egress, command: found.sandbox.command, ttl_s: found.sandbox.ttl_s },
      usedBytes: found.sandbox.disk_used_bytes,
      diskFrom: { sandbox_id: found.sandbox.id },
      forkedFrom: { sandbox_id: found.sandbox.id, snapshot_id: null },
      warnings: warningsFor(found.sandbox)
    }
  }

  const poll = async (read: () => { done: boolean }, ms: number, signal: AbortSignal) => {
    const deadline = Date.now() + ms
    while (!read().done && Date.now() < deadline && !signal.aborted) await new Promise(resolve => setTimeout(resolve, 100))
  }

  const envDigest = (keys: string[]) => `sha256:${createHash('sha256').update(JSON.stringify(keys)).digest('hex')}`

  const activeRuns = (sandboxId: string) =>
    db
      .select({ id: run.id })
      .from(run)
      .where(and(eq(run.sandbox_id, sandboxId), inArray(run.status, ['queued', 'running'])))
      .all().length

  const envBytes = (env: Record<string, string>) => Object.entries(env).reduce((sum, [key, value]) => sum + Buffer.byteLength(key) + Buffer.byteLength(value), 0)

  const defaultShell = (row: SandboxRow) => (row.image.ref === null ? ['/bin/bash', '-l'] : ['/bin/sh'])

  return new Elysia({ prefix: '/v1', normalize: false })
    .use(models())
    .get(
      '/environments/:environment/sandboxes',
      async ({ request, params, query }) => {
        const principal = await kit.principal(request)
        const ctx = environmentById(db, params.environment)
        requireLevel(principal, ctx.target, 'read')
        const statuses = csv(query.status)
        const stationId = query.station ? stationByRef(db, query.station).id : undefined
        const page = collect(
          (cursor, size) =>
            db
              .select()
              .from(sandbox)
              .where(
                and(
                  eq(sandbox.environment_id, ctx.environment.id),
                  statuses ? inArray(sandbox.status, statuses as SandboxRow['status'][]) : undefined,
                  stationId ? eq(sandbox.station_id, stationId) : undefined,
                  query.network ? eq(sandbox.network, query.network) : undefined,
                  before(sandbox.id, cursor)
                )
              )
              .orderBy(desc(sandbox.id))
              .limit(size)
              .all(),
          query
        )
        return { items: await Promise.all(page.rows.map(row => present(row, query.fields))), next_cursor: page.next_cursor }
      },
      {
        params: t.Object({ environment: t.String() }),
        query: t.Object({ ...listQuery, status: t.Optional(t.String()), station: t.Optional(t.String()), network: t.Optional(t.Union([t.Literal('isolated'), t.Literal('environment')])) }),
        response: replies({ 200: Page(Sandbox) }),
        detail: { summary: 'List the sandboxes of an environment', tags }
      }
    )
    .get(
      '/sandboxes/:sandbox',
      async ({ request, params, query }) => {
        const principal = await kit.principal(request)
        const ctx = sandboxById(db, params.sandbox)
        requireLevel(principal, ctx.target, 'read')
        return present(ctx.sandbox, query.fields)
      },
      { params: t.Object({ sandbox: t.String() }), query: t.Object(getQuery), response: replies({ 200: Sandbox }), detail: { summary: 'Get a sandbox', tags } }
    )
    .post(
      '/environments/:environment/sandboxes',
      async ({ request, params, body, set }) => {
        const call = await kit.call(request)
        const ctx = environmentById(db, params.environment)
        requireWrite(call, ctx)
        const source = body.from ? sourceOf(call, ctx, body.from) : null
        const st = body.from ? stationRow(source!.stationId) : pickStation(body.station_id)
        if (source && body.station_id !== undefined && stationByRef(db, body.station_id).id !== st.id) invalid([{ path: '/station_id', message: `a fork runs on its source's station ${st.name}` }])
        requireStationReady(db, st.id)
        if (!st.capabilities?.sandboxes) fail('STATION_CAPABILITY_MISSING', `Station ${st.name} reports no sandbox capability.`, 'Install sandbox support on the station, then retry.', { missing: 'sandboxes', station_id: st.id })
        const inherited = source?.settings
        const size = { ...sandboxSizeDefaults, ...(source?.size ?? {}), ...(body.size ?? {}) }
        if (source?.usedBytes != null && size.disk_bytes < source.usedBytes) invalid([{ path: '/size/disk_bytes', message: `the source uses ${source.usedBytes} bytes, more than ${size.disk_bytes}` }])
        const egress = body.egress ? normalizeEgress(body.egress) : (inherited?.egress ?? openEgress())
        const network = body.network ?? inherited?.network ?? 'isolated'
        const docker = body.docker ?? inherited?.docker ?? false
        const command = body.command !== undefined ? body.command : (inherited?.command ?? null)
        const ttl_s = body.ttl_s ?? inherited?.ttl_s ?? 3600
        const start = body.start ?? true
        const image = body.image ? await imageFor(st, body.image.ref) : (source?.image ?? (await imageFor(st, undefined)))
        requireQuota(db, st, { sandboxId: null, newSandbox: true, running: start, memoryBytes: size.memory_bytes })
        requireDiskRoom(st)
        const id = newId('sandbox')
        const name = body.name ?? `sandbox-${id.slice(-6).toLowerCase()}`
        if (sandboxInEnvironment(db, ctx.environment.id, name)) fail('NAME_TAKEN', `Environment ${ctx.environment.name} already has a sandbox named ${name}.`, undefined, { name })
        if (network === 'environment') ensureNetwork(db, ctx.environment.id, st.id)
        else ensureSandboxNetwork(db, st.id)
        const now = new Date()
        db.transaction(tx => {
          const tdb = tx as unknown as Db
          tdb.insert(sandbox)
            .values({
              id,
              environment_id: ctx.environment.id,
              project_id: ctx.project.id,
              station_id: st.id,
              name,
              image,
              command,
              size,
              network,
              docker,
              egress,
              ttl_s,
              desired_state: start ? 'running' : 'stopped',
              stop_at: start ? new Date(now.getTime() + ttl_s * 1000) : null,
              status: start ? 'creating' : 'stopped',
              status_reason: start ? null : 'created_stopped',
              stopped_at: start ? null : now,
              forked_from: source?.forkedFrom ?? null,
              disk_from: source?.diskFrom ?? null,
              created_by: call.principal.actor
            })
            .run()
          if (body.variables?.length) {
            const changes = new ChangeSet()
            planVariables(tdb, keyring, call.principal, changes, { scope: 'sandbox', parent: id, sandboxId: id, target: ctx.target }, { set: body.variables })
            commit({ ...kit.deps, db: tdb }, call, { environment: ctx.environment, protect: false }, changes)
          }
          audit(tdb, call, 'sandbox.create', { entity: 'sandbox', id }, { after: { name, environment_id: ctx.environment.id, station_id: st.id, image, size, network, docker, ttl_s, start, forked_from: source?.forkedFrom ?? null, variables: (body.variables ?? []).map(v => v.key) } })
        })
        stations.reconcile(st.id)
        set.status = 201
        return { ...shown(rowOf(id), undefined), warnings: source?.warnings ?? [] }
      },
      {
        params: t.Object({ environment: t.String() }),
        body: input(SandboxCreateBody),
        response: replies({ 201: SandboxCreated }),
        detail: { summary: 'Create a sandbox, or fork one from a snapshot or a live sandbox disk with from', tags }
      }
    )
    .patch(
      '/sandboxes/:sandbox',
      async ({ request, params, body }) => {
        const call = await kit.call(request)
        const ctx = sandboxById(db, params.sandbox)
        requireWrite(call, ctx)
        const row = ctx.sandbox
        if (!Object.keys(body).length) invalid([{ path: '/', message: 'send at least one of ttl_s, egress, size, network, docker, command' }])
        if (row.status === 'deleting') conflict(row, ['creating', 'starting', 'running', 'stopping', 'stopped', 'failed'])
        const live = row.desired_state === 'running'
        const idle = row.status === 'stopped' || row.status === 'failed'
        if (body.network !== undefined && body.network !== row.network && !idle) conflict(row, ['stopped', 'failed'])
        const size = { ...row.size, ...(body.size ?? {}) }
        if (size.disk_bytes < row.size.disk_bytes && size.disk_bytes < row.disk_used_bytes) invalid([{ path: '/size/disk_bytes', message: `the disk holds ${row.disk_used_bytes} bytes, more than ${size.disk_bytes}` }])
        const st = stationRow(row.station_id)
        if (live && size.memory_bytes > row.size.memory_bytes) requireQuota(db, st, { sandboxId: row.id, newSandbox: false, running: true, memoryBytes: size.memory_bytes })
        const changed: string[] = []
        if (body.size?.cpu_millis !== undefined && size.cpu_millis !== row.size.cpu_millis) changed.push('size.cpu_millis')
        if (body.size?.memory_bytes !== undefined && size.memory_bytes !== row.size.memory_bytes) changed.push('size.memory_bytes')
        if (body.docker !== undefined && body.docker !== row.docker) changed.push('docker')
        if (body.command !== undefined && JSON.stringify(body.command) !== JSON.stringify(row.command)) changed.push('command')
        const ttl_s = body.ttl_s ?? row.ttl_s
        const update = {
          size,
          ttl_s,
          network: body.network ?? row.network,
          docker: body.docker ?? row.docker,
          egress: body.egress ? normalizeEgress(body.egress) : row.egress,
          command: body.command !== undefined ? body.command : row.command,
          ...(body.ttl_s !== undefined && live ? { stop_at: new Date(Date.now() + body.ttl_s * 1000) } : {})
        }
        if (update.network === 'environment' && row.network !== 'environment') ensureNetwork(db, row.environment_id, row.station_id)
        if (update.network === 'isolated' && row.network !== 'isolated') ensureSandboxNetwork(db, row.station_id)
        db.update(sandbox).set(update).where(eq(sandbox.id, row.id)).run()
        audit(db, call, 'sandbox.update', { entity: 'sandbox', id: row.id }, { before: { ttl_s: row.ttl_s, size: row.size, network: row.network, docker: row.docker, egress: row.egress, command: row.command }, after: { ttl_s, size: update.size, network: update.network, docker: update.docker, egress: update.egress, command: update.command } })
        stations.reconcile(row.station_id)
        const restart = live && changed.length > 0
        return { ...shown(rowOf(row.id), undefined), warnings: restart ? [warning('SANDBOX_RESTART_REQUIRED', `${changed.join(', ')} ${changed.length === 1 ? 'is' : 'are'} stored and apply at the next start.`)] : [] }
      },
      {
        params: t.Object({ sandbox: t.String() }),
        body: input(SandboxPatchBody),
        response: replies({ 200: SandboxCreated }),
        detail: { summary: 'Change a sandbox: ttl_s extends from now, egress and disk size apply at once, the rest at the next start', tags }
      }
    )
    .post(
      '/sandboxes/:sandbox/start',
      async ({ request, params, body }) => {
        const call = await kit.call(request)
        const ctx = sandboxById(db, params.sandbox)
        requireWrite(call, ctx)
        const row = ctx.sandbox
        if (row.status === 'deleting') conflict(row, ['stopping', 'stopped', 'failed'])
        requireConnected(row.station_id)
        const ttl_s = body?.ttl_s ?? row.ttl_s
        const starting = row.desired_state === 'running' && (row.status === 'creating' || row.status === 'starting' || row.status === 'running')
        if (starting) {
          if (body?.ttl_s !== undefined) db.update(sandbox).set({ ttl_s, stop_at: new Date(Date.now() + ttl_s * 1000) }).where(eq(sandbox.id, row.id)).run()
        } else {
          requireQuota(db, stationRow(row.station_id), { sandboxId: row.id, newSandbox: false, running: true, memoryBytes: row.size.memory_bytes })
          db.update(sandbox)
            .set({ ttl_s, desired_state: 'running', stop_at: new Date(Date.now() + ttl_s * 1000), status: 'starting', status_reason: null, failure: null, exit_code: null, expiring_notified_at: null })
            .where(eq(sandbox.id, row.id))
            .run()
        }
        audit(db, call, 'sandbox.start', { entity: 'sandbox', id: row.id }, { before: { status: row.status }, after: { ttl_s } })
        stations.reconcile(row.station_id)
        return shown(rowOf(row.id), undefined)
      },
      { params: t.Object({ sandbox: t.String() }), body: t.Optional(input(SandboxStartBody)), response: replies({ 200: Sandbox }), detail: { summary: 'Start a stopped sandbox; ttl_s replaces the stored one', tags } }
    )
    .post(
      '/sandboxes/:sandbox/stop',
      async ({ request, params }) => {
        const call = await kit.call(request)
        const ctx = sandboxById(db, params.sandbox)
        requireWrite(call, ctx)
        const row = ctx.sandbox
        if (row.status === 'deleting') conflict(row, ['creating', 'starting', 'running', 'stopping', 'stopped', 'failed'])
        requireConnected(row.station_id)
        if (row.status !== 'stopped' && row.status !== 'failed') {
          db.update(sandbox)
            .set({ desired_state: 'stopped', stop_at: null, status: 'stopping' })
            .where(eq(sandbox.id, row.id))
            .run()
        }
        audit(db, call, 'sandbox.stop', { entity: 'sandbox', id: row.id }, { before: { status: row.status } })
        stations.reconcile(row.station_id)
        return shown(rowOf(row.id), undefined)
      },
      { params: t.Object({ sandbox: t.String() }), response: replies({ 200: Sandbox }), detail: { summary: 'Stop a sandbox and keep its disk', tags } }
    )
    .delete(
      '/sandboxes/:sandbox',
      async ({ request, params }) => {
        const call = await kit.call(request)
        const ctx = sandboxById(db, params.sandbox)
        requireWrite(call, ctx)
        requireConnected(ctx.sandbox.station_id)
        const kept = requestDeletion(db, ctx.sandbox, { actor: call.principal.actor, reason: 'user' })
        audit(db, call, 'sandbox.delete', { entity: 'sandbox', id: ctx.sandbox.id }, { before: { name: ctx.sandbox.name, status: ctx.sandbox.status }, after: { snapshots_kept: kept } })
        stations.reconcile(ctx.sandbox.station_id)
        return { deleted: true as const, snapshots_kept: kept }
      },
      { params: t.Object({ sandbox: t.String() }), response: replies({ 200: SandboxDeleted }), detail: { summary: 'Delete a sandbox and its disk; its snapshots stay', tags } }
    )
    .post(
      '/sandboxes/:sandbox/exec',
      async ({ request, params, body, set }) => {
        const call = await kit.call(request)
        const ctx = sandboxById(db, params.sandbox)
        requireWrite(call, ctx)
        const row = ctx.sandbox
        if (row.status !== 'running') fail('SANDBOX_NOT_RUNNING', `Sandbox ${row.name} is ${row.status}, so nothing can run in it.`, 'Start the sandbox with start_sandbox, then run the command again.', { status: row.status })
        requireConnected(row.station_id)
        if (activeRuns(row.id) >= sandboxExecLimits.activeRuns) fail('RATE_LIMITED', `Sandbox ${row.name} already has ${sandboxExecLimits.activeRuns} active runs.`, 'Wait for a run to finish, then run again.', { limit: sandboxExecLimits.activeRuns })
        const env = body.env ?? {}
        const issues: { path: string; message: string }[] = []
        if (envBytes(env) > sandboxExecLimits.envBytes) issues.push({ path: '/env', message: `env holds more than ${sandboxExecLimits.envBytes} bytes` })
        if (body.stdin !== undefined && Buffer.from(body.stdin, 'base64url').length > sandboxExecLimits.stdinBytes) issues.push({ path: '/stdin', message: `stdin holds more than ${sandboxExecLimits.stdinBytes} bytes` })
        if (issues.length) invalid(issues)
        const id = newId('run')
        const keys = Object.keys(env).sort()
        if (keys.length) {
          const delivery: MessageBody<'secrets.deliver'> = {
            target: { run_id: id },
            env_digest: envDigest(keys),
            purpose: 'run',
            values: keys.map(key => ({ key, injection: 'env' as const, refs: [], value: Buffer.from(env[key]!, 'utf8').toString('base64url') })),
            redaction: []
          }
          await stations.ask(row.station_id, 'secrets.deliver', delivery, { capability: 'secrets.v1' }).catch(stationError)
        }
        const attach = body.attach ?? false
        db.insert(run)
          .values({
            id,
            service_id: null,
            sandbox_id: row.id,
            deployment_id: null,
            kind: 'exec',
            command: body.command,
            status: 'queued',
            log_ref: `logs/sandboxes/${row.id}/${id}`,
            tty: false,
            actor: call.principal.actor,
            exec: { cwd: body.cwd ?? null, user: body.user ?? null, timeout_s: body.timeout_s ?? sandboxExecLimits.timeoutS.default, stdin: body.stdin ?? null, env_keys: keys, attach }
          })
          .run()
        audit(db, call, 'sandbox.exec', { entity: 'run', id }, { after: { sandbox_id: row.id, command: body.command, env_keys: keys, attach } })
        stations.reconcile(row.station_id)
        set.status = 201
        if (attach) return { ...select(kit.views.run, db.select().from(run).where(eq(run.id, id)).get()!, undefined), attach_url: `/v1/runs/${id}/attach` }
        const finished = await waitForRun(kit, id, body.wait_s ?? 10, request.signal)
        const shownRun = select(kit.views.run, finished, kit.fields('failure'))
        if (finished.status === 'queued' || finished.status === 'running') return shownRun
        const output = await sandboxRunOutput(kit, finished, call)
        return output ? { ...shownRun, output } : shownRun
      },
      {
        params: t.Object({ sandbox: t.String() }),
        body: input(SandboxExecBody),
        response: replies({ 201: SandboxExec }),
        detail: { summary: 'Run a command in a running sandbox and wait up to wait_s for it; env values are never stored', tags }
      }
    )
    .post(
      '/sandboxes/:sandbox/shells',
      async ({ request, params, body, set }) => {
        const call = await kit.call(request)
        const ctx = sandboxById(db, params.sandbox)
        requireWrite(call, ctx)
        const row = ctx.sandbox
        if (row.status !== 'running') fail('SANDBOX_NOT_RUNNING', `Sandbox ${row.name} is ${row.status}, so no shell can open in it.`, 'Start the sandbox with start_sandbox, then open the shell.', { status: row.status })
        requireConnected(row.station_id)
        const command = body.command ?? defaultShell(row)
        const id = newId('run')
        db.insert(run)
          .values({
            id,
            service_id: null,
            sandbox_id: row.id,
            deployment_id: null,
            kind: 'shell',
            command,
            status: 'queued',
            log_ref: `logs/sandboxes/${row.id}/${id}`,
            tty: true,
            actor: call.principal.actor,
            exec: { cwd: body.cwd ?? null, user: body.user ?? null, timeout_s: null, stdin: null, env_keys: [], attach: true }
          })
          .run()
        audit(db, call, 'sandbox.shell', { entity: 'run', id }, { after: { sandbox_id: row.id, command } })
        set.status = 201
        return { ...select(kit.views.run, db.select().from(run).where(eq(run.id, id)).get()!, undefined), tty: true, attach_url: `/v1/runs/${id}/attach` }
      },
      {
        params: t.Object({ sandbox: t.String() }),
        body: input(SandboxShellBody),
        response: replies({ 201: SandboxShell }),
        detail: { summary: 'Create a shell run in a sandbox; attach to it over the WebSocket at attach_url', tags }
      }
    )
    .get(
      '/sandboxes/:sandbox/runs',
      async ({ request, params, query }) => {
        const principal = await kit.principal(request)
        const ctx = sandboxById(db, params.sandbox)
        requireLevel(principal, ctx.target, 'read')
        const since = parseTime(query.since, '/since')
        const kinds = csv(query.kind)
        const statuses = csv(query.status)
        const page = collect(
          (cursor, size) =>
            db
              .select()
              .from(run)
              .where(
                and(
                  eq(run.sandbox_id, ctx.sandbox.id),
                  kinds ? inArray(run.kind, kinds as (typeof run.$inferSelect)['kind'][]) : undefined,
                  statuses ? inArray(run.status, statuses as RunStatus[]) : undefined,
                  since ? gte(run.created_at, since) : undefined,
                  before(run.id, cursor)
                )
              )
              .orderBy(desc(run.id))
              .limit(size)
              .all(),
          query
        )
        return { items: page.rows.map(row => select(kit.views.run, row, kit.fields(query.fields))), next_cursor: page.next_cursor }
      },
      {
        params: t.Object({ sandbox: t.String() }),
        query: t.Object({ ...listQuery, kind: t.Optional(t.String()), status: t.Optional(t.String()), since: t.Optional(t.String()) }),
        response: replies({ 200: Page(Run) }),
        detail: { summary: 'List the runs of a sandbox', tags }
      }
    )
    .get(
      '/sandboxes/:sandbox/metrics',
      async ({ request, params }) => {
        const principal = await kit.principal(request)
        const ctx = sandboxById(db, params.sandbox)
        requireLevel(principal, ctx.target, 'read')
        const reply = await stations.ask(ctx.sandbox.station_id, 'metrics.sample', { sandbox_ids: [ctx.sandbox.id] }, { capability: 'metrics.v1' }).catch(stationError)
        const sample = (reply.body as MessageBody<'metrics.sample.result'>).samples.find(s => s.sandbox_id === ctx.sandbox.id)
        if (!sample) fail('NOT_FOUND', `${ctx.sandbox.name} reports no metrics.`, 'Start the sandbox, then read metrics again.', { sandbox_id: ctx.sandbox.id, status: ctx.sandbox.status })
        const { service_id: _s, deployment_id: _d, restarts: _r, sandbox_id: _b, ...rest } = sample!
        return { sandbox_id: ctx.sandbox.id, ...rest }
      },
      { params: t.Object({ sandbox: t.String() }), response: replies({ 200: SandboxMetricSample }), detail: { summary: 'Latest live metrics sample of a sandbox', tags } }
    )
    .get(
      '/sandboxes/:sandbox/variables',
      async ({ request, params, query }) => {
        const principal = await kit.principal(request)
        const ctx = sandboxById(db, params.sandbox)
        requireLevel(principal, ctx.target, 'read')
        const rows = db.select().from(variable).where(and(eq(variable.scope, 'sandbox'), eq(variable.sandbox_id, ctx.sandbox.id))).all()
        return { items: rows.sort((a, b) => a.key.localeCompare(b.key)).map(row => select(kit.views.variable, row, kit.fields(query.fields))), next_cursor: null }
      },
      { params: t.Object({ sandbox: t.String() }), query: t.Object(getQuery), response: replies({ 200: Page(Variable) }), detail: { summary: 'List the variables of a sandbox; values are never listed', tags } }
    )
    .get(
      '/sandboxes/:sandbox/variables/resolved',
      async ({ request, params }) => {
        const call = await kit.call(request)
        const ctx = sandboxById(db, params.sandbox)
        requireLevel(call.principal, ctx.target, 'read')
        return sandboxResolvedView(kit, call, ctx, { admin: can(call.principal, ctx.target, 'admin') }) as Static<typeof SandboxResolved>
      },
      { params: t.Object({ sandbox: t.String() }), response: replies({ 200: SandboxResolved }), detail: { summary: "The resolved variables of a sandbox with their sources; a value only with admin and never a sealed one", tags } }
    )
    .patch(
      '/sandboxes/:sandbox/variables',
      async ({ request, params, body }) => {
        const call = await kit.call(request)
        const ctx = sandboxById(db, params.sandbox)
        requireLevel(call.principal, ctx.target, 'deploy')
        if (ctx.environment.protected) requireHuman(call.principal, 'A sandbox variable change in a protected environment', { environment_id: ctx.environment.id })
        if (ctx.sandbox.status === 'deleting') conflict(ctx.sandbox, ['creating', 'starting', 'running', 'stopping', 'stopped', 'failed'])
        const changes = new ChangeSet()
        planVariables(db, keyring, call.principal, changes, { scope: 'sandbox', parent: ctx.sandbox.id, sandboxId: ctx.sandbox.id, target: ctx.target }, body)
        if (changes.empty) return { variables: [] }
        const result = commit(kit.deps, call, { environment: ctx.environment, protect: false }, changes)
        if (!result.applied) fail('INTERNAL_ERROR', 'a sandbox variable change was staged, which sandbox operations never are')
        const ids = result.applied ? [...Object.values(result.refs), ...changes.changes.flatMap(c => (c.op === 'update' ? [c.id] : []))].filter(id => id.startsWith('var_')) : []
        audit(db, call, 'sandbox.variables', { entity: 'sandbox', id: ctx.sandbox.id }, { after: { set: (body.set ?? []).map(v => v.key), unset: body.unset ?? [] } })
        stations.reconcile(ctx.sandbox.station_id)
        const rows = ids.map(id => db.select().from(variable).where(eq(variable.id, id)).get()).filter((row): row is typeof variable.$inferSelect => row !== undefined)
        return { variables: rows.map(row => select(kit.views.variable, row, undefined)) }
      },
      {
        params: t.Object({ sandbox: t.String() }),
        body: input(SandboxVariablesPatchBody),
        response: replies({ 200: SandboxVariablesOutcome }),
        detail: { summary: "Set and unset a sandbox's variables; references to project and global variables keep values out of the agent's hands", tags }
      }
    )
    .get(
      '/sandboxes/:sandbox/connections',
      async ({ request, params, query }) => {
        const call = await kit.call(request)
        const ctx = sandboxById(db, params.sandbox)
        requireLevel(call.principal, ctx.target, 'read')
        const reply = await stations.ask(ctx.sandbox.station_id, 'network.sample', { sandbox_ids: [ctx.sandbox.id] }, { capability: 'network.v1', timeoutMs: 10_000 }).catch(stationError)
        const sample = (reply.body as MessageBody<'network.sample.result'>).samples.find(s => s.sandbox_id === ctx.sandbox.id)
        if (!sample) fail('NOT_FOUND', `The station returned no connection sample for ${ctx.sandbox.name}.`, 'Start the sandbox, then read the connections again.', { sandbox_id: ctx.sandbox.id })
        return shapeSandboxSample({ db, redaction: kit.redaction, sandboxRedaction: kit.sandboxRedaction, actor: call.principal.actor, requestId: call.request_id }, sample!, ctx.sandbox, query.direction)
      },
      {
        params: t.Object({ sandbox: t.String() }),
        query: t.Object({ direction: t.Optional(t.Union([t.Literal('in'), t.Literal('out')])) }),
        response: replies({ 200: SandboxConnections }),
        detail: { summary: 'Live connections and refused attempts of a sandbox; one sample', tags }
      }
    )
    .get(
      '/sandboxes/:sandbox/dns-log',
      async ({ request, params, query }) => {
        const call = await kit.call(request)
        const ctx = sandboxById(db, params.sandbox)
        requireLevel(call.principal, ctx.target, 'read')
        const reply = await stations
          .ask(ctx.sandbox.station_id, 'dns.log', { sandbox_id: ctx.sandbox.id, tail: query.tail ?? dnsLogTail.default, ...(query.name ? { name: query.name } : {}), ...(query.rcode ? { rcode: query.rcode } : {}) }, { capability: 'network.v1', timeoutMs: 10_000 })
          .catch(stationError)
        const redact = kit.sandboxRedaction([ctx.sandbox.id], call.principal.actor, call.request_id)
        const entries = (reply.body as MessageBody<'dns.log.result'>).entries.map(e => ({ ...e, deployment_id: e.deployment_id ?? null, name: redact(e.name) }))
        return { untrusted: { source: 'resolver log' as const, entries } }
      },
      {
        params: t.Object({ sandbox: t.String() }),
        query: t.Object({ tail: t.Optional(t.Numeric({ minimum: 1, maximum: dnsLogTail.max })), name: t.Optional(t.String({ minLength: 1, maxLength: 253 })), rcode: t.Optional(t.String({ minLength: 1, maxLength: 16 })) }),
        response: replies({ 200: DnsLog }),
        detail: { summary: "The sandbox's recent DNS queries from the resolver's ring, newest first, as untrusted data", tags }
      }
    )
    .post(
      '/sandboxes/:sandbox/network/probe',
      async ({ request, params, body }) => {
        const call = await kit.call(request)
        const ctx = sandboxById(db, params.sandbox)
        requireWrite(call, ctx)
        if (ctx.sandbox.status !== 'running') conflict(ctx.sandbox, ['running'])
        kit.probeLimit(ctx.sandbox.id, ctx.environment.id)
        const kind = body.kind ?? 'tcp'
        const target = probeTarget(db, ctx.environment, body.to, body.port, kind)
        return sendSandboxProbe(kit.deps, call, ctx.sandbox, { kind, to: target.to, port: target.port, timeout_s: body.timeout_s ?? probeTimeout.defaultS })
      },
      {
        params: t.Object({ sandbox: t.String() }),
        body: t.Object(
          {
            to: t.String({ minLength: 1, maxLength: 260 }),
            port: t.Optional(t.Integer({ minimum: 1, maximum: 65535 })),
            kind: t.Optional(t.Union([t.Literal('tcp'), t.Literal('dns')])),
            timeout_s: t.Optional(t.Integer({ minimum: probeTimeout.minS, maximum: probeTimeout.maxS }))
          },
          { additionalProperties: false }
        ),
        response: replies({ 200: SandboxNetworkProbe }),
        detail: { summary: "Ask the sandbox's resolver as the sandbox, or judge one TCP handshake with the sandbox ruleset and send it from the station when the ruleset accepts the destination", tags }
      }
    )
    .post(
      '/sandboxes/:sandbox/snapshots',
      async ({ request, params, body, set }) => {
        const call = await kit.call(request)
        const ctx = sandboxById(db, params.sandbox)
        requireWrite(call, ctx)
        const row = ctx.sandbox
        if (row.status === 'creating' || row.status === 'deleting') conflict(row, ['starting', 'running', 'stopping', 'stopped', 'failed'])
        requireConnected(row.station_id)
        requireDiskRoom(stationRow(row.station_id))
        const name = body?.name ?? null
        if (name && db.select({ id: sandbox_snapshot.id }).from(sandbox_snapshot).where(and(eq(sandbox_snapshot.environment_id, row.environment_id), eq(sandbox_snapshot.name, name))).get()) {
          fail('NAME_TAKEN', `Environment ${ctx.environment.name} already has a snapshot named ${name}.`, undefined, { name })
        }
        const id = newId('sandbox_snapshot')
        db.insert(sandbox_snapshot)
          .values({ id, sandbox_id: row.id, environment_id: row.environment_id, project_id: row.project_id, station_id: row.station_id, name, image: row.image, size: row.size, settings: { network: row.network, docker: row.docker, egress: row.egress, command: row.command, ttl_s: row.ttl_s }, source_state: sourceStateOf(row), status: 'creating', created_by: call.principal.actor })
          .run()
        audit(db, call, 'sandbox.snapshot', { entity: 'sandbox_snapshot', id }, { after: { sandbox_id: row.id, name, source_state: sourceStateOf(row) } })
        stations.reconcile(row.station_id)
        await poll(() => ({ done: db.select({ status: sandbox_snapshot.status }).from(sandbox_snapshot).where(eq(sandbox_snapshot.id, id)).get()?.status !== 'creating' }), snapshotWaitMs, request.signal)
        set.status = 201
        const created = db.select().from(sandbox_snapshot).where(eq(sandbox_snapshot.id, id)).get()!
        return { ...select(kit.views.sandboxSnapshot, created, undefined), warnings: warningsFor(row) }
      },
      {
        params: t.Object({ sandbox: t.String() }),
        body: t.Optional(input(SandboxSnapshotBody)),
        response: replies({ 201: SandboxSnapshotCreated }),
        detail: { summary: "Take a read-only copy of a sandbox's disk; files on the disk, credentials included, are copied into every snapshot and fork", tags }
      }
    )
    .get(
      '/sandboxes/:sandbox/snapshots',
      async ({ request, params, query }) => {
        const principal = await kit.principal(request)
        const ctx = sandboxById(db, params.sandbox)
        requireLevel(principal, ctx.target, 'read')
        return listSnapshots(query, and(eq(sandbox_snapshot.sandbox_id, ctx.sandbox.id), eq(sandbox_snapshot.environment_id, ctx.environment.id)))
      },
      {
        params: t.Object({ sandbox: t.String() }),
        query: t.Object({ ...listQuery, status: t.Optional(t.String()) }),
        response: replies({ 200: Page(SandboxSnapshot) }),
        detail: { summary: 'List the snapshots of a sandbox', tags }
      }
    )
    .get(
      '/environments/:environment/sandbox-snapshots',
      async ({ request, params, query }) => {
        const principal = await kit.principal(request)
        const ctx = environmentById(db, params.environment)
        requireLevel(principal, ctx.target, 'read')
        const source = query.sandbox ? (query.sandbox.startsWith('sbx_') ? query.sandbox : sandboxInEnvironment(db, ctx.environment.id, query.sandbox)?.id) : undefined
        if (query.sandbox && !source) return { items: [], next_cursor: null }
        return listSnapshots(query, and(eq(sandbox_snapshot.environment_id, ctx.environment.id), source ? eq(sandbox_snapshot.sandbox_id, source) : undefined))
      },
      {
        params: t.Object({ environment: t.String() }),
        query: t.Object({ ...listQuery, sandbox: t.Optional(t.String()), status: t.Optional(t.String()) }),
        response: replies({ 200: Page(SandboxSnapshot) }),
        detail: { summary: 'List the sandbox snapshots of an environment', tags }
      }
    )
    .get(
      '/sandbox-snapshots/:id',
      async ({ request, params, query }) => {
        const principal = await kit.principal(request)
        const ctx = snapshotById(db, params.id)
        requireLevel(principal, ctx.target, 'read')
        return select(kit.views.sandboxSnapshot, ctx.snapshot, kit.fields(query.fields))
      },
      { params: t.Object({ id: t.String() }), query: t.Object(getQuery), response: replies({ 200: SandboxSnapshot }), detail: { summary: 'Get a sandbox snapshot', tags } }
    )
    .delete(
      '/sandbox-snapshots/:id',
      async ({ request, params }) => {
        const call = await kit.call(request)
        const ctx = snapshotById(db, params.id)
        requireWrite(call, ctx)
        requireConnected(ctx.snapshot.station_id)
        if (ctx.snapshot.status === 'failed') db.delete(sandbox_snapshot).where(eq(sandbox_snapshot.id, ctx.snapshot.id)).run()
        else db.update(sandbox_snapshot).set({ status: 'deleting' }).where(eq(sandbox_snapshot.id, ctx.snapshot.id)).run()
        audit(db, call, 'sandbox.snapshot_delete', { entity: 'sandbox_snapshot', id: ctx.snapshot.id }, { before: { status: ctx.snapshot.status, name: ctx.snapshot.name } })
        stations.reconcile(ctx.snapshot.station_id)
        return { deleted: true as const }
      },
      { params: t.Object({ id: t.String() }), response: replies({ 200: SandboxSnapshotDeleted }), detail: { summary: 'Delete a sandbox snapshot', tags } }
    )
    .post(
      '/stations/:station/sandbox-storage/grow',
      async ({ request, params, body, set }) => {
        const call = await kit.call(request)
        requireInstance(call.principal, 'admin')
        const st = stationByRef(db, params.station)
        const before = requireGrowable(st, body.size_bytes).filesystem_bytes
        if (Boolean(readSetting<boolean>(db, 'platform.protected')) && !call.principal.human) {
          const changes = new ChangeSet()
          changes.add('sandbox_storage', st.id, { size_bytes: body.size_bytes })
          const result = commit(kit.deps, call, { environment: null, protect: true }, changes)
          if (!result.applied) return kit.stagedBody(result, set)
        }
        const grown = await growStorage({ db, stations }, st.id, body.size_bytes, stationError)
        audit(db, call, 'sandbox.storage_grow', { entity: 'station', id: st.id }, { before: { filesystem_bytes: before }, after: { filesystem_bytes: grown.filesystem_bytes } })
        return { filesystem_bytes: grown.filesystem_bytes, filesystem_free_bytes: grown.filesystem_free_bytes }
      },
      {
        params: t.Object({ station: t.String() }),
        body: input(SandboxStorageGrowRequest),
        response: replies({ 200: StorageGrown, 202: Staged }),
        detail: { summary: "Grow a station's sandbox filesystem to size_bytes while sandboxes run; staged for a non-human actor under platform.protected", tags }
      }
    )

  function listSnapshots(query: { limit?: number; cursor?: string; fields?: string; status?: string }, scope: ReturnType<typeof and>) {
    const statuses = csv(query.status)
    const page = collect(
      (cursor, size) =>
        db
          .select()
          .from(sandbox_snapshot)
          .where(and(scope, statuses ? inArray(sandbox_snapshot.status, statuses as SandboxSnapshotRow['status'][]) : undefined, before(sandbox_snapshot.id, cursor)))
          .orderBy(desc(sandbox_snapshot.id))
          .limit(size)
          .all(),
      query
    )
    return { items: page.rows.map(row => select(kit.views.sandboxSnapshot, row, kit.fields(query.fields))), next_cursor: page.next_cursor }
  }
}
