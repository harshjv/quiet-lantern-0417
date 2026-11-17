import type { Static } from '@sinclair/typebox'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { t } from 'elysia'

import {
  dnsLogTail,
  MachineCreateBody,
  MachineExecBody,
  machineExecLimits,
  machineIdleStatuses,
  MachineKeysPatchBody,
  machineNetworkValues,
  MachinePatchBody,
  MachineShellBody,
  machineSizeDefaults,
  MachineSnapshotBody,
  machineSnapshotStatusValues,
  MachineStartBody,
  machineStatusValues,
  MachineStorageGrowRequest,
  machineTtl,
  networkDirectionValues,
  probeTimeout,
  runActiveStatuses,
  StringEnum,
  workspaceEgress,
  workspaceRoot,
  workspaceSizeDefaults,
  workspaceUser,
  type TaskMachineValue,
} from '@stationly/protocol'
import { releaseRepositories } from '@stationly/protocol/release-config'

import { scopedTokenMaxSeconds } from '../../auth/auth.ts'
import { dropToken, mintToken } from '../../auth/tokens.ts'
import type { Db } from '../../db/client.ts'
import { newId } from '../../db/ids.ts'
import { key, machine, machine_snapshot, run, server } from '../../db/schema.ts'
import { readSetting } from '../../db/settings.ts'
import { shapeMachineSample } from '../../net/connections.ts'
import { probeTarget } from '../../net/explain.ts'
import { sendMachineProbe } from '../../net/probe.ts'
import { resolveImage, stationArch } from '../../platform/image-source.ts'
import { effectivePins } from '../../platform/lockfile.ts'
import {
  egressWithin,
  requireHumanToEnter,
  requireHumanToWiden,
  workspaceHeldBy,
} from '../../sandboxes/confinement.ts'
import { normalizeEgress, openEgress } from '../../sandboxes/egress.ts'
import {
  requestDeletion,
  startMachine,
  stopAtFrom,
  stopMachine,
} from '../../sandboxes/lifecycle.ts'
import { fittingMemory, requireDiskRoom, requireQuota } from '../../sandboxes/limits.ts'
import { requireRepositoryAccess } from '../../sandboxes/repository-access.ts'
import { requireRuntime } from '../../sandboxes/runtime.ts'
import { growStorage, requireGrowable } from '../../sandboxes/storage.ts'
import {
  isRepositoryName,
  machineSetupAs,
  repositoryName,
  setupCommand,
  workspaceKeySets,
  workspacePath,
} from '../../sandboxes/workspace.ts'
import { ephemeralDelivery } from '../../secrets/deliver.ts'
import { keysOf } from '../../secrets/values.ts'
import { gitIdentityOf } from '../../team/members.ts'
import { can, requireHuman, requireLevel } from '../access.ts'
import { ChangeSet, commit, placeName } from '../changes.ts'
import { audit, type Call } from '../context.ts'
import { requireConnected, requireStationReady } from '../deployments.ts'
import { fail, invalid } from '../errors.ts'
import { project as select } from '../fields.ts'
import { ensureMachineNetwork, ensureNetwork } from '../ipam.ts'
import { csv, warning, type Kit } from '../kit.ts'
import {
  machineById,
  machineInTarget,
  previewIdOf,
  scopeOf,
  snapshotById,
  stationByRef,
  type MachineContext,
  type MachineRow,
  type MachineSnapshotRow,
  type ProjectRow,
  type TargetRow,
} from '../lookup.ts'
import { before, collect, filterMany, getQuery, listQuery, previewQuery } from '../pagination.ts'
import { MachineResolved, machineResolvedView } from '../resolved.ts'
import { listRuns, machineRunOutput, pollUntil, runListQuery, runRow, waitForRun } from '../runs.ts'
import { DnsLogQuery, input, ProbeBody } from '../schemas.ts'
import {
  ApprovalDetail,
  DnsLog,
  Key,
  Machine,
  MachineConnections,
  MachineCreated,
  MachineDeleted,
  MachineExec,
  MachineKeysOutcome,
  MachineMetricSample,
  MachineNetworkProbe,
  MachineShell,
  MachineSnapshot,
  MachineSnapshotCreated,
  MachineSnapshotDeleted,
  Page,
  replies,
  Run,
  StorageGrown,
} from '../shapes.ts'
import { planKeys } from '../variable-changes.ts'

import { stationError } from './runs.ts'
import { requireMintable } from './tokens.ts'

const snapshotWaitMs = 10_000

export const machineRoutes = (kit: Kit) => {
  const { db, stations, keyring } = kit.deps

  const stationRow = (id: string) => db.select().from(server).where(eq(server.id, id)).get()!

  const requireHumanIn = (call: Call, row: TargetRow) => {
    if (row.kind === 'production') {
      requireHuman(call.principal, 'A machine operation in production', scopeOf(row))
    }
  }

  const requireWrite = (
    call: Call,
    ctx: { target: MachineContext['target']; target_row: TargetRow },
  ) => {
    requireLevel(call.principal, ctx.target, 'deploy')
    requireHumanIn(call, ctx.target_row)
  }

  const conflict = (row: MachineRow, allowed: string[]) =>
    fail(
      'MACHINE_STATE_CONFLICT',
      `Machine ${row.name} is ${row.status}, which this operation does not allow.`,
      `Wait until the machine is ${allowed.join(' or ')}, then retry.`,
      {
        status: row.status,
        allowed,
      },
    )

  const shown = (row: MachineRow, fields?: string) =>
    select(kit.views.machine, row, kit.fields(fields))

  const metricsOf = async (row: MachineRow) => {
    if (row.status !== 'running') {
      return null
    }

    try {
      const reply = await stations.ask(row.server_id, 'metrics.sample', {
        sandbox_ids: [row.id],
      })
      const sample = reply.body.samples.find((s) => s.sandbox_id === row.id)

      if (!sample) {
        return null
      }

      const { service_id: _s, deployment_id: _d, restarts: _r, sandbox_id: _b, ...rest } = sample

      return {
        machine_id: row.id,
        ...rest,
      }
    } catch {
      return null
    }
  }

  const wantsMetrics = (fields: string | undefined) => {
    const tree = kit.fields(fields)

    return Boolean(tree && (tree.has('*') || tree.has('metrics')))
  }

  const present = async (row: MachineRow, fields: string | undefined) => {
    const body = shown(row, fields)

    return wantsMetrics(fields)
      ? {
          ...body,
          metrics: await metricsOf(row),
        }
      : body
  }

  const warningsFor = (row: MachineRow) =>
    row.status === 'running' || row.status === 'starting'
      ? [
          warning(
            'MACHINE_SNAPSHOT_CRASH_CONSISTENT',
            'The copy holds what reached the disk; data still in process buffers is not in it.',
          ),
        ]
      : []

  const sourceStateOf = (row: MachineRow) =>
    row.desired_state === 'running' && row.status !== 'stopped' && row.status !== 'failed'
      ? ('running' as const)
      : ('stopped' as const)

  const rowOf = (id: string) => db.select().from(machine).where(eq(machine.id, id)).get()!

  const pickStation = (ref: string | undefined) => {
    if (ref) {
      return stationByRef(db, ref)
    }

    const capable = db
      .select()
      .from(server)
      .where(and(isNull(server.revoked_at), eq(server.status, 'online')))
      .all()
      .filter((s) => s.capabilities?.sandboxes && stations.isConnected(s.id))

    if (capable.length === 1) {
      return capable[0]!
    }

    if (capable.length === 0) {
      fail(
        'SERVER_CAPABILITY_MISSING',
        'No online server reports the machine capability.',
        'Install machine support on a server (stationd install --sandbox-device or --sandbox-size) and wait for it to reconnect.',
        {
          missing: 'machines',
        },
      )
    }

    return invalid([
      {
        path: '/server_id',
        message: `${capable.length} servers report machines; name one of ${capable.map((s) => s.name).join(', ')}`,
      },
    ])
  }

  const imageFor = async (st: typeof server.$inferSelect, ref: string | undefined) => {
    if (ref) {
      const resolved = await resolveImage(ref, stationArch(db, st.id), '/image/ref')

      return {
        ref,
        digest: resolved.digest,
      }
    }

    const pin = effectivePins(db, st.arch).sandbox_toolchain

    if (!pin?.digest) {
      fail(
        'SERVER_CAPABILITY_MISSING',
        'The platform lockfile pins no sandbox_toolchain image, so there is no default machine image.',
        'Upgrade to a release that pins sandbox_toolchain with sly platform upgrade, or name an image.',
        {
          missing: 'sandbox_toolchain',
          source: releaseRepositories.sandbox_toolchain,
        },
      )
    }

    return {
      ref: null,
      digest: pin!.digest!,
    }
  }

  const sourceOf = (
    call: Call,
    ctx: { project: { id: string }; target_row: TargetRow },
    from: NonNullable<Static<typeof MachineCreateBody>['from']>,
  ) => {
    if ('snapshot' in from) {
      const snap = snapshotById(db, from.snapshot)

      requireWrite(call, snap)

      if (snap.project.id !== ctx.project.id) {
        invalid([
          {
            path: '/from/snapshot',
            message: 'a fork stays inside its project',
          },
        ])
      }

      if (snap.snapshot.status !== 'ready') {
        fail(
          'MACHINE_STATE_CONFLICT',
          `Snapshot ${snap.snapshot.name ?? snap.snapshot.id} is ${snap.snapshot.status}, so it cannot be forked.`,
          'Wait until the snapshot is ready, then fork it.',
          {
            status: snap.snapshot.status,
            allowed: ['ready'],
          },
        )
      }

      return {
        stationId: snap.snapshot.server_id,
        image: snap.snapshot.image,
        size: snap.snapshot.size,
        runtime: snap.snapshot.runtime,
        settings: snap.snapshot.settings,
        usedBytes: null,
        diskFrom: {
          snapshot_id: snap.snapshot.id,
        },
        forkedFrom: {
          machine_id: null,
          snapshot_id: snap.snapshot.id,
        },
        warnings: [] as ReturnType<typeof warning>[],
      }
    }

    const source = from.machine.startsWith('sbx_') ? machineById(db, from.machine) : null
    const named = source ? null : machineInTarget(db, ctx.target_row.id, from.machine)
    const found = source ?? (named ? machineById(db, named.id) : null)

    if (!found) {
      return fail(
        'NOT_FOUND',
        `machine ${from.machine} does not exist or is not visible to this credential.`,
      )
    }

    requireWrite(call, found)

    if (found.project.id !== ctx.project.id) {
      invalid([
        {
          path: '/from/machine',
          message: 'a fork stays inside its project',
        },
      ])
    }

    if (found.machine.status === 'creating' || found.machine.status === 'deleting') {
      conflict(found.machine, ['starting', 'running', 'stopping', 'stopped', 'failed'])
    }

    return {
      stationId: found.machine.server_id,
      image: found.machine.image,
      size: found.machine.size,
      runtime: found.machine.runtime,
      settings: {
        network: found.machine.network,
        docker: found.machine.docker,
        egress: found.machine.egress,
        command: found.machine.command,
        ttl_s: found.machine.ttl_s,
      },
      usedBytes: found.machine.disk_used_bytes,
      diskFrom: {
        sandbox_id: found.machine.id,
      },
      forkedFrom: {
        machine_id: found.machine.id,
        snapshot_id: null,
      },
      warnings: warningsFor(found.machine),
    }
  }

  const activeRuns = (machineId: string) =>
    db
      .select({
        id: run.id,
      })
      .from(run)
      .where(and(eq(run.machine_id, machineId), inArray(run.status, [...runActiveStatuses])))
      .all().length

  const envBytes = (env: Record<string, string>) =>
    Object.entries(env).reduce(
      (sum, [key, value]) => sum + Buffer.byteLength(key) + Buffer.byteLength(value),
      0,
    )

  const noTtl = (workspace: object | null | undefined, ttl: number | undefined) => {
    if (workspace && ttl !== undefined) {
      invalid([
        {
          path: '/ttl_s',
          message: 'a workspace has no time to live',
        },
      ])
    }
  }

  const workspaceDefault = (row: MachineRow, value: string) => (row.workspace ? value : null)

  const defaultShell = (row: MachineRow) =>
    row.image.ref === null ? ['/bin/bash', '-l'] : ['/bin/sh']

  type WorkspaceOptions = {
    taskBranch?: string | null
    kind?: TaskMachineValue
    memoryBytes?: number
    repositoryReadable?: boolean
  }

  const createMachine = async (
    call: Call,
    ctx: { project: ProjectRow; target_row: TargetRow; target: MachineContext['target'] },
    body: Static<typeof MachineCreateBody>,
    options: WorkspaceOptions = {},
  ) => {
    const taskBranch = options.taskBranch ?? null
    const kind = options.kind ?? 'own'

    requireHumanIn(call, ctx.target_row)
    const source = body.from ? sourceOf(call, ctx, body.from) : null
    const st = body.from ? stationRow(source!.stationId) : pickStation(body.server_id)

    if (source && body.server_id !== undefined && stationByRef(db, body.server_id).id !== st.id) {
      invalid([
        {
          path: '/server_id',
          message: `a fork runs on its source's server ${st.name}`,
        },
      ])
    }

    requireStationReady(db, st.id)

    if (!st.capabilities?.sandboxes) {
      fail(
        'SERVER_CAPABILITY_MISSING',
        `Server ${st.name} reports no machine capability.`,
        'Install machine support on the server, then retry.',
        {
          missing: 'machines',
          server_id: st.id,
        },
      )
    }

    const runtime = requireRuntime(st, body.runtime ?? source?.runtime)
    const inherited = source?.settings
    const size = {
      ...machineSizeDefaults,
      memory_bytes: fittingMemory(
        db,
        st,
        body.workspace ? (options.memoryBytes ?? workspaceSizeDefaults.memory_bytes) : undefined,
      ),
      ...source?.size,
      ...body.size,
    }

    if (source?.usedBytes != null && size.disk_bytes < source.usedBytes) {
      invalid([
        {
          path: '/size/disk_bytes',
          message: `the source uses ${source.usedBytes} bytes, more than ${size.disk_bytes}`,
        },
      ])
    }

    const wanted = body.workspace

    noTtl(wanted, body.ttl_s)

    if (wanted && !isRepositoryName(repositoryName(wanted.repository))) {
      invalid([
        {
          path: '/workspace/repository',
          message: 'the last path segment, without .git, needs at least one letter or digit',
        },
      ])
    }

    if (wanted && !options.repositoryReadable) {
      await requireRepositoryAccess(kit.deps, {
        project: ctx.project,
        target: ctx.target_row.id,
        repository: wanted.repository,
        keys: body.keys,
      })
    }

    const scopes = wanted
      ? [
          {
            ...scopeOf(ctx.target_row),
            level: wanted.level ?? ('deploy' as const),
          },
        ]
      : []

    requireMintable(call.principal, scopes)
    const caller = workspaceHeldBy(db, call.principal)
    const egress = body.egress
      ? normalizeEgress(body.egress)
      : wanted
        ? normalizeEgress(workspaceEgress(wanted.agent))
        : (inherited?.egress ?? caller?.egress ?? openEgress())
    const network = body.network ?? inherited?.network ?? 'isolated'
    const docker = body.docker ?? inherited?.docker ?? false

    requireHumanToWiden(
      call.principal,
      caller,
      caller && !egressWithin(egress, caller.egress)
        ? 'cannot create a machine with wider egress than its own'
        : network === 'environment'
          ? 'cannot create a machine on its production or preview network'
          : docker
            ? 'cannot create a machine with docker'
            : null,
    )
    const command = body.command !== undefined ? body.command : (inherited?.command ?? null)
    const ttl_s = wanted ? null : (body.ttl_s ?? inherited?.ttl_s ?? machineTtl.default)
    const start = body.start ?? true
    const image = body.image
      ? await imageFor(st, body.image.ref)
      : (source?.image ?? (await imageFor(st, undefined)))

    requireQuota(
      db,
      st,
      {
        machineId: null,
        newMachine: true,
        running: start,
        memoryBytes: size.memory_bytes,
      },
      call.principal,
    )
    requireDiskRoom(st)
    const id = newId('machine')
    const name = body.name ?? `machine-${id.slice(-6).toLowerCase()}`

    if (machineInTarget(db, ctx.target_row.id, name)) {
      fail(
        'NAME_TAKEN',
        `${placeName(ctx.target_row)} already has a machine named ${name}.`,
        undefined,
        {
          name,
        },
      )
    }

    if (network === 'environment') {
      ensureNetwork(db, ctx.target_row.id, st.id)
    } else {
      ensureMachineNetwork(db, st.id)
    }

    const now = new Date()
    const minted = wanted
      ? await mintToken(kit.deps.auth, db, {
          userId: call.principal.user_id,
          name: `workspace/${name}`,
          kind: 'scoped',
          scopes,
          seconds: scopedTokenMaxSeconds,
        })
      : null
    const workspace =
      wanted && minted
        ? {
            kind,
            agent: wanted.agent,
            repository: kind === 'project' ? null : wanted.repository,
            branch: kind === 'project' ? null : (wanted.branch ?? null),
            path: kind === 'project' ? workspaceRoot : workspacePath(wanted.repository),
            level: scopes[0]!.level,
            token_id: minted.row.id,
            setup_run_id: newId('run'),
            task_branch: taskBranch,
          }
        : null
    const keys = [
      ...(body.keys ?? []),
      ...(wanted && minted
        ? workspaceKeySets(
            db,
            {
              project: ctx.project.id,
              preview: previewIdOf(ctx.target_row),
            },
            wanted.agent,
            minted.key,
            (body.keys ?? []).map((v) => v.name),
            kind,
          )
        : []),
    ]

    try {
      db.transaction((tx) => {
        const tdb = tx as unknown as Db

        tdb
          .insert(machine)
          .values({
            id,
            target_id: ctx.target_row.id,
            project_id: ctx.project.id,
            server_id: st.id,
            name,
            image,
            command,
            size,
            runtime,
            network,
            docker,
            egress,
            ttl_s,
            desired_state: start ? 'running' : 'stopped',
            stop_at: start ? stopAtFrom(ttl_s) : null,
            status: start ? 'creating' : 'stopped',
            status_reason: start ? null : 'created_stopped',
            stopped_at: start ? null : now,
            forked_from: source?.forkedFrom ?? null,
            disk_from: source?.diskFrom ?? null,
            workspace,
            created_by: call.principal.actor,
          })
          .run()

        if (keys.length) {
          const changes = new ChangeSet()

          planKeys(
            tdb,
            keyring,
            call.principal,
            changes,
            {
              scope: 'machine',
              parent: id,
              machineId: id,
              target: ctx.target,
            },
            {
              set: keys,
            },
          )
          commit(
            {
              ...kit.deps,
              db: tdb,
            },
            call,
            {
              target: ctx.target_row,
              protect: false,
            },
            changes,
          )
        }

        if (workspace && minted) {
          audit(
            tdb,
            call,
            'token.create',
            {
              entity: 'token',
              id: minted.row.id,
            },
            {
              after: {
                name: minted.row.name,
                kind: minted.row.kind,
                scopes: minted.row.scopes,
                expires_at: minted.row.expires_at.toISOString(),
              },
            },
          )
          tdb
            .insert(run)
            .values({
              id: workspace.setup_run_id,
              app_id: null,
              machine_id: id,
              deployment_id: null,
              kind: 'exec',
              command: setupCommand(
                workspace,
                kind === 'own' ? gitIdentityOf(db, call.principal.user_id) : null,
              ),
              status: 'queued',
              log_ref: `logs/sandboxes/${id}/${workspace.setup_run_id}`,
              tty: false,
              actor: call.principal.actor,
              exec: {
                cwd: machineSetupAs(workspace).home,
                user: machineSetupAs(workspace).user,
                timeout_s: machineExecLimits.timeoutS.default,
                stdin: null,
                env_keys: [],
                attach: false,
              },
            })
            .run()
        }

        audit(
          tdb,
          call,
          'machine.create',
          {
            entity: 'machine',
            id,
          },
          {
            after: {
              name,
              target_id: ctx.target_row.id,
              server_id: st.id,
              image,
              size,
              network,
              docker,
              ttl_s,
              start,
              forked_from: source?.forkedFrom ?? null,
              workspace,
              keys: keys.map((v) => v.name),
            },
          },
        )
      })
    } catch (error) {
      if (minted) {
        dropToken(db, minted.row)
      }

      throw error
    }

    stations.reconcile(st.id)

    return {
      id,
      warnings: source?.warnings ?? [],
    }
  }

  const routes = kit
    .router('machines', '/v1')
    .get(
      '/projects/:project/machines',
      async ({ ctx, query }) => {
        const statuses = csv(query.status)
        const stationId = query.server ? stationByRef(db, query.server).id : undefined
        const page = collect(
          (cursor, size) =>
            db
              .select()
              .from(machine)
              .where(
                and(
                  eq(machine.target_id, ctx.target_row.id),
                  statuses
                    ? inArray(machine.status, statuses as MachineRow['status'][])
                    : undefined,
                  stationId ? eq(machine.server_id, stationId) : undefined,
                  query.network ? eq(machine.network, query.network) : undefined,
                  before(machine.id, cursor),
                ),
              )
              .orderBy(desc(machine.id))
              .limit(size)
              .all(),
          query,
        )

        return {
          items: await Promise.all(page.rows.map((row) => present(row, query.fields))),
          next_cursor: page.next_cursor,
        }
      },
      {
        place: {
          id: 'list_machines',
          summary: 'List the machines of production or a preview',
          level: 'read',
        },
        query: t.Object({
          ...listQuery,
          ...previewQuery,
          status: filterMany(machineStatusValues),
          server: t.Optional(
            t.String({
              description: 'Only machines on this server, by id or name',
            }),
          ),
          network: t.Optional(input(StringEnum(machineNetworkValues))),
        }),
        response: replies({
          200: Page(Machine),
        }),
      },
    )
    .get(
      '/machines/:machine',
      async ({ ctx, query }) => {
        return present(ctx.machine, query.fields)
      },
      {
        machine: {
          id: 'get_machine',
          summary: 'Get a machine',
          level: 'read',
        },
        query: t.Object(getQuery),
        response: replies({
          200: Machine,
        }),
      },
    )
    .post(
      '/projects/:project/machines',
      async ({ ctx, request, body, set }) => {
        const call = await kit.call(request)

        const created = await createMachine(call, ctx, body)

        set.status = 201

        return {
          ...shown(rowOf(created.id), undefined),
          warnings: created.warnings,
        }
      },
      {
        place: {
          id: 'create_machine',
          summary: 'Create a machine, or fork one from a snapshot or a live machine disk with from',
          level: 'deploy',
          humanForWorkspaceToken:
            'create a machine with wider egress than its own workspace, on its production or preview network, or with docker',
          cli: {
            args: ['name'],
          },
        },
        query: t.Object(previewQuery),
        body: input(MachineCreateBody),
        response: replies({
          201: MachineCreated,
        }),
      },
    )
    .patch(
      '/machines/:machine',
      async ({ ctx, request, body }) => {
        const call = await kit.call(request)

        requireHumanIn(call, ctx.target_row)
        const row = ctx.machine

        if (!Object.keys(body).length) {
          invalid([
            {
              path: '/',
              message: 'send at least one of ttl_s, egress, size, network, docker, command',
            },
          ])
        }

        if (row.status === 'deleting') {
          conflict(row, ['creating', 'starting', 'running', 'stopping', 'stopped', 'failed'])
        }

        requireHumanToWiden(
          call.principal,
          workspaceHeldBy(db, call.principal),
          body.egress && !egressWithin(normalizeEgress(body.egress), row.egress)
            ? 'cannot widen the egress of a machine'
            : body.network === 'environment' && row.network !== 'environment'
              ? 'cannot put a machine on its production or preview network'
              : body.docker && !row.docker
                ? 'cannot turn on docker for a machine'
                : null,
        )
        noTtl(row.workspace, body.ttl_s)
        const live = row.desired_state === 'running'
        const idle = (machineIdleStatuses as readonly string[]).includes(row.status)

        if (body.network !== undefined && body.network !== row.network && !idle) {
          conflict(row, [...machineIdleStatuses])
        }

        const size = {
          ...row.size,
          ...body.size,
        }

        if (size.disk_bytes < row.size.disk_bytes && size.disk_bytes < row.disk_used_bytes) {
          invalid([
            {
              path: '/size/disk_bytes',
              message: `the disk holds ${row.disk_used_bytes} bytes, more than ${size.disk_bytes}`,
            },
          ])
        }

        const st = stationRow(row.server_id)

        if (live && size.memory_bytes > row.size.memory_bytes) {
          requireQuota(
            db,
            st,
            {
              machineId: row.id,
              newMachine: false,
              running: true,
              memoryBytes: size.memory_bytes,
            },
            call.principal,
          )
        }

        const changed: string[] = []

        if (body.size?.cpu_millis !== undefined && size.cpu_millis !== row.size.cpu_millis) {
          changed.push('size.cpu_millis')
        }

        if (body.size?.memory_bytes !== undefined && size.memory_bytes !== row.size.memory_bytes) {
          changed.push('size.memory_bytes')
        }

        if (body.docker !== undefined && body.docker !== row.docker) {
          changed.push('docker')
        }

        if (
          body.command !== undefined &&
          JSON.stringify(body.command) !== JSON.stringify(row.command)
        ) {
          changed.push('command')
        }

        const ttl_s = body.ttl_s ?? row.ttl_s
        const update = {
          size,
          ttl_s,
          network: body.network ?? row.network,
          docker: body.docker ?? row.docker,
          egress: body.egress ? normalizeEgress(body.egress) : row.egress,
          command: body.command !== undefined ? body.command : row.command,
          ...(body.ttl_s !== undefined && live
            ? {
                stop_at: stopAtFrom(body.ttl_s),
              }
            : {}),
        }

        if (update.network === 'environment' && row.network !== 'environment') {
          ensureNetwork(db, row.target_id, row.server_id)
        }

        if (update.network === 'isolated' && row.network !== 'isolated') {
          ensureMachineNetwork(db, row.server_id)
        }

        db.update(machine).set(update).where(eq(machine.id, row.id)).run()
        audit(
          db,
          call,
          'machine.update',
          {
            entity: 'machine',
            id: row.id,
          },
          {
            before: {
              ttl_s: row.ttl_s,
              size: row.size,
              network: row.network,
              docker: row.docker,
              egress: row.egress,
              command: row.command,
            },
            after: {
              ttl_s,
              size: update.size,
              network: update.network,
              docker: update.docker,
              egress: update.egress,
              command: update.command,
            },
          },
        )
        stations.reconcile(row.server_id)
        const restart = live && changed.length > 0

        return {
          ...shown(rowOf(row.id), undefined),
          warnings: restart
            ? [
                warning(
                  'MACHINE_RESTART_REQUIRED',
                  `${changed.join(', ')} ${changed.length === 1 ? 'is' : 'are'} stored and apply at the next start.`,
                ),
              ]
            : [],
        }
      },
      {
        machine: {
          id: 'update_machine',
          summary:
            'Change a machine: ttl_s extends from now, egress and disk size apply at once, the rest at the next start',
          level: 'deploy',
          humanForWorkspaceToken:
            'widen egress, move a machine to its production or preview network or turn docker on',
        },
        body: input(MachinePatchBody),
        response: replies({
          200: MachineCreated,
        }),
      },
    )
    .post(
      '/machines/:machine/start',
      async ({ ctx, request, body }) => {
        const call = await kit.call(request)

        requireHumanIn(call, ctx.target_row)
        const row = ctx.machine

        if (row.status === 'deleting') {
          conflict(row, ['stopping', 'stopped', 'failed'])
        }

        noTtl(row.workspace, body?.ttl_s)
        requireConnected(kit.deps, row.server_id)
        const ttl_s = body?.ttl_s ?? row.ttl_s
        const starting =
          row.desired_state === 'running' &&
          (row.status === 'creating' || row.status === 'starting' || row.status === 'running')

        if (starting) {
          if (body?.ttl_s !== undefined) {
            db.update(machine)
              .set({
                ttl_s,
                stop_at: stopAtFrom(ttl_s),
              })
              .where(eq(machine.id, row.id))
              .run()
          }
        } else {
          startMachine(db, stationRow(row.server_id), call.principal, row, ttl_s)
        }

        audit(
          db,
          call,
          'machine.start',
          {
            entity: 'machine',
            id: row.id,
          },
          {
            before: {
              status: row.status,
            },
            after: {
              ttl_s,
            },
          },
        )
        stations.reconcile(row.server_id)

        return shown(rowOf(row.id), undefined)
      },
      {
        machine: {
          id: 'start_machine',
          summary: 'Start a stopped machine; ttl_s replaces the stored one',
          level: 'deploy',
        },
        body: t.Optional(input(MachineStartBody)),
        response: replies({
          200: Machine,
        }),
      },
    )
    .post(
      '/machines/:machine/stop',
      async ({ ctx, request }) => {
        const call = await kit.call(request)

        requireHumanIn(call, ctx.target_row)
        const row = ctx.machine

        if (row.status === 'deleting') {
          conflict(row, ['creating', 'starting', 'running', 'stopping', 'stopped', 'failed'])
        }

        requireConnected(kit.deps, row.server_id)

        stopMachine(db, row)

        audit(
          db,
          call,
          'machine.stop',
          {
            entity: 'machine',
            id: row.id,
          },
          {
            before: {
              status: row.status,
            },
          },
        )
        stations.reconcile(row.server_id)

        return shown(rowOf(row.id), undefined)
      },
      {
        machine: {
          id: 'stop_machine',
          summary: 'Stop a machine and keep its disk',
          level: 'deploy',
        },
        response: replies({
          200: Machine,
        }),
      },
    )
    .delete(
      '/machines/:machine',
      async ({ ctx, request }) => {
        const call = await kit.call(request)

        requireHumanIn(call, ctx.target_row)
        requireConnected(kit.deps, ctx.machine.server_id)
        const kept = requestDeletion(db, ctx.machine, {
          actor: call.principal.actor,
          reason: 'user',
        })

        audit(
          db,
          call,
          'machine.delete',
          {
            entity: 'machine',
            id: ctx.machine.id,
          },
          {
            before: {
              name: ctx.machine.name,
              status: ctx.machine.status,
            },
            after: {
              snapshots_kept: kept,
            },
          },
        )
        stations.reconcile(ctx.machine.server_id)

        return {
          deleted: true as const,
          snapshots_kept: kept,
        }
      },
      {
        machine: {
          id: 'delete_machine',
          summary: 'Delete a machine and its disk; its snapshots stay',
          level: 'deploy',
        },
        response: replies({
          200: MachineDeleted,
        }),
      },
    )
    .post(
      '/machines/:machine/exec',
      async ({ ctx, request, body, set }) => {
        const call = await kit.call(request)

        requireHumanIn(call, ctx.target_row)
        const row = ctx.machine

        requireHumanToEnter(db, call.principal, row)

        if (row.status !== 'running') {
          fail(
            'MACHINE_NOT_RUNNING',
            `Machine ${row.name} is ${row.status}, so nothing can run in it.`,
            'Start the machine with start_machine, then run the command again.',
            {
              status: row.status,
            },
          )
        }

        requireConnected(kit.deps, row.server_id)

        if (activeRuns(row.id) >= machineExecLimits.activeRuns) {
          fail(
            'RATE_LIMITED',
            `Machine ${row.name} already has ${machineExecLimits.activeRuns} active runs.`,
            'Wait for a run to finish, then run again.',
            {
              limit: machineExecLimits.activeRuns,
            },
          )
        }

        const env = body.env ?? {}
        const issues: { path: string; message: string }[] = []

        if (envBytes(env) > machineExecLimits.envBytes) {
          issues.push({
            path: '/env',
            message: `env holds more than ${machineExecLimits.envBytes} bytes`,
          })
        }

        if (
          body.stdin !== undefined &&
          Buffer.from(body.stdin, 'base64url').length > machineExecLimits.stdinBytes
        ) {
          issues.push({
            path: '/stdin',
            message: `stdin holds more than ${machineExecLimits.stdinBytes} bytes`,
          })
        }

        if (issues.length) {
          invalid(issues)
        }

        const id = newId('run')
        const keys = Object.keys(env).sort()

        if (keys.length) {
          const delivery = ephemeralDelivery(
            {
              run_id: id,
            },
            'run',
            keys.map((key) => [key, env[key]!]),
          )

          await stations.ask(row.server_id, 'secrets.deliver', delivery).catch(stationError)
        }

        const attach = body.attach ?? false

        db.insert(run)
          .values({
            id,
            app_id: null,
            machine_id: row.id,
            deployment_id: null,
            kind: 'exec',
            command: body.command,
            status: 'queued',
            log_ref: `logs/sandboxes/${row.id}/${id}`,
            tty: false,
            actor: call.principal.actor,
            exec: {
              cwd: body.cwd ?? workspaceDefault(row, workspaceUser.home),
              user: body.user ?? workspaceDefault(row, workspaceUser.name),
              timeout_s: body.timeout_s ?? machineExecLimits.timeoutS.default,
              stdin: body.stdin ?? null,
              env_keys: keys,
              attach,
            },
          })
          .run()
        audit(
          db,
          call,
          'machine.exec',
          {
            entity: 'run',
            id,
          },
          {
            after: {
              machine_id: row.id,
              command: body.command,
              env_keys: keys,
              attach,
            },
          },
        )
        stations.reconcile(row.server_id)
        set.status = 201

        if (attach) {
          return {
            ...select(kit.views.run, runRow(db, id), undefined),
            attach_url: `/v1/runs/${id}/attach`,
          }
        }

        const finished = await waitForRun(db, id, body.wait_s ?? 10, request.signal)
        const shownRun = select(kit.views.run, finished, kit.fields('failure'))

        if (finished.status === 'queued' || finished.status === 'running') {
          return shownRun
        }

        const output = await machineRunOutput(kit, finished, call)

        return output
          ? {
              ...shownRun,
              output,
            }
          : shownRun
      },
      {
        machine: {
          id: 'machine_exec',
          summary:
            'Run a command in a running machine and wait up to wait_s for it; env values are never stored',
          level: 'deploy',
          humanForWorkspaceToken:
            'run a command in another machine with wider egress than its own workspace, on its production or preview network or with docker',
          cli: false,
        },
        body: input(MachineExecBody),
        response: replies({
          201: MachineExec,
        }),
      },
    )
    .post(
      '/machines/:machine/shells',
      async ({ ctx, request, body, set }) => {
        const call = await kit.call(request)

        requireHumanIn(call, ctx.target_row)
        const row = ctx.machine

        requireHumanToEnter(db, call.principal, row)

        if (row.status !== 'running') {
          fail(
            'MACHINE_NOT_RUNNING',
            `Machine ${row.name} is ${row.status}, so no shell can open in it.`,
            'Start the machine with start_machine, then open the shell.',
            {
              status: row.status,
            },
          )
        }

        requireConnected(kit.deps, row.server_id)
        const command = body.command ?? defaultShell(row)
        const id = newId('run')

        db.insert(run)
          .values({
            id,
            app_id: null,
            machine_id: row.id,
            deployment_id: null,
            kind: 'shell',
            command,
            status: 'queued',
            log_ref: `logs/sandboxes/${row.id}/${id}`,
            tty: true,
            actor: call.principal.actor,
            exec: {
              cwd: body.cwd ?? workspaceDefault(row, workspaceUser.home),
              user: body.user ?? workspaceDefault(row, workspaceUser.name),
              timeout_s: null,
              stdin: null,
              env_keys: [],
              attach: true,
            },
          })
          .run()
        audit(
          db,
          call,
          'machine.shell',
          {
            entity: 'run',
            id,
          },
          {
            after: {
              machine_id: row.id,
              command,
            },
          },
        )
        set.status = 201

        return {
          ...select(kit.views.run, runRow(db, id), undefined),
          tty: true,
          attach_url: `/v1/runs/${id}/attach`,
        }
      },
      {
        machine: {
          id: 'open_machine_shell',
          summary: 'Create a shell run in a machine; attach to it over the WebSocket at attach_url',
          level: 'deploy',
          humanForWorkspaceToken:
            'open a shell in another machine with wider egress than its own workspace, on its production or preview network or with docker',
          mcp: false,
          cli: false,
        },
        body: input(MachineShellBody),
        response: replies({
          201: MachineShell,
        }),
      },
    )
    .get(
      '/machines/:machine/runs',
      ({ ctx, query }) => listRuns(kit, eq(run.machine_id, ctx.machine.id), query),
      {
        machine: {
          id: 'list_machine_runs',
          summary: 'List the runs of a machine',
          level: 'read',
          mcp: false,
        },
        query: runListQuery,
        response: replies({
          200: Page(Run),
        }),
      },
    )
    .get(
      '/machines/:machine/metrics',
      async ({ ctx }) => {
        const reply = await stations
          .ask(ctx.machine.server_id, 'metrics.sample', {
            sandbox_ids: [ctx.machine.id],
          })
          .catch(stationError)
        const sample = reply.body.samples.find((s) => s.sandbox_id === ctx.machine.id)

        if (!sample) {
          fail(
            'NOT_FOUND',
            `${ctx.machine.name} reports no metrics.`,
            'Start the machine, then read metrics again.',
            {
              machine_id: ctx.machine.id,
              status: ctx.machine.status,
            },
          )
        }

        const { service_id: _s, deployment_id: _d, restarts: _r, sandbox_id: _b, ...rest } = sample!

        return {
          machine_id: ctx.machine.id,
          ...rest,
        }
      },
      {
        machine: {
          id: 'get_machine_metrics',
          summary: 'Latest live metrics sample of a machine',
          level: 'read',
          mcp: false,
        },
        response: replies({
          200: MachineMetricSample,
        }),
      },
    )
    .get(
      '/machines/:machine/keys',
      ({ ctx, query }) => {
        const rows = keysOf(db, {
          scope: 'machine',
          id: ctx.machine.id,
        }).all()

        return {
          items: rows
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((row) => select(kit.views.key, row, kit.fields(query.fields))),
          next_cursor: null,
        }
      },
      {
        machine: {
          id: 'list_machine_keys',
          summary: 'List the keys of a machine; values are never listed',
          level: 'read',
        },
        query: t.Object(getQuery),
        response: replies({
          200: Page(Key),
        }),
      },
    )
    .get(
      '/machines/:machine/keys/resolved',
      async ({ ctx, request }) => {
        const call = await kit.call(request)

        return machineResolvedView(kit, call, ctx, {
          admin: can(call.principal, ctx.target, 'admin'),
        }) as Static<typeof MachineResolved>
      },
      {
        machine: {
          id: 'get_machine_resolved_keys',
          summary:
            'The resolved keys of a machine with their sources; a value only with admin and never a sealed one',
          level: 'read',
        },
        response: replies({
          200: MachineResolved,
        }),
      },
    )
    .patch(
      '/machines/:machine/keys',
      async ({ ctx, request, body }) => {
        const call = await kit.call(request)

        if (ctx.target_row.kind === 'production') {
          requireHuman(call.principal, 'A machine key change in production', {
            ...scopeOf(ctx.target_row),
          })
        }

        if (ctx.machine.status === 'deleting') {
          conflict(ctx.machine, [
            'creating',
            'starting',
            'running',
            'stopping',
            'stopped',
            'failed',
          ])
        }

        const changes = new ChangeSet()

        planKeys(
          db,
          keyring,
          call.principal,
          changes,
          {
            scope: 'machine',
            parent: ctx.machine.id,
            machineId: ctx.machine.id,
            target: ctx.target,
          },
          body,
        )

        if (changes.empty) {
          return {
            keys: [],
          }
        }

        const result = commit(
          kit.deps,
          call,
          {
            target: ctx.target_row,
            protect: false,
          },
          changes,
        )

        if (!result.applied) {
          fail(
            'INTERNAL_ERROR',
            'a machine key change waits for approval, which machine operations never do',
          )
        }

        const ids = result.applied
          ? [
              ...Object.values(result.refs),
              ...changes.changes.flatMap((c) => (c.op === 'update' ? [c.id] : [])),
            ].filter((id) => id.startsWith('key_'))
          : []

        audit(
          db,
          call,
          'machine.keys',
          {
            entity: 'machine',
            id: ctx.machine.id,
          },
          {
            after: {
              set: (body.set ?? []).map((v) => v.name),
              unset: body.unset ?? [],
            },
          },
        )
        stations.reconcile(ctx.machine.server_id)
        const rows = ids
          .map((id) => db.select().from(key).where(eq(key.id, id)).get())
          .filter((row): row is typeof key.$inferSelect => row !== undefined)

        return {
          keys: rows.map((row) => select(kit.views.key, row, undefined)),
        }
      },
      {
        machine: {
          id: 'set_machine_keys',
          summary:
            "Set and unset a machine's keys; references to project and global keys keep values out of the agent's hands",
          level: 'deploy',
        },
        body: input(MachineKeysPatchBody),
        response: replies({
          200: MachineKeysOutcome,
        }),
      },
    )
    .get(
      '/machines/:machine/connections',
      async ({ ctx, request, query }) => {
        const call = await kit.call(request)
        const reply = await stations
          .ask(
            ctx.machine.server_id,
            'network.sample',
            {
              sandbox_ids: [ctx.machine.id],
            },
            {
              timeoutMs: 10_000,
            },
          )
          .catch(stationError)
        const sample = reply.body.samples.find((s) => s.sandbox_id === ctx.machine.id)

        if (!sample) {
          fail(
            'NOT_FOUND',
            `The server returned no connection sample for ${ctx.machine.name}.`,
            'Start the machine, then read the connections again.',
            {
              machine_id: ctx.machine.id,
            },
          )
        }

        return shapeMachineSample(
          {
            db,
            redaction: kit.redaction,
            machineRedaction: kit.machineRedaction,
            actor: call.principal.actor,
            requestId: call.request_id,
          },
          sample!,
          ctx.machine,
          query.direction,
        )
      },
      {
        machine: {
          id: 'get_machine_connections',
          summary: 'Live connections and refused attempts of a machine; one sample',
          level: 'read',
        },
        query: t.Object({
          direction: t.Optional(input(StringEnum(networkDirectionValues))),
        }),
        response: replies({
          200: MachineConnections,
        }),
      },
    )
    .get(
      '/machines/:machine/dns-log',
      async ({ ctx, request, query }) => {
        const call = await kit.call(request)
        const reply = await stations
          .ask(
            ctx.machine.server_id,
            'dns.log',
            {
              sandbox_id: ctx.machine.id,
              tail: query.tail ?? dnsLogTail.default,
              ...(query.name
                ? {
                    name: query.name,
                  }
                : {}),
              ...(query.rcode
                ? {
                    rcode: query.rcode,
                  }
                : {}),
            },
            {
              timeoutMs: 10_000,
            },
          )
          .catch(stationError)
        const redact = kit.machineRedaction([ctx.machine.id], call.principal.actor, call.request_id)
        const entries = reply.body.entries.map((e) => ({
          ...e,
          deployment_id: e.deployment_id ?? null,
          name: redact(e.name),
        }))

        return {
          untrusted: {
            source: 'resolver log' as const,
            entries,
          },
        }
      },
      {
        machine: {
          id: 'get_machine_dns_log',
          summary:
            "The machine's recent DNS queries from the resolver's ring, newest first, as untrusted data",
          level: 'read',
          cli: {
            render: 'dns-log',
          },
        },
        query: DnsLogQuery,
        response: replies({
          200: DnsLog,
        }),
      },
    )
    .post(
      '/machines/:machine/network/probe',
      async ({ ctx, request, body }) => {
        const call = await kit.call(request)

        requireHumanIn(call, ctx.target_row)

        if (ctx.machine.status !== 'running') {
          conflict(ctx.machine, ['running'])
        }

        kit.probeLimit(ctx.machine.id, ctx.target_row.id)
        const kind = body.kind ?? 'tcp'
        const target = probeTarget(db, ctx.target_row, body.to, body.port, kind)

        return sendMachineProbe(kit.deps, call, ctx.machine, {
          kind,
          to: target.to,
          port: target.port,
          timeout_s: body.timeout_s ?? probeTimeout.defaultS,
        })
      },
      {
        machine: {
          id: 'probe_machine_network',
          summary:
            "Ask the machine's resolver as the machine, or judge one TCP handshake with the machine ruleset and send it from the server when the ruleset accepts the destination",
          level: 'deploy',
          cli: {
            render: 'probe',
          },
        },
        body: ProbeBody,
        response: replies({
          200: MachineNetworkProbe,
        }),
      },
    )
    .post(
      '/machines/:machine/snapshots',
      async ({ ctx, request, body, set }) => {
        const call = await kit.call(request)

        requireHumanIn(call, ctx.target_row)
        const row = ctx.machine

        if (row.status === 'creating' || row.status === 'deleting') {
          conflict(row, ['starting', 'running', 'stopping', 'stopped', 'failed'])
        }

        requireConnected(kit.deps, row.server_id)
        requireDiskRoom(stationRow(row.server_id))
        const name = body?.name ?? null

        if (
          name &&
          db
            .select({
              id: machine_snapshot.id,
            })
            .from(machine_snapshot)
            .where(
              and(eq(machine_snapshot.target_id, row.target_id), eq(machine_snapshot.name, name)),
            )
            .get()
        ) {
          fail(
            'NAME_TAKEN',
            `${placeName(ctx.target_row)} already has a snapshot named ${name}.`,
            undefined,
            {
              name,
            },
          )
        }

        const id = newId('machine_snapshot')

        db.insert(machine_snapshot)
          .values({
            id,
            machine_id: row.id,
            target_id: row.target_id,
            project_id: row.project_id,
            server_id: row.server_id,
            name,
            image: row.image,
            size: row.size,
            runtime: row.runtime,
            settings: {
              network: row.network,
              docker: row.docker,
              egress: row.egress,
              command: row.command,
              ttl_s: row.ttl_s,
            },
            source_state: sourceStateOf(row),
            status: 'creating',
            created_by: call.principal.actor,
          })
          .run()
        audit(
          db,
          call,
          'machine.snapshot',
          {
            entity: 'machine_snapshot',
            id,
          },
          {
            after: {
              machine_id: row.id,
              name,
              source_state: sourceStateOf(row),
            },
          },
        )
        stations.reconcile(row.server_id)
        await pollUntil(
          () =>
            db
              .select({
                status: machine_snapshot.status,
              })
              .from(machine_snapshot)
              .where(eq(machine_snapshot.id, id))
              .get()?.status !== 'creating',
          snapshotWaitMs,
          request.signal,
        )
        set.status = 201
        const created = db.select().from(machine_snapshot).where(eq(machine_snapshot.id, id)).get()!

        return {
          ...select(kit.views.machineSnapshot, created, undefined),
          warnings: warningsFor(row),
        }
      },
      {
        machine: {
          id: 'snapshot_machine',
          summary:
            "Take a read-only copy of a machine's disk; files on the disk, credentials included, are copied into every snapshot and fork",
          level: 'deploy',
        },
        body: t.Optional(input(MachineSnapshotBody)),
        response: replies({
          201: MachineSnapshotCreated,
        }),
      },
    )
    .get(
      '/machines/:machine/snapshots',
      ({ ctx, query }) => {
        return listSnapshots(
          query,
          and(
            eq(machine_snapshot.machine_id, ctx.machine.id),
            eq(machine_snapshot.target_id, ctx.target_row.id),
          ),
        )
      },
      {
        machine: {
          id: 'list_machine_snapshots',
          summary: 'List the snapshots of a machine',
          level: 'read',
        },
        query: t.Object({
          ...listQuery,
          status: filterMany(machineSnapshotStatusValues),
        }),
        response: replies({
          200: Page(MachineSnapshot),
        }),
      },
    )
    .get(
      '/projects/:project/machine-snapshots',
      ({ ctx, query }) => {
        const source = query.machine
          ? query.machine.startsWith('sbx_')
            ? query.machine
            : machineInTarget(db, ctx.target_row.id, query.machine)?.id
          : undefined

        if (query.machine && !source) {
          return {
            items: [],
            next_cursor: null,
          }
        }

        return listSnapshots(
          query,
          and(
            eq(machine_snapshot.target_id, ctx.target_row.id),
            source ? eq(machine_snapshot.machine_id, source) : undefined,
          ),
        )
      },
      {
        place: {
          id: 'list_project_machine_snapshots',
          summary: 'List the machine snapshots of production or a preview',
          level: 'read',
        },
        query: t.Object({
          ...listQuery,
          ...previewQuery,
          machine: t.Optional(t.String()),
          status: filterMany(machineSnapshotStatusValues),
        }),
        response: replies({
          200: Page(MachineSnapshot),
        }),
      },
    )
    .get(
      '/machine-snapshots/:id',
      ({ ctx, query }) => {
        return select(kit.views.machineSnapshot, ctx.snapshot, kit.fields(query.fields))
      },
      {
        machine_snapshot: {
          id: 'get_machine_snapshot',
          summary: 'Get a machine snapshot',
          level: 'read',
          mcp: false,
        },
        query: t.Object(getQuery),
        response: replies({
          200: MachineSnapshot,
        }),
      },
    )
    .delete(
      '/machine-snapshots/:id',
      async ({ ctx, request }) => {
        const call = await kit.call(request)

        requireHumanIn(call, ctx.target_row)
        requireConnected(kit.deps, ctx.snapshot.server_id)

        if (ctx.snapshot.status === 'failed') {
          db.delete(machine_snapshot).where(eq(machine_snapshot.id, ctx.snapshot.id)).run()
        } else {
          db.update(machine_snapshot)
            .set({
              status: 'deleting',
            })
            .where(eq(machine_snapshot.id, ctx.snapshot.id))
            .run()
        }

        audit(
          db,
          call,
          'machine.snapshot_delete',
          {
            entity: 'machine_snapshot',
            id: ctx.snapshot.id,
          },
          {
            before: {
              status: ctx.snapshot.status,
              name: ctx.snapshot.name,
            },
          },
        )
        stations.reconcile(ctx.snapshot.server_id)

        return {
          deleted: true as const,
        }
      },
      {
        machine_snapshot: {
          id: 'delete_machine_snapshot',
          summary: 'Delete a machine snapshot',
          level: 'deploy',
        },
        response: replies({
          200: MachineSnapshotDeleted,
        }),
      },
    )
    .post(
      '/servers/:server/machine-storage/grow',
      async ({ request, params, body, set }) => {
        const call = await kit.call(request)
        const st = stationByRef(db, params.server)
        const before = requireGrowable(st, body.size_bytes).filesystem_bytes

        if (readSetting(db, 'platform.protected') && !call.principal.human) {
          const changes = new ChangeSet()

          changes.add('machine_storage', st.id, {
            size_bytes: body.size_bytes,
          })
          const result = commit(
            kit.deps,
            call,
            {
              target: null,
              protect: true,
            },
            changes,
          )

          if (!result.applied) {
            return kit.approvalBody(result, set)
          }
        }

        const grown = await growStorage(
          {
            db,
            stations,
          },
          st.id,
          body.size_bytes,
          stationError,
        )

        audit(
          db,
          call,
          'machine.storage_grow',
          {
            entity: 'server',
            id: st.id,
          },
          {
            before: {
              filesystem_bytes: before,
            },
            after: {
              filesystem_bytes: grown.filesystem_bytes,
            },
          },
        )

        return {
          filesystem_bytes: grown.filesystem_bytes,
          filesystem_free_bytes: grown.filesystem_free_bytes,
        }
      },
      {
        operation: {
          id: 'grow_machine_storage',
          summary:
            "Grow a server's machine filesystem to size_bytes while machines run; needs approval for a non-human actor under platform.protected",
          level: 'instance admin',
        },
        body: input(MachineStorageGrowRequest),
        response: replies({
          200: StorageGrown,
          202: ApprovalDetail,
        }),
      },
    )

  return {
    routes,
    createMachine,
  }

  function listSnapshots(
    query: { limit?: number; cursor?: string; fields?: string; status?: string },
    scope: ReturnType<typeof and>,
  ) {
    const statuses = csv(query.status)
    const page = collect(
      (cursor, size) =>
        db
          .select()
          .from(machine_snapshot)
          .where(
            and(
              scope,
              statuses
                ? inArray(machine_snapshot.status, statuses as MachineSnapshotRow['status'][])
                : undefined,
              before(machine_snapshot.id, cursor),
            ),
          )
          .orderBy(desc(machine_snapshot.id))
          .limit(size)
          .all(),
      query,
    )

    return {
      items: page.rows.map((row) =>
        select(kit.views.machineSnapshot, row, kit.fields(query.fields)),
      ),
      next_cursor: page.next_cursor,
    }
  }
}
