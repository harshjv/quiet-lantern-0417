import { desc, eq } from 'drizzle-orm'

import { workspaceUser } from '@stationly/protocol'

import { emit } from '../api/context.ts'
import { fail } from '../api/errors.ts'
import type { Db } from '../db/client.ts'
import { newId } from '../db/ids.ts'
import { environment, project, run, sandbox, service, ship_request, task } from '../db/schema.ts'
import { GitHubError, repoOf } from '../github/client.ts'
import type { GitHub } from '../github/service.ts'
import type { Log } from '../log.ts'
import { isGitHubRepository, repositoryLabel } from '../sandboxes/repository-access.ts'
import { shipCommand } from '../sandboxes/workspace.ts'
import { every } from '../schedule.ts'
import { gitIdentityOf } from '../team/members.ts'

import { execRun, machineUserOf, type RunDelivery } from './machine.ts'
import { taskChanged, taskSubject, type TaskRow } from './status.ts'

export type ShipRow = typeof ship_request.$inferSelect

type RepoSource = { repo?: string; branch?: string }

const shipTimeoutS = 600

const shipGraceS = 120

const finished: string[] = ['succeeded', 'failed', 'cancelled']

const deciding = new Set<string>()

export const repoOfTask = (row: Pick<TaskRow, 'repository'>) =>
  repoOf(repositoryLabel(row.repository))

export const latestShip = (db: Db, taskId: string) =>
  db
    .select()
    .from(ship_request)
    .where(eq(ship_request.task_id, taskId))
    .orderBy(desc(ship_request.created_at))
    .get()

export const shipView = (db: Db, request: ShipRow) => {
  const owner = db.select().from(task).where(eq(task.id, request.task_id)).get()

  return {
    id: request.id,
    task_id: request.task_id,
    project_id: request.project_id,
    title: owner?.title ?? '',
    status: request.status,
    pull_request: owner?.pull_request ?? null,
    preview_environment_id: owner?.preview_environment_id ?? null,
    head_sha: request.head_sha,
    reason: request.reason,
    requested_by: request.requested_by,
    decided_by: request.decided_by,
    decided_at: request.decided_at?.toISOString() ?? null,
    created_at: request.created_at.toISOString(),
  }
}

const shipChanged = (db: Db, row: TaskRow, request: ShipRow, type: string) => {
  emit(db, type, taskSubject(row), {
    ship_request: request.id,
    status: request.status,
  })
  taskChanged(db, row)
}

export const startShip = async (
  deps: { db: Db; github: GitHub; deliver: RunDelivery; reconcile: (station: string) => void },
  row: TaskRow,
  requestedBy: string,
) => {
  const { db } = deps

  if (!isGitHubRepository(row.repository)) {
    fail(
      'VALIDATION_FAILED',
      `${row.repository} is not on GitHub, so Stationly cannot open a pull request for it.`,
      'Push the branch from the task by hand.',
    )
  }

  const box = db.select().from(sandbox).where(eq(sandbox.id, row.sandbox_id)).get()

  if (!box || box.status !== 'running' || !row.worktree) {
    fail(
      'SANDBOX_NOT_RUNNING',
      `The machine of task ${row.title} is not running, so its work cannot be pushed.`,
      'Reply to the task to start its machine, then ship again.',
      {
        sandbox_id: row.sandbox_id,
      },
    )
  }

  if (row.status === 'working' || row.status === 'setting_up') {
    fail(
      'VALIDATION_FAILED',
      `The agent is still working on task ${row.title}.`,
      'Ship it once the turn has finished, or stop the task first.',
    )
  }

  const held = latestShip(db, row.id)

  if (held?.status === 'pushing') {
    fail(
      'VALIDATION_FAILED',
      `Task ${row.title} is already being pushed.`,
      'Wait for the push to finish.',
    )
  }

  const repo = repoOfTask(row)
  const token = await deps.github.pushToken(repo).catch((error: unknown) =>
    fail(
      'REPO_ACCESS_REQUIRED',
      error instanceof Error ? error.message : String(error),
      'Install the GitHub App on the repository and grant it contents and pull requests write access.',
      {
        repo,
      },
    ),
  )
  const member = machineUserOf(db, row)
  const id = newId('run')

  await deps.deliver(box!.station_id, id, [['GITHUB_PUSH_TOKEN', token]])

  const command = shipCommand({
    user: member?.name ?? workspaceUser.name,
    worktree: row.worktree!,
    branch: row.branch,
    remote: row.repository.replace(/\.git$/, ''),
    message: `Work from task ${row.title}`,
    identity: gitIdentityOf(db, row.owner.id),
  })
  const runRow = execRun(box!, id, command, {
    user: 'root',
    cwd: '/root',
    envKeys: ['GITHUB_PUSH_TOKEN'],
  })
  const request = db.transaction((tx) => {
    const tdb = tx as unknown as Db

    tdb
      .insert(run)
      .values({
        ...runRow,
        exec: {
          ...runRow.exec,
          timeout_s: shipTimeoutS,
        },
      })
      .run()

    if (held?.status === 'pending' || held?.status === 'failed') {
      tdb
        .update(ship_request)
        .set({
          status: 'pushing',
          run_id: id,
          reason: null,
          requested_by: requestedBy,
        })
        .where(eq(ship_request.id, held.id))
        .run()

      return tdb.select().from(ship_request).where(eq(ship_request.id, held.id)).get()!
    }

    const shipId = newId('ship_request')

    tdb
      .insert(ship_request)
      .values({
        id: shipId,
        task_id: row.id,
        project_id: row.project_id,
        status: 'pushing',
        requested_by: requestedBy,
        run_id: id,
      })
      .run()

    return tdb.select().from(ship_request).where(eq(ship_request.id, shipId)).get()!
  })

  deps.reconcile(box!.station_id)
  shipChanged(db, row, request, 'ship.pushing')

  return request
}

const pullRequestBody = (row: TaskRow, dashboardOrigin: string) =>
  [`Work from the Stationly task "${row.title}".`, '', `Task: ${dashboardOrigin}/#build/${row.id}`]
    .join('\n')
    .trim()

const linkPreview = (db: Db, row: TaskRow, repo: string, number: number) => {
  if (!row.preview_environment_id) {
    return
  }

  db.update(environment)
    .set({
      pull_request: {
        repo,
        number,
        head_sha: '',
        fork: false,
      },
    })
    .where(eq(environment.id, row.preview_environment_id))
    .run()

  const proj = db.select().from(project).where(eq(project.id, row.project_id)).get()!
  const originals = db
    .select()
    .from(service)
    .where(eq(service.environment_id, proj.default_environment_id))
    .all()
    .filter((entry) => (entry.source as RepoSource).repo === repo)

  for (const entry of db
    .select()
    .from(service)
    .where(eq(service.environment_id, row.preview_environment_id))
    .all()) {
    const original = originals.find((candidate) => candidate.name === entry.name)

    if (original) {
      db.update(service)
        .set({
          source: {
            ...(original.source as object),
            branch: row.branch,
          },
        })
        .where(eq(service.id, entry.id))
        .run()
    }
  }
}

const settle = (db: Db, row: TaskRow, request: ShipRow, next: Partial<ShipRow>, type: string) => {
  db.update(ship_request).set(next).where(eq(ship_request.id, request.id)).run()
  shipChanged(
    db,
    row,
    db.select().from(ship_request).where(eq(ship_request.id, request.id)).get()!,
    type,
  )
}

export const advanceShips = async (deps: { db: Db; github: GitHub; dashboardOrigin: string }) => {
  const { db } = deps
  const pushing = db
    .select({
      request: ship_request,
      row: task,
      status: run.status,
    })
    .from(ship_request)
    .innerJoin(task, eq(task.id, ship_request.task_id))
    .leftJoin(run, eq(run.id, ship_request.run_id))
    .where(eq(ship_request.status, 'pushing'))
    .all()
    .filter(
      ({ request, status }) =>
        status === null ||
        finished.includes(status) ||
        Date.now() - request.updated_at.getTime() > (shipTimeoutS + shipGraceS) * 1000,
    )

  for (const { request, row, status } of pushing) {
    if (status !== 'succeeded') {
      settle(
        db,
        row,
        request,
        {
          status: 'failed',
          reason: `The push did not finish; its log is on run ${request.run_id}.`,
        },
        'ship.failed',
      )
      continue
    }

    const repo = repoOfTask(row)

    try {
      const pull = await deps.github.openPullRequest(repo, {
        branch: row.branch,
        title: row.title,
        body: pullRequestBody(row, deps.dashboardOrigin),
      })

      db.update(task)
        .set({
          pull_request: {
            repo,
            number: pull.number,
            url: pull.url,
          },
        })
        .where(eq(task.id, row.id))
        .run()
      linkPreview(db, row, repo, pull.number)
      settle(
        db,
        row,
        request,
        {
          status: 'pending',
          head_sha: pull.head_sha,
          reason: null,
        },
        'ship.requested',
      )
    } catch (error) {
      settle(
        db,
        row,
        request,
        {
          status: 'failed',
          reason: `GitHub refused the pull request: ${error instanceof Error ? error.message : String(error)}`,
        },
        'ship.failed',
      )
    }
  }
}

export const decideShip = async (
  deps: { db: Db; github: GitHub },
  request: ShipRow,
  decision: { approve: boolean; reason: string | null },
  decidedBy: string,
) => {
  const { db } = deps
  const row = db.select().from(task).where(eq(task.id, request.task_id)).get()!

  if (
    request.status !== 'pending' ||
    !row.pull_request ||
    !request.head_sha ||
    deciding.has(request.id)
  ) {
    fail(
      'APPROVAL_CLOSED',
      `This ship request is ${request.status}, not waiting for a decision.`,
      'Ship the task again to ask anew.',
    )
  }

  if (!decision.approve) {
    settle(
      db,
      row,
      request,
      {
        status: 'rejected',
        reason: decision.reason,
        decided_by: decidedBy,
        decided_at: new Date(),
      },
      'ship.decided',
    )

    return
  }

  deciding.add(request.id)

  try {
    await deps.github.mergePullRequest(
      row.pull_request!.repo,
      row.pull_request!.number,
      request.head_sha!,
    )
    settle(
      db,
      row,
      request,
      {
        status: 'merged',
        reason: null,
        decided_by: decidedBy,
        decided_at: new Date(),
      },
      'ship.decided',
    )
  } catch (error) {
    settle(
      db,
      row,
      request,
      {
        reason:
          error instanceof GitHubError && error.status === 409
            ? 'The branch moved after this request was made, so it was not merged. Ship again to ask with the new commits.'
            : `GitHub refused the merge: ${error instanceof Error ? error.message : String(error)}`,
      },
      'ship.refused',
    )
  } finally {
    deciding.delete(request.id)
  }
}

export const startShipAdvance = (
  deps: { db: Db; github: GitHub; dashboardOrigin: string },
  log: Log,
) => every(3, 'task.ship_advance_failed', log, () => advanceShips(deps))
