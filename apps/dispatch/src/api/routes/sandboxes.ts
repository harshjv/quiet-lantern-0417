import type { Static } from '@sinclair/typebox'
import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { t } from 'elysia'

import {
  dnsLogTail,
  networkDirectionValues,
  probeTimeout,
  runActiveStatuses,
  SandboxCreateBody,
  SandboxExecBody,
  sandboxExecLimits,
  sandboxIdleStatuses,
  sandboxNetworkValues,
  SandboxPatchBody,
  SandboxShellBody,
  sandboxSizeDefaults,
  SandboxSnapshotBody,
  sandboxSnapshotStatusValues,
  SandboxStartBody,
  sandboxStatusValues,
  SandboxStorageGrowRequest,
  sandboxTtl,
  SandboxVariablesPatchBody,
  StringEnum,
  workspaceEgress,
  workspaceUser,
} from '@stationly/protocol'
import { releaseRepositories } from '@stationly/protocol/release-config'

import { scopedTokenMaxSeconds } from '../../auth/auth.ts'
import { dropToken, mintToken } from '../../auth/tokens.ts'
import type { Db } from '../../db/client.ts'
import { newId } from '../../db/ids.ts'
import { run, sandbox, sandbox_snapshot, station, variable } from '../../db/schema.ts'
import { readSetting } from '../../db/settings.ts'
import { shapeSandboxSample } from '../../net/connections.ts'
import { probeTarget } from '../../net/explain.ts'
import { sendSandboxProbe } from '../../net/probe.ts'
import { resolveImage, stationArch } from '../../platform/image-source.ts'
import { effectivePins } from '../../platform/lockfile.ts'
import { normalizeEgress, openEgress } from '../../sandboxes/egress.ts'
import { requestDeletion } from '../../sandboxes/lifecycle.ts'
import { fittingMemory, requireDiskRoom, requireQuota } from '../../sandboxes/limits.ts'
import { requireRuntime } from '../../sandboxes/runtime.ts'
import { growStorage, requireGrowable } from '../../sandboxes/storage.ts'
import {
  isRepositoryName,
  repositoryName,
  setupCommand,
  workspacePath,
  workspaceVariableSets,
} from '../../sandboxes/workspace.ts'
import { ephemeralDelivery } from '../../secrets/deliver.ts'
import { variablesOf } from '../../secrets/values.ts'
import { can, requireHuman, requireLevel } from '../access.ts'
import { ChangeSet, commit } from '../changes.ts'
import { audit, type Call } from '../context.ts'
import { requireConnected, requireStationReady } from '../deployments.ts'
import { fail, invalid } from '../errors.ts'
import { project as select } from '../fields.ts'
import { ensureNetwork, ensureSandboxNetwork } from '../ipam.ts'
import { csv, warning, type Kit } from '../kit.ts'
import {
  sandboxById,
  sandboxInEnvironment,
  snapshotById,
  stationByRef,
  type EnvironmentRow,
  type SandboxContext,
  type SandboxRow,
  type SandboxSnapshotRow,
} from '../lookup.ts'
import { before, collect, filterMany, getQuery, listQuery } from '../pagination.ts'
import { SandboxResolved, sandboxResolvedView } from '../resolved.ts'
import { listRuns, pollUntil, runListQuery, runRow, sandboxRunOutput, waitForRun } from '../runs.ts'
import { DnsLogQuery, input, ProbeBody } from '../schemas.ts'
import {
  DnsLog,
  Page,
  replies,
  Run,
  Sandbox,
  SandboxConnections,
  SandboxCreated,
  SandboxDeleted,
  SandboxExec,
  SandboxMetricSample,
  SandboxNetworkProbe,
  SandboxShell,
  SandboxSnapshot,
  SandboxSnapshotCreated,
  SandboxSnapshotDeleted,
  SandboxVariablesOutcome,
  Staged,
  StorageGrown,
  Variable,
} from '../shapes.ts'
import { planVariables } from '../variable-changes.ts'

import { stationError } from './runs.ts'
import { requireMintable } from './tokens.ts'

const snapshotWaitMs = 10_000

export const sandboxRoutes = (kit: Kit) => {
  const { db, stations, keyring } = kit.deps

  const stationRow = (id: string) => db.select().from(station).where(eq(station.id, id)).get()!

  const requireHumanIn = (call: Call, environment: EnvironmentRow) => {
    if (environment.protected) {
      requireHuman(call.principal, 'A sandbox operation in a protected environment', {
        environment_id: environment.id,
      })
    }
  }

  const requireWrite = (
    call: Call,
    ctx: { target: SandboxContext['target']; environment: EnvironmentRow },
  ) => {
    requireLevel(call.principal, ctx.target, 'deploy')
    requireHumanIn(call, ctx.environment)
  }

  const conflict = (row: SandboxRow, allowed: string[]) =>
    fail(
      'SANDBOX_STATE_CONFLICT',
      `Sandbox ${row.name} is ${row.status}, which this operation does not allow.`,
      `Wait until the sandbox is ${allowed.join(' or ')}, then retry.`,
      {
        status: row.status,
        allowed,
      },
    )

  const shown = (row: SandboxRow, fields?: string) =>
    select(kit.views.sandbox, row, kit.fields(fields))

  const metricsOf = async (row: SandboxRow) => {
    if (row.status !== 'running') {
      return null
    }

    try {
      const reply = await stations.ask(row.station_id, 'metrics.sample', {
        sandbox_ids: [row.id],
      })
      const sample = reply.body.samples.find((s) => s.sandbox_id === row.id)

      if (!sample) {
        return null
      }

      const { service_id: _s, deployment_id: _d, restarts: _r, sandbox_id: _b, ...rest } = sample

      return {
        sandbox_id: row.id,
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

  const present = async (row: SandboxRow, fields: string | undefined) => {
    const body = shown(row, fields)

    return wantsMetrics(fields)
      ? {
          ...body,
          metrics: await metricsOf(row),
        }
      : body
  }

  const warningsFor = (row: SandboxRow) =>
    row.status === 'running' || row.status === 'starting'
      ? [
          warning(
            'SANDBOX_SNAPSHOT_CRASH_CONSISTENT',
            'The copy holds what reached the disk; data still in process buffers is not in it.',
          ),
        ]
      : []

  const sourceStateOf = (row: SandboxRow) =>
    row.desired_state === 'running' && row.status !== 'stopped' && row.status !== 'failed'
      ? ('running' as const)
      : ('stopped' as const)

  const rowOf = (id: string) => db.select().from(sandbox).where(eq(sandbox.id, id)).get()!

  const pickStation = (ref: string | undefined) => {
    if (ref) {
      return stationByRef(db, ref)
    }

    const capable = db
      .select()
      .from(station)
      .where(and(isNull(station.revoked_at), eq(station.status, 'online')))
      .all()
      .filter((s) => s.capabilities?.sandboxes && stations.isConnected(s.id))

    if (capable.length === 1) {
      return capable[0]!
    }

    if (capable.length === 0) {
      fail(
        'STATION_CAPABILITY_MISSING',
        'No online station reports the sandbox capability.',
        'Install sandbox support on a station (stationd install --sandbox-device or --sandbox-size) and wait for it to reconnect.',
        {
          missing: 'sandboxes',
        },
      )
    }

    return invalid([
      {
        path: '/station_id',
        message: `${capable.length} stations report sandboxes; name one of ${capable.map((s) => s.name).join(', ')}`,
      },
    ])
  }

  const imageFor = async (st: typeof station.$inferSelect, ref: string | undefined) => {
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
        'STATION_CAPABILITY_MISSING',
        'The platform lockfile pins no sandbox_toolchain image, so there is no default sandbox image.',
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
    ctx: { project: { id: string }; environment: EnvironmentRow },
    from: NonNullable<Static<typeof SandboxCreateBody>['from']>,
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
          'SANDBOX_STATE_CONFLICT',
          `Snapshot ${snap.snapshot.name ?? snap.snapshot.id} is ${snap.snapshot.status}, so it cannot be forked.`,
          'Wait until the snapshot is ready, then fork it.',
          {
            status: snap.snapshot.status,
            allowed: ['ready'],
          },
        )
      }

      return {
        stationId: snap.snapshot.station_id,
        image: snap.snapshot.image,
        size: snap.snapshot.size,
        runtime: snap.snapshot.runtime,
        settings: snap.snapshot.settings,
        usedBytes: null,
        diskFrom: {
          snapshot_id: snap.snapshot.id,
        },
        forkedFrom: {
          sandbox_id: null,
          snapshot_id: snap.snapshot.id,
        },
        warnings: [] as ReturnType<typeof warning>[],
      }
    }

    const source = from.sandbox.startsWith('sbx_') ? sandboxById(db, from.sandbox) : null
    const named = source ? null : sandboxInEnvironment(db, ctx.environment.id, from.sandbox)
    const found = source ?? (named ? sandboxById(db, named.id) : null)

    if (!found) {
      return fail(
        'NOT_FOUND',
        `sandbox ${from.sandbox} does not exist or is not visible to this credential.`,
      )
    }

    requireWrite(call, found)

    if (found.project.id !== ctx.project.id) {
      invalid([
        {
          path: '/from/sandbox',
          message: 'a fork stays inside its project',
        },
      ])
    }

    if (found.sandbox.status === 'creating' || found.sandbox.status === 'deleting') {
      conflict(found.sandbox, ['starting', 'running', 'stopping', 'stopped', 'failed'])
    }

    return {
      stationId: found.sandbox.station_id,
      image: found.sandbox.image,
      size: found.sandbox.size,
      runtime: found.sandbox.runtime,
      settings: {
        network: found.sandbox.network,
        docker: found.sandbox.docker,
        egress: found.sandbox.egress,
        command: found.sandbox.command,
        ttl_s: found.sandbox.ttl_s,
      },
      usedBytes: found.sandbox.disk_used_bytes,
      diskFrom: {
        sandbox_id: found.sandbox.id,
      },
      forkedFrom: {
        sandbox_id: found.sandbox.id,
        snapshot_id: null,
      },
      warnings: warningsFor(found.sandbox),
    }
  }

  const activeRuns = (sandboxId: string) =>
    db
      .select({
        id: run.id,
      })
      .from(run)
      .where(and(eq(run.sandbox_id, sandboxId), inArray(run.status, [...runActiveStatuses])))
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

  const workspaceDefault = (row: SandboxRow, value: string) => (row.workspace ? value : null)

  const stopAtFrom = (ttl: number | null) =>
    ttl === null ? null : new Date(Date.now() + ttl * 1000)

  const defaultShell = (row: SandboxRow) =>
    row.image.ref === null ? ['/bin/bash', '-l'] : ['/bin/sh']

  return kit
    .router('sandboxes', '/v1')
    .get(
      '/environments/:environment/sandboxes',
      async ({ ctx, query }) => {
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
                  statuses
                    ? inArray(sandbox.status, statuses as SandboxRow['status'][])
                    : undefined,
                  stationId ? eq(sandbox.station_id, stationId) : undefined,
                  query.network ? eq(sandbox.network, query.network) : undefined,
                  before(sandbox.id, cursor),
                ),
              )
              .orderBy(desc(sandbox.id))
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
        environment: {
          id: 'list_sandboxes',
          summary: 'List the sandboxes of an environment',
          level: 'read',
        },
        query: t.Object({
          ...listQuery,
          status: filterMany(sandboxStatusValues),
          station: t.Optional(
            t.String({
              description: 'Only sandboxes on this station, by id or name',
            }),
          ),
          network: t.Optional(input(StringEnum(sandboxNetworkValues))),
        }),
        response: replies({
          200: Page(Sandbox),
        }),
      },
    )
    .get(
      '/sandboxes/:sandbox',
      async ({ ctx, query }) => {
        return present(ctx.sandbox, query.fields)
      },
      {
        sandbox: {
          id: 'get_sandbox',
          summary: 'Get a sandbox',
          level: 'read',
        },
        query: t.Object(getQuery),
        response: replies({
          200: Sandbox,
        }),
      },
    )
    .post(
      '/environments/:environment/sandboxes',
      async ({ ctx, request, body, set }) => {
        const call = await kit.call(request)

        requireHumanIn(call, ctx.environment)
        const source = body.from ? sourceOf(call, ctx, body.from) : null
        const st = body.from ? stationRow(source!.stationId) : pickStation(body.station_id)

        if (
          source &&
          body.station_id !== undefined &&
          stationByRef(db, body.station_id).id !== st.id
        ) {
          invalid([
            {
              path: '/station_id',
              message: `a fork runs on its source's station ${st.name}`,
            },
          ])
        }

        requireStationReady(db, st.id)

        if (!st.capabilities?.sandboxes) {
          fail(
            'STATION_CAPABILITY_MISSING',
            `Station ${st.name} reports no sandbox capability.`,
            'Install sandbox support on the station, then retry.',
            {
              missing: 'sandboxes',
              station_id: st.id,
            },
          )
        }

        const runtime = requireRuntime(st, body.runtime ?? source?.runtime)
        const inherited = source?.settings
        const size = {
          ...sandboxSizeDefaults,
          memory_bytes: fittingMemory(db, st),
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
              message: 'the last path segment, without .git, must be a lowercase slug',
            },
          ])
        }

        const scopes = wanted
          ? [
              {
                project_id: ctx.project.id,
                environment_id: ctx.environment.id,
                level: wanted.level ?? ('deploy' as const),
              },
            ]
          : []

        requireMintable(call.principal, scopes)
        const egress = body.egress
          ? normalizeEgress(body.egress)
          : wanted
            ? normalizeEgress(workspaceEgress(wanted.agent))
            : (inherited?.egress ?? openEgress())
        const network = body.network ?? inherited?.network ?? 'isolated'
        const docker = body.docker ?? inherited?.docker ?? false
        const command = body.command !== undefined ? body.command : (inherited?.command ?? null)
        const ttl_s = wanted ? null : (body.ttl_s ?? inherited?.ttl_s ?? sandboxTtl.default)
        const start = body.start ?? true
        const image = body.image
          ? await imageFor(st, body.image.ref)
          : (source?.image ?? (await imageFor(st, undefined)))

        requireQuota(db, st, {
          sandboxId: null,
          newSandbox: true,
          running: start,
          memoryBytes: size.memory_bytes,
        })
        requireDiskRoom(st)
        const id = newId('sandbox')
        const name = body.name ?? `sandbox-${id.slice(-6).toLowerCase()}`

        if (sandboxInEnvironment(db, ctx.environment.id, name)) {
          fail(
            'NAME_TAKEN',
            `Environment ${ctx.environment.name} already has a sandbox named ${name}.`,
            undefined,
            {
              name,
            },
          )
        }

        if (network === 'environment') {
          ensureNetwork(db, ctx.environment.id, st.id)
        } else {
          ensureSandboxNetwork(db, st.id)
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
                agent: wanted.agent,
                repository: wanted.repository,
                branch: wanted.branch ?? null,
                path: workspacePath(wanted.repository),
                level: scopes[0]!.level,
                token_id: minted.row.id,
                setup_run_id: newId('run'),
              }
            : null
        const variables = [
          ...(body.variables ?? []),
          ...(wanted && minted
            ? workspaceVariableSets(
                db,
                ctx.project.id,
                wanted.agent,
                minted.key,
                (body.variables ?? []).map((v) => v.key),
              )
            : []),
        ]

        try {
          db.transaction((tx) => {
            const tdb = tx as unknown as Db

            tdb
              .insert(sandbox)
              .values({
                id,
                environment_id: ctx.environment.id,
                project_id: ctx.project.id,
                station_id: st.id,
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

            if (variables.length) {
              const changes = new ChangeSet()

              planVariables(
                tdb,
                keyring,
                call.principal,
                changes,
                {
                  scope: 'sandbox',
                  parent: id,
                  sandboxId: id,
                  target: ctx.target,
                },
                {
                  set: variables,
                },
              )
              commit(
                {
                  ...kit.deps,
                  db: tdb,
                },
                call,
                {
                  environment: ctx.environment,
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
                  service_id: null,
                  sandbox_id: id,
                  deployment_id: null,
                  kind: 'exec',
                  command: setupCommand(workspace, {
                    project: ctx.project.id,
                    environment: ctx.environment.id,
                  }),
                  status: 'queued',
                  log_ref: `logs/sandboxes/${id}/${workspace.setup_run_id}`,
                  tty: false,
                  actor: call.principal.actor,
                  exec: {
                    cwd: workspaceUser.home,
                    user: workspaceUser.name,
                    timeout_s: sandboxExecLimits.timeoutS.default,
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
              'sandbox.create',
              {
                entity: 'sandbox',
                id,
              },
              {
                after: {
                  name,
                  environment_id: ctx.environment.id,
                  station_id: st.id,
                  image,
                  size,
                  network,
                  docker,
                  ttl_s,
                  start,
                  forked_from: source?.forkedFrom ?? null,
                  workspace,
                  variables: variables.map((v) => v.key),
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
        set.status = 201

        return {
          ...shown(rowOf(id), undefined),
          warnings: source?.warnings ?? [],
        }
      },
      {
        environment: {
          id: 'create_sandbox',
          summary: 'Create a sandbox, or fork one from a snapshot or a live sandbox disk with from',
          level: 'deploy',
          cli: {
            args: ['name'],
          },
        },
        body: input(SandboxCreateBody),
        response: replies({
          201: SandboxCreated,
        }),
      },
    )
    .patch(
      '/sandboxes/:sandbox',
      async ({ ctx, request, body }) => {
        const call = await kit.call(request)

        requireHumanIn(call, ctx.environment)
        const row = ctx.sandbox

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

        noTtl(row.workspace, body.ttl_s)
        const live = row.desired_state === 'running'
        const idle = (sandboxIdleStatuses as readonly string[]).includes(row.status)

        if (body.network !== undefined && body.network !== row.network && !idle) {
          conflict(row, [...sandboxIdleStatuses])
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

        const st = stationRow(row.station_id)

        if (live && size.memory_bytes > row.size.memory_bytes) {
          requireQuota(db, st, {
            sandboxId: row.id,
            newSandbox: false,
            running: true,
            memoryBytes: size.memory_bytes,
          })
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
          ensureNetwork(db, row.environment_id, row.station_id)
        }

        if (update.network === 'isolated' && row.network !== 'isolated') {
          ensureSandboxNetwork(db, row.station_id)
        }

        db.update(sandbox).set(update).where(eq(sandbox.id, row.id)).run()
        audit(
          db,
          call,
          'sandbox.update',
          {
            entity: 'sandbox',
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
        stations.reconcile(row.station_id)
        const restart = live && changed.length > 0

        return {
          ...shown(rowOf(row.id), undefined),
          warnings: restart
            ? [
                warning(
                  'SANDBOX_RESTART_REQUIRED',
                  `${changed.join(', ')} ${changed.length === 1 ? 'is' : 'are'} stored and apply at the next start.`,
                ),
              ]
            : [],
        }
      },
      {
        sandbox: {
          id: 'update_sandbox',
          summary:
            'Change a sandbox: ttl_s extends from now, egress and disk size apply at once, the rest at the next start',
          level: 'deploy',
        },
        body: input(SandboxPatchBody),
        response: replies({
          200: SandboxCreated,
        }),
      },
    )
    .post(
      '/sandboxes/:sandbox/start',
      async ({ ctx, request, body }) => {
        const call = await kit.call(request)

        requireHumanIn(call, ctx.environment)
        const row = ctx.sandbox

        if (row.status === 'deleting') {
          conflict(row, ['stopping', 'stopped', 'failed'])
        }

        noTtl(row.workspace, body?.ttl_s)
        requireConnected(kit.deps, row.station_id)
        const ttl_s = body?.ttl_s ?? row.ttl_s
        const starting =
          row.desired_state === 'running' &&
          (row.status === 'creating' || row.status === 'starting' || row.status === 'running')

        if (starting) {
          if (body?.ttl_s !== undefined) {
            db.update(sandbox)
              .set({
                ttl_s,
                stop_at: stopAtFrom(ttl_s),
              })
              .where(eq(sandbox.id, row.id))
              .run()
          }
        } else {
          requireQuota(db, stationRow(row.station_id), {
            sandboxId: row.id,
            newSandbox: false,
            running: true,
            memoryBytes: row.size.memory_bytes,
          })
          db.update(sandbox)
            .set({
              ttl_s,
              desired_state: 'running',
              stop_at: stopAtFrom(ttl_s),
              status: 'starting',
              status_reason: null,
              failure: null,
              exit_code: null,
              expiring_notified_at: null,
            })
            .where(eq(sandbox.id, row.id))
            .run()
        }

        audit(
          db,
          call,
          'sandbox.start',
          {
            entity: 'sandbox',
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
        stations.reconcile(row.station_id)

        return shown(rowOf(row.id), undefined)
      },
      {
        sandbox: {
          id: 'start_sandbox',
          summary: 'Start a stopped sandbox; ttl_s replaces the stored one',
          level: 'deploy',
        },
        body: t.Optional(input(SandboxStartBody)),
        response: replies({
          200: Sandbox,
        }),
      },
    )
    .post(
      '/sandboxes/:sandbox/stop',
      async ({ ctx, request }) => {
        const call = await kit.call(request)

        requireHumanIn(call, ctx.environment)
        const row = ctx.sandbox

        if (row.status === 'deleting') {
          conflict(row, ['creating', 'starting', 'running', 'stopping', 'stopped', 'failed'])
        }

        requireConnected(kit.deps, row.station_id)

        if (row.status !== 'stopped' && row.status !== 'failed') {
          db.update(sandbox)
            .set({
              desired_state: 'stopped',
              stop_at: null,
              status: 'stopping',
            })
            .where(eq(sandbox.id, row.id))
            .run()
        }

        audit(
          db,
          call,
          'sandbox.stop',
          {
            entity: 'sandbox',
            id: row.id,
          },
          {
            before: {
              status: row.status,
            },
          },
        )
        stations.reconcile(row.station_id)

        return shown(rowOf(row.id), undefined)
      },
      {
        sandbox: {
          id: 'stop_sandbox',
          summary: 'Stop a sandbox and keep its disk',
          level: 'deploy',
        },
        response: replies({
          200: Sandbox,
        }),
      },
    )
    .delete(
      '/sandboxes/:sandbox',
      async ({ ctx, request }) => {
        const call = await kit.call(request)

        requireHumanIn(call, ctx.environment)
        requireConnected(kit.deps, ctx.sandbox.station_id)
        const kept = requestDeletion(db, ctx.sandbox, {
          actor: call.principal.actor,
          reason: 'user',
        })

        audit(
          db,
          call,
          'sandbox.delete',
          {
            entity: 'sandbox',
            id: ctx.sandbox.id,
          },
          {
            before: {
              name: ctx.sandbox.name,
              status: ctx.sandbox.status,
            },
            after: {
              snapshots_kept: kept,
            },
          },
        )
        stations.reconcile(ctx.sandbox.station_id)

        return {
          deleted: true as const,
          snapshots_kept: kept,
        }
      },
      {
        sandbox: {
          id: 'delete_sandbox',
          summary: 'Delete a sandbox and its disk; its snapshots stay',
          level: 'deploy',
        },
        response: replies({
          200: SandboxDeleted,
        }),
      },
    )
    .post(
      '/sandboxes/:sandbox/exec',
      async ({ ctx, request, body, set }) => {
        const call = await kit.call(request)

        requireHumanIn(call, ctx.environment)
        const row = ctx.sandbox

        if (row.status !== 'running') {
          fail(
            'SANDBOX_NOT_RUNNING',
            `Sandbox ${row.name} is ${row.status}, so nothing can run in it.`,
            'Start the sandbox with start_sandbox, then run the command again.',
            {
              status: row.status,
            },
          )
        }

        requireConnected(kit.deps, row.station_id)

        if (activeRuns(row.id) >= sandboxExecLimits.activeRuns) {
          fail(
            'RATE_LIMITED',
            `Sandbox ${row.name} already has ${sandboxExecLimits.activeRuns} active runs.`,
            'Wait for a run to finish, then run again.',
            {
              limit: sandboxExecLimits.activeRuns,
            },
          )
        }

        const env = body.env ?? {}
        const issues: { path: string; message: string }[] = []

        if (envBytes(env) > sandboxExecLimits.envBytes) {
          issues.push({
            path: '/env',
            message: `env holds more than ${sandboxExecLimits.envBytes} bytes`,
          })
        }

        if (
          body.stdin !== undefined &&
          Buffer.from(body.stdin, 'base64url').length > sandboxExecLimits.stdinBytes
        ) {
          issues.push({
            path: '/stdin',
            message: `stdin holds more than ${sandboxExecLimits.stdinBytes} bytes`,
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

          await stations.ask(row.station_id, 'secrets.deliver', delivery).catch(stationError)
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
            exec: {
              cwd: body.cwd ?? workspaceDefault(row, workspaceUser.home),
              user: body.user ?? workspaceDefault(row, workspaceUser.name),
              timeout_s: body.timeout_s ?? sandboxExecLimits.timeoutS.default,
              stdin: body.stdin ?? null,
              env_keys: keys,
              attach,
            },
          })
          .run()
        audit(
          db,
          call,
          'sandbox.exec',
          {
            entity: 'run',
            id,
          },
          {
            after: {
              sandbox_id: row.id,
              command: body.command,
              env_keys: keys,
              attach,
            },
          },
        )
        stations.reconcile(row.station_id)
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

        const output = await sandboxRunOutput(kit, finished, call)

        return output
          ? {
              ...shownRun,
              output,
            }
          : shownRun
      },
      {
        sandbox: {
          id: 'sandbox_exec',
          summary:
            'Run a command in a running sandbox and wait up to wait_s for it; env values are never stored',
          level: 'deploy',
          cli: false,
        },
        body: input(SandboxExecBody),
        response: replies({
          201: SandboxExec,
        }),
      },
    )
    .post(
      '/sandboxes/:sandbox/shells',
      async ({ ctx, request, body, set }) => {
        const call = await kit.call(request)

        requireHumanIn(call, ctx.environment)
        const row = ctx.sandbox

        if (row.status !== 'running') {
          fail(
            'SANDBOX_NOT_RUNNING',
            `Sandbox ${row.name} is ${row.status}, so no shell can open in it.`,
            'Start the sandbox with start_sandbox, then open the shell.',
            {
              status: row.status,
            },
          )
        }

        requireConnected(kit.deps, row.station_id)
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
          'sandbox.shell',
          {
            entity: 'run',
            id,
          },
          {
            after: {
              sandbox_id: row.id,
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
        sandbox: {
          id: 'open_sandbox_shell',
          summary: 'Create a shell run in a sandbox; attach to it over the WebSocket at attach_url',
          level: 'deploy',
          mcp: false,
          cli: false,
        },
        body: input(SandboxShellBody),
        response: replies({
          201: SandboxShell,
        }),
      },
    )
    .get(
      '/sandboxes/:sandbox/runs',
      ({ ctx, query }) => listRuns(kit, eq(run.sandbox_id, ctx.sandbox.id), query),
      {
        sandbox: {
          id: 'list_sandbox_runs',
          summary: 'List the runs of a sandbox',
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
      '/sandboxes/:sandbox/metrics',
      async ({ ctx }) => {
        const reply = await stations
          .ask(ctx.sandbox.station_id, 'metrics.sample', {
            sandbox_ids: [ctx.sandbox.id],
          })
          .catch(stationError)
        const sample = reply.body.samples.find((s) => s.sandbox_id === ctx.sandbox.id)

        if (!sample) {
          fail(
            'NOT_FOUND',
            `${ctx.sandbox.name} reports no metrics.`,
            'Start the sandbox, then read metrics again.',
            {
              sandbox_id: ctx.sandbox.id,
              status: ctx.sandbox.status,
            },
          )
        }

        const { service_id: _s, deployment_id: _d, restarts: _r, sandbox_id: _b, ...rest } = sample!

        return {
          sandbox_id: ctx.sandbox.id,
          ...rest,
        }
      },
      {
        sandbox: {
          id: 'get_sandbox_metrics',
          summary: 'Latest live metrics sample of a sandbox',
          level: 'read',
          mcp: false,
        },
        response: replies({
          200: SandboxMetricSample,
        }),
      },
    )
    .get(
      '/sandboxes/:sandbox/variables',
      ({ ctx, query }) => {
        const rows = variablesOf(db, {
          scope: 'sandbox',
          id: ctx.sandbox.id,
        }).all()

        return {
          items: rows
            .sort((a, b) => a.key.localeCompare(b.key))
            .map((row) => select(kit.views.variable, row, kit.fields(query.fields))),
          next_cursor: null,
        }
      },
      {
        sandbox: {
          id: 'list_sandbox_variables',
          summary: 'List the variables of a sandbox; values are never listed',
          level: 'read',
        },
        query: t.Object(getQuery),
        response: replies({
          200: Page(Variable),
        }),
      },
    )
    .get(
      '/sandboxes/:sandbox/variables/resolved',
      async ({ ctx, request }) => {
        const call = await kit.call(request)

        return sandboxResolvedView(kit, call, ctx, {
          admin: can(call.principal, ctx.target, 'admin'),
        }) as Static<typeof SandboxResolved>
      },
      {
        sandbox: {
          id: 'get_sandbox_resolved_variables',
          summary:
            'The resolved variables of a sandbox with their sources; a value only with admin and never a sealed one',
          level: 'read',
        },
        response: replies({
          200: SandboxResolved,
        }),
      },
    )
    .patch(
      '/sandboxes/:sandbox/variables',
      async ({ ctx, request, body }) => {
        const call = await kit.call(request)

        if (ctx.environment.protected) {
          requireHuman(call.principal, 'A sandbox variable change in a protected environment', {
            environment_id: ctx.environment.id,
          })
        }

        if (ctx.sandbox.status === 'deleting') {
          conflict(ctx.sandbox, [
            'creating',
            'starting',
            'running',
            'stopping',
            'stopped',
            'failed',
          ])
        }

        const changes = new ChangeSet()

        planVariables(
          db,
          keyring,
          call.principal,
          changes,
          {
            scope: 'sandbox',
            parent: ctx.sandbox.id,
            sandboxId: ctx.sandbox.id,
            target: ctx.target,
          },
          body,
        )

        if (changes.empty) {
          return {
            variables: [],
          }
        }

        const result = commit(
          kit.deps,
          call,
          {
            environment: ctx.environment,
            protect: false,
          },
          changes,
        )

        if (!result.applied) {
          fail(
            'INTERNAL_ERROR',
            'a sandbox variable change was staged, which sandbox operations never are',
          )
        }

        const ids = result.applied
          ? [
              ...Object.values(result.refs),
              ...changes.changes.flatMap((c) => (c.op === 'update' ? [c.id] : [])),
            ].filter((id) => id.startsWith('var_'))
          : []

        audit(
          db,
          call,
          'sandbox.variables',
          {
            entity: 'sandbox',
            id: ctx.sandbox.id,
          },
          {
            after: {
              set: (body.set ?? []).map((v) => v.key),
              unset: body.unset ?? [],
            },
          },
        )
        stations.reconcile(ctx.sandbox.station_id)
        const rows = ids
          .map((id) => db.select().from(variable).where(eq(variable.id, id)).get())
          .filter((row): row is typeof variable.$inferSelect => row !== undefined)

        return {
          variables: rows.map((row) => select(kit.views.variable, row, undefined)),
        }
      },
      {
        sandbox: {
          id: 'set_sandbox_variables',
          summary:
            "Set and unset a sandbox's variables; references to project and global variables keep values out of the agent's hands",
          level: 'deploy',
        },
        body: input(SandboxVariablesPatchBody),
        response: replies({
          200: SandboxVariablesOutcome,
        }),
      },
    )
    .get(
      '/sandboxes/:sandbox/connections',
      async ({ ctx, request, query }) => {
        const call = await kit.call(request)
        const reply = await stations
          .ask(
            ctx.sandbox.station_id,
            'network.sample',
            {
              sandbox_ids: [ctx.sandbox.id],
            },
            {
              timeoutMs: 10_000,
            },
          )
          .catch(stationError)
        const sample = reply.body.samples.find((s) => s.sandbox_id === ctx.sandbox.id)

        if (!sample) {
          fail(
            'NOT_FOUND',
            `The station returned no connection sample for ${ctx.sandbox.name}.`,
            'Start the sandbox, then read the connections again.',
            {
              sandbox_id: ctx.sandbox.id,
            },
          )
        }

        return shapeSandboxSample(
          {
            db,
            redaction: kit.redaction,
            sandboxRedaction: kit.sandboxRedaction,
            actor: call.principal.actor,
            requestId: call.request_id,
          },
          sample!,
          ctx.sandbox,
          query.direction,
        )
      },
      {
        sandbox: {
          id: 'get_sandbox_connections',
          summary: 'Live connections and refused attempts of a sandbox; one sample',
          level: 'read',
        },
        query: t.Object({
          direction: t.Optional(input(StringEnum(networkDirectionValues))),
        }),
        response: replies({
          200: SandboxConnections,
        }),
      },
    )
    .get(
      '/sandboxes/:sandbox/dns-log',
      async ({ ctx, request, query }) => {
        const call = await kit.call(request)
        const reply = await stations
          .ask(
            ctx.sandbox.station_id,
            'dns.log',
            {
              sandbox_id: ctx.sandbox.id,
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
        const redact = kit.sandboxRedaction([ctx.sandbox.id], call.principal.actor, call.request_id)
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
        sandbox: {
          id: 'get_sandbox_dns_log',
          summary:
            "The sandbox's recent DNS queries from the resolver's ring, newest first, as untrusted data",
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
      '/sandboxes/:sandbox/network/probe',
      async ({ ctx, request, body }) => {
        const call = await kit.call(request)

        requireHumanIn(call, ctx.environment)

        if (ctx.sandbox.status !== 'running') {
          conflict(ctx.sandbox, ['running'])
        }

        kit.probeLimit(ctx.sandbox.id, ctx.environment.id)
        const kind = body.kind ?? 'tcp'
        const target = probeTarget(db, ctx.environment, body.to, body.port, kind)

        return sendSandboxProbe(kit.deps, call, ctx.sandbox, {
          kind,
          to: target.to,
          port: target.port,
          timeout_s: body.timeout_s ?? probeTimeout.defaultS,
        })
      },
      {
        sandbox: {
          id: 'probe_sandbox_network',
          summary:
            "Ask the sandbox's resolver as the sandbox, or judge one TCP handshake with the sandbox ruleset and send it from the station when the ruleset accepts the destination",
          level: 'deploy',
          cli: {
            render: 'probe',
          },
        },
        body: ProbeBody,
        response: replies({
          200: SandboxNetworkProbe,
        }),
      },
    )
    .post(
      '/sandboxes/:sandbox/snapshots',
      async ({ ctx, request, body, set }) => {
        const call = await kit.call(request)

        requireHumanIn(call, ctx.environment)
        const row = ctx.sandbox

        if (row.status === 'creating' || row.status === 'deleting') {
          conflict(row, ['starting', 'running', 'stopping', 'stopped', 'failed'])
        }

        requireConnected(kit.deps, row.station_id)
        requireDiskRoom(stationRow(row.station_id))
        const name = body?.name ?? null

        if (
          name &&
          db
            .select({
              id: sandbox_snapshot.id,
            })
            .from(sandbox_snapshot)
            .where(
              and(
                eq(sandbox_snapshot.environment_id, row.environment_id),
                eq(sandbox_snapshot.name, name),
              ),
            )
            .get()
        ) {
          fail(
            'NAME_TAKEN',
            `Environment ${ctx.environment.name} already has a snapshot named ${name}.`,
            undefined,
            {
              name,
            },
          )
        }

        const id = newId('sandbox_snapshot')

        db.insert(sandbox_snapshot)
          .values({
            id,
            sandbox_id: row.id,
            environment_id: row.environment_id,
            project_id: row.project_id,
            station_id: row.station_id,
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
          'sandbox.snapshot',
          {
            entity: 'sandbox_snapshot',
            id,
          },
          {
            after: {
              sandbox_id: row.id,
              name,
              source_state: sourceStateOf(row),
            },
          },
        )
        stations.reconcile(row.station_id)
        await pollUntil(
          () =>
            db
              .select({
                status: sandbox_snapshot.status,
              })
              .from(sandbox_snapshot)
              .where(eq(sandbox_snapshot.id, id))
              .get()?.status !== 'creating',
          snapshotWaitMs,
          request.signal,
        )
        set.status = 201
        const created = db.select().from(sandbox_snapshot).where(eq(sandbox_snapshot.id, id)).get()!

        return {
          ...select(kit.views.sandboxSnapshot, created, undefined),
          warnings: warningsFor(row),
        }
      },
      {
        sandbox: {
          id: 'snapshot_sandbox',
          summary:
            "Take a read-only copy of a sandbox's disk; files on the disk, credentials included, are copied into every snapshot and fork",
          level: 'deploy',
        },
        body: t.Optional(input(SandboxSnapshotBody)),
        response: replies({
          201: SandboxSnapshotCreated,
        }),
      },
    )
    .get(
      '/sandboxes/:sandbox/snapshots',
      ({ ctx, query }) => {
        return listSnapshots(
          query,
          and(
            eq(sandbox_snapshot.sandbox_id, ctx.sandbox.id),
            eq(sandbox_snapshot.environment_id, ctx.environment.id),
          ),
        )
      },
      {
        sandbox: {
          id: 'list_sandbox_snapshots',
          summary: 'List the snapshots of a sandbox',
          level: 'read',
        },
        query: t.Object({
          ...listQuery,
          status: filterMany(sandboxSnapshotStatusValues),
        }),
        response: replies({
          200: Page(SandboxSnapshot),
        }),
      },
    )
    .get(
      '/environments/:environment/sandbox-snapshots',
      ({ ctx, query }) => {
        const source = query.sandbox
          ? query.sandbox.startsWith('sbx_')
            ? query.sandbox
            : sandboxInEnvironment(db, ctx.environment.id, query.sandbox)?.id
          : undefined

        if (query.sandbox && !source) {
          return {
            items: [],
            next_cursor: null,
          }
        }

        return listSnapshots(
          query,
          and(
            eq(sandbox_snapshot.environment_id, ctx.environment.id),
            source ? eq(sandbox_snapshot.sandbox_id, source) : undefined,
          ),
        )
      },
      {
        environment: {
          id: 'list_environment_sandbox_snapshots',
          summary: 'List the sandbox snapshots of an environment',
          level: 'read',
        },
        query: t.Object({
          ...listQuery,
          sandbox: t.Optional(t.String()),
          status: filterMany(sandboxSnapshotStatusValues),
        }),
        response: replies({
          200: Page(SandboxSnapshot),
        }),
      },
    )
    .get(
      '/sandbox-snapshots/:id',
      ({ ctx, query }) => {
        return select(kit.views.sandboxSnapshot, ctx.snapshot, kit.fields(query.fields))
      },
      {
        sandbox_snapshot: {
          id: 'get_sandbox_snapshot',
          summary: 'Get a sandbox snapshot',
          level: 'read',
          mcp: false,
        },
        query: t.Object(getQuery),
        response: replies({
          200: SandboxSnapshot,
        }),
      },
    )
    .delete(
      '/sandbox-snapshots/:id',
      async ({ ctx, request }) => {
        const call = await kit.call(request)

        requireHumanIn(call, ctx.environment)
        requireConnected(kit.deps, ctx.snapshot.station_id)

        if (ctx.snapshot.status === 'failed') {
          db.delete(sandbox_snapshot).where(eq(sandbox_snapshot.id, ctx.snapshot.id)).run()
        } else {
          db.update(sandbox_snapshot)
            .set({
              status: 'deleting',
            })
            .where(eq(sandbox_snapshot.id, ctx.snapshot.id))
            .run()
        }

        audit(
          db,
          call,
          'sandbox.snapshot_delete',
          {
            entity: 'sandbox_snapshot',
            id: ctx.snapshot.id,
          },
          {
            before: {
              status: ctx.snapshot.status,
              name: ctx.snapshot.name,
            },
          },
        )
        stations.reconcile(ctx.snapshot.station_id)

        return {
          deleted: true as const,
        }
      },
      {
        sandbox_snapshot: {
          id: 'delete_sandbox_snapshot',
          summary: 'Delete a sandbox snapshot',
          level: 'deploy',
        },
        response: replies({
          200: SandboxSnapshotDeleted,
        }),
      },
    )
    .post(
      '/stations/:station/sandbox-storage/grow',
      async ({ request, params, body, set }) => {
        const call = await kit.call(request)
        const st = stationByRef(db, params.station)
        const before = requireGrowable(st, body.size_bytes).filesystem_bytes

        if (readSetting(db, 'platform.protected') && !call.principal.human) {
          const changes = new ChangeSet()

          changes.add('sandbox_storage', st.id, {
            size_bytes: body.size_bytes,
          })
          const result = commit(
            kit.deps,
            call,
            {
              environment: null,
              protect: true,
            },
            changes,
          )

          if (!result.applied) {
            return kit.stagedBody(result, set)
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
          'sandbox.storage_grow',
          {
            entity: 'station',
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
          id: 'grow_sandbox_storage',
          summary:
            "Grow a station's sandbox filesystem to size_bytes while sandboxes run; staged for a non-human actor under platform.protected",
          level: 'instance admin',
        },
        body: input(SandboxStorageGrowRequest),
        response: replies({
          200: StorageGrown,
          202: Staged,
        }),
      },
    )

  function listSnapshots(
    query: { limit?: number; cursor?: string; fields?: string; status?: string },
    scope: ReturnType<typeof and>,
  ) {
    const statuses = csv(query.status)
    const page = collect(
      (cursor, size) =>
        db
          .select()
          .from(sandbox_snapshot)
          .where(
            and(
              scope,
              statuses
                ? inArray(sandbox_snapshot.status, statuses as SandboxSnapshotRow['status'][])
                : undefined,
              before(sandbox_snapshot.id, cursor),
            ),
          )
          .orderBy(desc(sandbox_snapshot.id))
          .limit(size)
          .all(),
      query,
    )

    return {
      items: page.rows.map((row) =>
        select(kit.views.sandboxSnapshot, row, kit.fields(query.fields)),
      ),
      next_cursor: page.next_cursor,
    }
  }
}
