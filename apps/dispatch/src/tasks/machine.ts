import type { Static } from '@sinclair/typebox'
import { and, asc, eq, inArray, max } from 'drizzle-orm'

import {
  machineExecLimits,
  taskPortRange,
  taskSlotMemoryBytes,
  workspaceEnv,
  workspaceUser,
  type Actor,
} from '@stationly/protocol'

import { scopeOf } from '../api/lookup.ts'
import { scopedTokenMaxSeconds, type AuthService } from '../auth/auth.ts'
import { dropToken, mintToken, tokenRow } from '../auth/tokens.ts'
import type { Db } from '../db/client.ts'
import { newId } from '../db/ids.ts'
import {
  conversation,
  machine,
  machine_user,
  project,
  run,
  target,
  task,
  token,
  type RunCredential,
  type WorkspaceCleanup,
} from '../db/schema.ts'
import {
  asMember,
  cleanupCommand,
  machineSetupAs,
  repositoryName,
  setupCommand,
  taskSetupCommand,
} from '../sandboxes/workspace.ts'
import { ephemeralDelivery } from '../secrets/deliver.ts'
import type { Keyring } from '../secrets/keyring.ts'
import {
  credentialExpiry,
  newKeyPlaceholders,
  newPlaceholder,
  relayHosts,
  type RelayCredential,
  type RelayValue,
} from '../secrets/relay.ts'
import { machineDeliver } from '../secrets/sandbox.ts'
import type { StationServer } from '../station/server.ts'
import { credentialSources, memberToken, runGitHubToken, tokenAad } from '../team/keys.ts'
import { gitIdentityOf } from '../team/members.ts'

import { closePendingApprovals } from './approvals.ts'
import { latestConversation, runnerLive, startTimeoutMs, wantRunner } from './runner.ts'
import { saveActivity, taskChanged, wakeTask, type TaskRow } from './status.ts'

type MachineRow = typeof machine.$inferSelect
type ProjectRow = typeof project.$inferSelect

const setupActor: Static<typeof Actor> = {
  type: 'system',
  id: null,
  client: 'dispatch/task-setup',
}

const slotStatuses = ['setting_up', 'working', 'waiting'] as const

const liveMachineStatuses = ['creating', 'starting', 'running', 'stopped']

export const projectMachine = (db: Db, row: Pick<ProjectRow, 'machine'>) => {
  const id = row.machine?.machine_id

  if (!id) {
    return null
  }

  const box = db.select().from(machine).where(eq(machine.id, id)).get()

  return box && box.deletion === null && liveMachineStatuses.includes(box.status) ? box : null
}

export const slotsFor = (memoryBytes: number) =>
  Math.max(1, Math.floor(memoryBytes / taskSlotMemoryBytes))

const slotsOf = (db: Db, box: MachineRow) =>
  db.select().from(project).where(eq(project.id, box.project_id)).get()?.machine?.slots ??
  slotsFor(box.size.memory_bytes)

export const holdsSlot = (db: Db, row: TaskRow) => {
  if (row.machine !== 'project') {
    return false
  }

  if ((slotStatuses as readonly string[]).includes(row.status)) {
    return true
  }

  const session = latestConversation(db, row.id)

  return !!session && runnerLive(session)
}

const tasksOn = (db: Db, machineId: string) =>
  db.select().from(task).where(eq(task.machine_id, machineId)).all()

export const freeSlots = (db: Db, box: MachineRow, except?: string) =>
  slotsOf(db, box) -
  tasksOn(db, box.id).filter((row) => row.id !== except && holdsSlot(db, row)).length

export const claimSlot = (db: Db, row: TaskRow, now = new Date()) => {
  if (row.machine !== 'project' || holdsSlot(db, row)) {
    return true
  }

  const box = db.select().from(machine).where(eq(machine.id, row.machine_id)).get()

  if (box && freeSlots(db, box, row.id) > 0) {
    return true
  }

  queueTask(db, row, now)

  return false
}

export const queueTask = (db: Db, row: TaskRow, now = new Date()) => {
  db.update(task)
    .set({
      status: 'queued',
      queued_at: row.queued_at ?? now,
      attention: null,
    })
    .where(eq(task.id, row.id))
    .run()
  taskChanged(db, row)
}

const setupSucceeded = (db: Db, runId: string | null) =>
  !!runId && db.select().from(run).where(eq(run.id, runId)).get()?.status === 'succeeded'

export const resumeTask = (db: Db, row: TaskRow, now = new Date()) => {
  const session = latestConversation(db, row.id)

  if (row.machine === 'project' && !setupSucceeded(db, row.setup_run_id)) {
    const box = db.select().from(machine).where(eq(machine.id, row.machine_id)).get()

    if (box) {
      machineSetupRerun(db, box)
    }

    db.update(task)
      .set({
        status: 'setting_up',
        setup_run_id: null,
        queued_at: null,
      })
      .where(eq(task.id, row.id))
      .run()
    taskChanged(db, row)
  } else {
    db.update(task)
      .set({
        queued_at: null,
      })
      .where(eq(task.id, row.id))
      .run()
    wakeTask(db, row, session?.agent_session_id ?? '', now)
  }

  if (session && !runnerLive(session, now)) {
    wantRunner(db, session.id)
  }
}

export const queuePosition = (db: Db, row: TaskRow) =>
  row.status !== 'queued' || !row.queued_at
    ? null
    : db
        .select({
          id: task.id,
          queued_at: task.queued_at,
        })
        .from(task)
        .where(and(eq(task.machine_id, row.machine_id), eq(task.status, 'queued')))
        .all()
        .filter((other) => other.queued_at! < row.queued_at!).length

export const promoteQueued = (db: Db) => {
  const machines = db
    .select()
    .from(machine)
    .where(inArray(machine.status, ['creating', 'starting', 'running']))
    .all()
    .filter((box) => box.workspace?.kind === 'project')

  for (const box of machines) {
    let free = freeSlots(db, box)

    if (free <= 0) {
      continue
    }

    const queued = db
      .select()
      .from(task)
      .where(and(eq(task.machine_id, box.id), eq(task.status, 'queued')))
      .orderBy(asc(task.queued_at))
      .all()

    for (const row of queued) {
      if (free <= 0) {
        break
      }

      resumeTask(db, row)
      free -= 1
    }
  }
}

export const nextPort = (db: Db, machineId: string) => {
  const taken = new Set(tasksOn(db, machineId).map((row) => row.port))

  for (let port: number = taskPortRange.first; port <= taskPortRange.last; port += 1) {
    if (!taken.has(port)) {
      return port
    }
  }

  return null
}

const firstMachineUid = 2000

export const homeOf = (name: string) => `/home/${name}`

const machineUserRow = (db: Db, machineId: string, userId: string) =>
  db
    .select()
    .from(machine_user)
    .where(and(eq(machine_user.machine_id, machineId), eq(machine_user.user_id, userId)))
    .get()

export const machineUserFor = async (
  db: Db,
  deps: Pick<MachineDeps, 'auth' | 'keyring'>,
  box: Pick<MachineRow, 'id' | 'name' | 'project_id' | 'target_id'>,
  userId: string,
  now = new Date(),
) => {
  const found = machineUserRow(db, box.id, userId)

  if (found?.token_id) {
    return found
  }

  if (!found) {
    const highest = db
      .select({
        uid: max(machine_user.uid),
      })
      .from(machine_user)
      .where(eq(machine_user.machine_id, box.id))
      .get()?.uid
    const uid = highest ? highest + 1 : firstMachineUid

    db.insert(machine_user)
      .values({
        machine_id: box.id,
        user_id: userId,
        uid,
        name: `m${uid}`,
        created_at: now,
      })
      .run()
  }

  const row = machineUserRow(db, box.id, userId)!
  const minted = await mintToken(deps.auth, db, {
    userId,
    name: `machine/${box.name}/${row.name}`,
    kind: 'scoped',
    scopes: [
      {
        ...scopeOf(db.select().from(target).where(eq(target.id, box.target_id)).get()!),
        level: 'read',
      },
    ],
    seconds: scopedTokenMaxSeconds,
    machineHeld: true,
  })
  const sealed = deps.keyring.encrypt(tokenAad(box.id, userId), minted.key)

  db.update(machine_user)
    .set({
      token_id: minted.row.id,
      token_key: sealed.ciphertext,
      token_placeholder: newPlaceholder(),
      key_placeholders: newKeyPlaceholders(),
      data_key_id: sealed.data_key_id,
    })
    .where(and(eq(machine_user.machine_id, box.id), eq(machine_user.user_id, userId)))
    .run()

  return machineUserRow(db, box.id, userId)!
}

type MachineUserRow = typeof machine_user.$inferSelect

export const memberEnv = (member: MachineUserRow): [string, string][] => [
  ['STATIONLY_MEMBER', member.name],
]

export const memberRelayEnv = (member: MachineUserRow): [string, string][] => [
  ...memberEnv(member),
  ...(member.token_placeholder
    ? ([[workspaceEnv.token, member.token_placeholder]] as [string, string][])
    : []),
]

export const memberKeyPlaceholders = (
  db: Db,
  member: MachineUserRow,
  shared: { project: string; target: string },
): [string, string][] =>
  credentialSources(db, member.user_id, shared).flatMap((source) => {
    const placeholder = member.key_placeholders?.[source.key]

    return placeholder ? [[source.key, placeholder] as [string, string]] : []
  })

export const memberCredentials = (
  db: Db,
  keyring: Keyring,
  member: MachineUserRow,
  seconds: number,
  now = new Date(),
): RelayCredential[] => {
  const value = memberToken(keyring, member)
  const found = member.token_id ? tokenRow(db, member.token_id) : undefined

  return value && found
    ? [
        {
          key: workspaceEnv.token,
          value,
          token_id: found.id,
          expires_at: credentialExpiry(found.expires_at, seconds, now),
        },
      ]
    : []
}

export const redeliveredCredentials = (
  db: Db,
  keyring: Keyring,
  stationId: string,
  runId: string,
  now = new Date(),
): RelayValue[] => {
  const row = db.select().from(run).where(eq(run.id, runId)).get()
  const box = row?.machine_id
    ? db.select().from(machine).where(eq(machine.id, row.machine_id)).get()
    : undefined

  if (!row || box?.server_id !== stationId) {
    return []
  }

  return (row.exec?.credentials ?? []).flatMap((held) => {
    const member =
      new Date(held.expires_at) > now ? machineUserByToken(db, box.id, held.token_id) : undefined
    const value = member ? memberToken(keyring, member) : null

    return value
      ? [
          {
            key: held.key,
            value,
            placeholder: held.placeholder,
            hosts: relayHosts,
            expires_at: held.expires_at,
          },
        ]
      : []
  })
}

export const machineUserByToken = (db: Db, machineId: string, tokenId: string | null) =>
  tokenId
    ? db
        .select()
        .from(machine_user)
        .where(and(eq(machine_user.machine_id, machineId), eq(machine_user.token_id, tokenId)))
        .get()
    : undefined

export const machineUserOf = (db: Db, row: Pick<TaskRow, 'machine' | 'machine_id' | 'owner'>) =>
  row.machine === 'project' && row.owner.id
    ? db
        .select()
        .from(machine_user)
        .where(
          and(eq(machine_user.machine_id, row.machine_id), eq(machine_user.user_id, row.owner.id)),
        )
        .get()
    : undefined

export const worktreeOf = (branch: string, taskId: string, home: string) =>
  `${home}/tasks/${branch.replace(/^task\//, '')}-${taskId.slice(-4).toLowerCase()}`

export const cloneOf = (repository: string, home: string) =>
  `${home}/repos/${repositoryName(repository)}`

type RunAs = { user: string; cwd: string; envKeys?: string[]; credentials?: RunCredential[] }

export const execRun = (
  box: MachineRow,
  id: string,
  command: string[],
  as: RunAs = {
    user: workspaceUser.name,
    cwd: workspaceUser.home,
  },
) => ({
  id,
  app_id: null,
  machine_id: box.id,
  deployment_id: null,
  kind: 'exec' as const,
  command,
  status: 'queued' as const,
  log_ref: `logs/sandboxes/${box.id}/${id}`,
  tty: false,
  actor: setupActor,
  exec: {
    cwd: as.cwd,
    user: as.user,
    timeout_s: machineExecLimits.timeoutS.default,
    stdin: null,
    env_keys: as.envKeys ?? [],
    attach: false,
    ...(as.credentials?.length
      ? {
          credentials: as.credentials,
        }
      : {}),
  },
})

export type RunDelivery = (
  stationId: string,
  runId: string,
  entries: [string, string][],
  credentials?: RelayValue[],
) => Promise<void>

export const stationRunDelivery =
  (stations: Pick<StationServer, 'ask'>): RunDelivery =>
  async (station, runId, entries, credentials = []) => {
    await stations.ask(
      station,
      'secrets.deliver',
      ephemeralDelivery(
        {
          run_id: runId,
        },
        'run',
        entries,
        credentials,
      ),
    )
  }

export type MachineRefresh = (box: Pick<MachineRow, 'id' | 'server_id'>) => Promise<void>

export const stationMachineDelivery =
  (stations: Pick<StationServer, 'ask'>, db: Db, keyring: Keyring): MachineRefresh =>
  async (box) => {
    await stations.ask(
      box.server_id,
      'secrets.deliver',
      machineDeliver(db, keyring, box.id, setupActor),
    )
  }

export type MachineDeps = {
  reconcile: (station: string) => void
  deliver: RunDelivery
  refreshMachine: MachineRefresh
  auth: AuthService
  keyring: Keyring
}

export const deliveredRun = async (
  deliver: RunDelivery,
  box: Pick<MachineRow, 'server_id'>,
  id: string,
  entries: [string, string][],
  credentials: RelayCredential[] = [],
) => {
  const sorted = [...entries].sort(([a], [b]) => a.localeCompare(b))
  const relayed = credentials.map((credential) => ({
    key: credential.key,
    value: credential.value,
    placeholder: newPlaceholder(),
    hosts: relayHosts,
    expires_at: credential.expires_at.toISOString(),
  }))

  if (sorted.length || relayed.length) {
    await deliver(box.server_id, id, sorted, relayed)
  }

  return {
    envKeys: [...sorted.map(([key]) => key), ...relayed.map((r) => r.key)].sort(),
    credentials: relayed.map((r, i) => ({
      key: r.key,
      placeholder: r.placeholder,
      token_id: credentials[i]!.token_id,
      expires_at: r.expires_at,
    })),
  }
}

const runStatus = (db: Db, runId: string | null | undefined) =>
  runId ? db.select().from(run).where(eq(run.id, runId)).get()?.status : undefined

const failTask = (db: Db, row: TaskRow) => {
  db.update(task)
    .set({
      status: 'failed',
    })
    .where(eq(task.id, row.id))
    .run()
  taskChanged(db, row)
}

export const startTaskSetups = async (db: Db, deps: MachineDeps) => {
  const pending = db
    .select({
      task,
      box: machine,
    })
    .from(task)
    .innerJoin(machine, eq(machine.id, task.machine_id))
    .where(and(eq(task.machine, 'project'), eq(task.status, 'setting_up')))
    .all()

  for (const { task: row, box } of pending) {
    const machineSetup = runStatus(db, box.workspace?.setup_run_id)

    if (machineSetup === 'failed' || machineSetup === 'cancelled') {
      failTask(db, row)
      continue
    }

    const ownRun = row.setup_run_id
      ? db.select().from(run).where(eq(run.id, row.setup_run_id)).get()
      : undefined
    const own = ownRun?.status
    const timedOut =
      own === 'succeeded' &&
      !!ownRun?.finished_at &&
      Date.now() - ownRun.finished_at.getTime() > startTimeoutMs

    if (own === 'failed' || own === 'cancelled' || timedOut) {
      failTask(db, row)
      continue
    }

    const member = machineUserOf(db, row)

    if (row.setup_run_id || box.status !== 'running' || machineSetup !== 'succeeded' || !member) {
      continue
    }

    const id = newId('run')
    const home = homeOf(member.name)
    const cleanup = (box.workspace?.cleanup ?? []).filter((entry) => entry.user === member.name)

    if (!member.token_id) {
      continue
    }

    const token = await runGitHubToken(deps.auth, db, deps.keyring, row.owner.id, {
      project: box.project_id,
      target: box.target_id,
    })
    const delivered = await deliveredRun(
      deps.deliver,
      box,
      id,
      [...memberEnv(member), ...(token ? ([['GH_TOKEN', token]] as [string, string][]) : [])],
      memberCredentials(db, deps.keyring, member, machineExecLimits.timeoutS.default),
    ).catch(() => null)

    if (!delivered) {
      continue
    }

    db.transaction((tx) => {
      const tdb = tx as unknown as Db

      tdb
        .insert(run)
        .values(
          execRun(
            box,
            id,
            asMember(
              member,
              taskSetupCommand({
                repository: row.repository,
                clone: cloneOf(row.repository, home),
                worktree: row.worktree!,
                baseBranch: row.base_branch,
                branch: row.branch,
                cleanup,
                identity: gitIdentityOf(db, row.owner.id),
              }),
            ),
            {
              user: 'root',
              cwd: '/root',
              ...delivered,
            },
          ),
        )
        .run()
      tdb
        .update(task)
        .set({
          setup_run_id: id,
        })
        .where(eq(task.id, row.id))
        .run()

      if (cleanup.length) {
        tdb
          .update(machine)
          .set({
            workspace: {
              ...box.workspace!,
              cleanup: (box.workspace?.cleanup ?? []).filter((entry) => entry.user !== member.name),
            },
          })
          .where(eq(machine.id, box.id))
          .run()
      }
    })
    deps.reconcile(box.server_id)
  }
}

export const taskSetupReady = (db: Db, row: Pick<TaskRow, 'machine' | 'setup_run_id'>) =>
  row.machine !== 'project' || setupSucceeded(db, row.setup_run_id)

export const removeWorktree = (db: Db, row: TaskRow, reconcile: (station: string) => void) => {
  const box = db.select().from(machine).where(eq(machine.id, row.machine_id)).get()
  const member = machineUserOf(db, row)

  if (!box?.workspace || !row.worktree || !member) {
    return
  }

  const entry: WorkspaceCleanup = {
    clone: cloneOf(row.repository, homeOf(member.name)),
    worktree: row.worktree,
    branch: row.branch,
    user: member.name,
  }

  if (box.status === 'running') {
    db.insert(run)
      .values(
        execRun(box, newId('run'), cleanupCommand([entry]), {
          user: member.name,
          cwd: homeOf(member.name),
        }),
      )
      .run()
    reconcile(box.server_id)

    return
  }

  db.update(machine)
    .set({
      workspace: {
        ...box.workspace,
        cleanup: [...(box.workspace.cleanup ?? []), entry],
      },
    })
    .where(eq(machine.id, box.id))
    .run()
}

export const stopTask = (db: Db, row: TaskRow, now = new Date()) => {
  closePendingApprovals(db, row.id, now)

  if (row.machine === 'project' && !setupSucceeded(db, row.setup_run_id)) {
    db.update(task)
      .set({
        setup_run_id: null,
      })
      .where(eq(task.id, row.id))
      .run()
  }

  saveActivity(db, row, {
    status: 'none',
    since: now.toISOString(),
    session_id: null,
    last_event_at: null,
    kind: null,
    agents: [],
  })
}

export const stopMachineTasks = (db: Db, machineId: string, now: Date) => {
  for (const row of tasksOn(db, machineId)) {
    db.update(conversation)
      .set({
        runner_seen_at: null,
      })
      .where(eq(conversation.task_id, row.id))
      .run()

    if ((slotStatuses as readonly string[]).includes(row.status)) {
      stopTask(db, row, now)
    }
  }
}

export const tasksInUse = (db: Db, machineId: string) =>
  db
    .select({
      id: task.id,
    })
    .from(task)
    .where(
      and(
        eq(task.machine_id, machineId),
        inArray(task.status, ['queued', 'setting_up', 'working', 'waiting']),
      ),
    )
    .limit(1)
    .get() !== undefined

export const taskOnMachine = (db: Db, machineId: string, cwd: string | undefined) => {
  const all = tasksOn(db, machineId)

  if (all.length === 1 && all[0]!.machine === 'own') {
    return all[0]!
  }

  if (!cwd) {
    return null
  }

  return (
    all.find(
      (row) => row.worktree && (cwd === row.worktree || cwd.startsWith(`${row.worktree}/`)),
    ) ?? null
  )
}

export const machineSetupRerun = (db: Db, box: MachineRow) => {
  const status = runStatus(db, box.workspace?.setup_run_id)

  if (!box.workspace || (status !== 'failed' && status !== 'cancelled')) {
    return
  }

  const command = setupCommand(box.workspace)

  const id = newId('run')

  db.transaction((tx) => {
    const tdb = tx as unknown as Db

    tdb
      .insert(run)
      .values(
        execRun(box, id, command, {
          user: machineSetupAs(box.workspace!).user,
          cwd: machineSetupAs(box.workspace!).home,
        }),
      )
      .run()
    tdb
      .update(machine)
      .set({
        workspace: {
          ...box.workspace!,
          setup_run_id: id,
        },
      })
      .where(eq(machine.id, box.id))
      .run()
  })
}

export const removeMachineUsers = (
  db: Db,
  userId: string,
  reconcile: (station: string) => void,
) => {
  for (const member of db
    .select()
    .from(machine_user)
    .where(eq(machine_user.user_id, userId))
    .all()) {
    const held = member.token_id
      ? db.select().from(token).where(eq(token.id, member.token_id)).get()
      : undefined

    if (held) {
      dropToken(db, held)
    }

    db.update(machine_user)
      .set({
        token_id: null,
        token_key: null,
        token_placeholder: null,
        key_placeholders: null,
        data_key_id: null,
      })
      .where(and(eq(machine_user.machine_id, member.machine_id), eq(machine_user.user_id, userId)))
      .run()

    const box = db.select().from(machine).where(eq(machine.id, member.machine_id)).get()

    if (box?.status === 'running') {
      db.insert(run)
        .values(
          execRun(
            box,
            newId('run'),
            ['bash', '-c', 'pkill -KILL -u "$1" || true', 'end-member', member.name],
            {
              user: 'root',
              cwd: '/root',
            },
          ),
        )
        .run()
      reconcile(box.server_id)
    }
  }
}
