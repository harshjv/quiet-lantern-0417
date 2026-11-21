import { and, eq, isNull } from 'drizzle-orm'

import {
  machineExecLimits,
  machineSizeDefaults,
  workspaceEgress,
  workspaceRoot,
  workspaceSizeDefaults,
  type tokenLevelValues,
  type WorkspaceAgent,
  type WorkspaceKindValue,
} from '@stationly/protocol'
import { releaseRepositories } from '@stationly/protocol/release-config'

import { requireHuman } from '../api/access.ts'
import { ChangeSet, commit, placeName } from '../api/changes.ts'
import { audit, type Call } from '../api/context.ts'
import { requireStationReady } from '../api/deployments.ts'
import { fail, invalid } from '../api/errors.ts'
import { ensureMachineNetwork } from '../api/ipam.ts'
import type { Kit } from '../api/kit.ts'
import {
  machineInTarget,
  previewIdOf,
  scopeOf,
  type MachineContext,
  type ProjectRow,
  type TargetRow,
} from '../api/lookup.ts'
import { requireMintable } from '../api/routes/tokens.ts'
import { planVariables } from '../api/variable-changes.ts'
import { scopedTokenMaxSeconds } from '../auth/auth.ts'
import { dropToken, mintToken } from '../auth/tokens.ts'
import type { Db } from '../db/client.ts'
import { newId } from '../db/ids.ts'
import { machine, run, server } from '../db/schema.ts'
import { effectivePins } from '../platform/lockfile.ts'
import { newKeyPlaceholders, newPlaceholder } from '../secrets/relay.ts'
import { gitIdentityOf } from '../team/members.ts'

import { egressWithin, requireHumanToWiden, workspaceHeldBy } from './confinement.ts'
import { normalizeEgress } from './egress.ts'
import { stopAtFrom } from './lifecycle.ts'
import { fittingMemory, requireDiskRoom, requireQuota } from './limits.ts'
import { requireRepositoryAccess } from './repository-access.ts'
import { requireRuntime } from './runtime.ts'
import {
  isRepositoryName,
  machineSetupAs,
  repositoryName,
  setupCommand,
  workspacePath,
  workspaceVariableSets,
} from './workspace.ts'

export type MachineCreateInput = {
  name: string
  workspace: {
    agent: WorkspaceAgent
    repository: string
    branch?: string
    level: (typeof tokenLevelValues)[number]
  }
}

export type MachineCreateOptions = {
  taskBranch?: string | null
  kind?: WorkspaceKindValue
  memoryBytes?: number
  repositoryReadable?: boolean
}

export type MachineContextOf = {
  project: ProjectRow
  target_row: TargetRow
  target: MachineContext['target']
}

const pickStation = (kit: Kit) => {
  const { db, stations } = kit.deps
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
      'No online server can run tasks.',
      'Install task support on a server (stationd install --sandbox-device or --sandbox-size) and wait for it to reconnect.',
      {
        missing: 'machines',
      },
    )
  }

  return invalid([
    {
      path: '/server_id',
      message: `${capable.length} servers can run tasks; name one of ${capable.map((s) => s.name).join(', ')}`,
    },
  ])
}

const toolchainImage = (db: Db, st: typeof server.$inferSelect) => {
  const pin = effectivePins(db, st.arch).sandbox_toolchain

  if (!pin?.digest) {
    fail(
      'SERVER_CAPABILITY_MISSING',
      'The platform lockfile pins no sandbox_toolchain image, so there is no image for tasks.',
      'Upgrade to a release that pins sandbox_toolchain with sly platform upgrade.',
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

export const createMachine = async (
  kit: Kit,
  call: Call,
  ctx: MachineContextOf,
  body: MachineCreateInput,
  options: MachineCreateOptions = {},
) => {
  const { db, stations, keyring } = kit.deps
  const taskBranch = options.taskBranch ?? null
  const kind = options.kind ?? 'own'
  const wanted = body.workspace

  if (ctx.target_row.kind === 'production') {
    requireHuman(call.principal, 'A task in production', scopeOf(ctx.target_row))
  }

  const st = pickStation(kit)

  requireStationReady(db, st.id)

  if (!st.capabilities?.sandboxes) {
    fail(
      'SERVER_CAPABILITY_MISSING',
      `Server ${st.name} cannot run tasks.`,
      'Install task support on the server, then retry.',
      {
        missing: 'machines',
        server_id: st.id,
      },
    )
  }

  const runtime = requireRuntime(st, undefined)
  const size = {
    ...machineSizeDefaults,
    memory_bytes: fittingMemory(db, st, options.memoryBytes ?? workspaceSizeDefaults.memory_bytes),
  }

  if (!isRepositoryName(repositoryName(wanted.repository))) {
    invalid([
      {
        path: '/workspace/repository',
        message: 'the last path segment, without .git, needs at least one letter or digit',
      },
    ])
  }

  if (!options.repositoryReadable) {
    await requireRepositoryAccess(kit.deps, {
      project: ctx.project,
      target: ctx.target_row.id,
      repository: wanted.repository,
      variables: undefined,
    })
  }

  const scopes = [
    {
      ...scopeOf(ctx.target_row),
      level: wanted.level,
    },
  ]

  requireMintable(call.principal, scopes)
  const caller = workspaceHeldBy(db, call.principal)
  const egress = normalizeEgress(workspaceEgress(wanted.agent))

  requireHumanToWiden(
    call.principal,
    caller,
    caller && !egressWithin(egress, caller.egress)
      ? 'cannot create a machine with wider egress than its own'
      : null,
  )
  const image = toolchainImage(db, st)

  requireQuota(
    db,
    st,
    {
      machineId: null,
      newMachine: true,
      running: true,
      memoryBytes: size.memory_bytes,
    },
    call.principal,
  )
  requireDiskRoom(st)
  const id = newId('machine')
  const name = body.name

  if (machineInTarget(db, ctx.target_row.id, name)) {
    fail(
      'NAME_TAKEN',
      `${placeName(ctx.target_row)} already has a computer named ${name}.`,
      undefined,
      {
        name,
      },
    )
  }

  ensureMachineNetwork(db, st.id)

  const minted = await mintToken(kit.deps.auth, db, {
    userId: call.principal.user_id,
    name: `workspace/${name}`,
    kind: 'scoped',
    scopes,
    seconds: scopedTokenMaxSeconds,
    machineHeld: true,
  })
  const workspace = {
    kind,
    agent: wanted.agent,
    repository: kind === 'project' ? null : wanted.repository,
    branch: kind === 'project' ? null : (wanted.branch ?? null),
    path: kind === 'project' ? workspaceRoot : workspacePath(wanted.repository),
    level: wanted.level,
    token_id: minted.row.id,
    token_placeholder: newPlaceholder(),
    credential_placeholders: newKeyPlaceholders(),
    setup_run_id: newId('run'),
    task_branch: taskBranch,
  }
  const variables = workspaceVariableSets(
    db,
    {
      project: ctx.project.id,
      preview: previewIdOf(ctx.target_row),
    },
    wanted.agent,
    minted.key,
    [],
    kind,
  )

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
          command: null,
          size,
          runtime,
          network: 'isolated',
          docker: false,
          egress,
          ttl_s: null,
          desired_state: 'running',
          stop_at: stopAtFrom(null),
          status: 'creating',
          status_reason: null,
          stopped_at: null,
          workspace,
          created_by: call.principal.actor,
        })
        .run()

      const changes = new ChangeSet()

      planVariables(
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
          target: ctx.target_row,
          protect: false,
        },
        changes,
      )
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
            network: 'isolated',
            docker: false,
            ttl_s: null,
            start: true,
            workspace,
            environment_variables: variables.map((v) => v.name),
          },
        },
      )
    })
  } catch (error) {
    dropToken(db, minted.row)

    throw error
  }

  stations.reconcile(st.id)

  return {
    id,
  }
}
