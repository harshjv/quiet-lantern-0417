import { and, desc, eq, sql } from 'drizzle-orm'

import { workspaceUser } from '@stationly/protocol'

import { approvalItem } from '../api/approval-view.ts'
import { recordDecision, rejectApproval, requireWaiting } from '../api/changes.ts'
import { emit, type Call } from '../api/context.ts'
import { fail } from '../api/errors.ts'
import { productionOf, type ApprovalRow } from '../api/lookup.ts'
import { requesterOf, requireRequesterRule } from '../api/requester.ts'
import type { Db } from '../db/client.ts'
import { newId } from '../db/ids.ts'
import {
  app,
  approval,
  machine,
  project,
  run,
  target,
  task,
  type ApprovalShip,
} from '../db/schema.ts'
import { GitHubError, repoOf } from '../github/client.ts'
import type { GitHub } from '../github/service.ts'
import type { Log } from '../log.ts'
import { isGitHubRepository, repositoryLabel } from '../sandboxes/repository-access.ts'
import { shipCommand } from '../sandboxes/workspace.ts'
import { every } from '../schedule.ts'
import { gitIdentityOf } from '../team/members.ts'

import { execRun, machineUserOf, type RunDelivery } from './machine.ts'
import { taskChanged, taskSubject, type TaskRow } from './status.ts'

type RepoSource = { repo?: string; branch?: string }

const shipTimeoutS = 600

const shipGraceS = 120

const finished: string[] = ['succeeded', 'failed', 'cancelled']

const deciding = new Set<string>()

const shipOf = (row: ApprovalRow) => row.ship!

const approvalRow = (db: Db, id: string) =>
  db.select().from(approval).where(eq(approval.id, id)).get()!

export const repoOfTask = (row: Pick<TaskRow, 'repository'>) =>
  repoOf(repositoryLabel(row.repository))

export const latestShip = (db: Db, taskId: string) =>
  db
    .select()
    .from(approval)
    .where(eq(approval.task_id, taskId))
    .orderBy(desc(approval.created_at))
    .get()

export const shipView = approvalItem

const shipChanged = (db: Db, row: TaskRow, request: ApprovalRow, type: string) => {
  emit(db, type, taskSubject(row), {
    approval: request.id,
    status: request.status,
    phase: request.ship?.phase ?? null,
  })
  taskChanged(db, row)
}

export const startShip = async (
  deps: { db: Db; github: GitHub; deliver: RunDelivery; reconcile: (station: string) => void },
  row: TaskRow,
  call: Call,
) => {
  const { db } = deps

  if (!isGitHubRepository(row.repository)) {
    fail(
      'VALIDATION_FAILED',
      `${row.repository} is not on GitHub, so Stationly cannot open a pull request for it.`,
      'Push the branch from the task by hand.',
    )
  }

  const box = db.select().from(machine).where(eq(machine.id, row.machine_id)).get()

  if (!box || box.status !== 'running' || !row.worktree) {
    fail(
      'MACHINE_NOT_RUNNING',
      `The machine of task ${row.title} is not running, so its work cannot be pushed.`,
      'Reply to the task to start its machine, then ship again.',
      {
        machine_id: row.machine_id,
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

  const latest = latestShip(db, row.id)
  const held = latest?.status === 'waiting' ? latest : undefined

  if (held?.ship?.phase === 'pushing') {
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

  await deps.deliver(box!.server_id, id, [['GITHUB_PUSH_TOKEN', token]])

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

    const asked = {
      requested_by: call.principal.actor,
      requester: requesterOf(call.principal),
    }

    if (held) {
      tdb
        .update(approval)
        .set({
          ...asked,
          ship: {
            ...shipOf(held),
            phase: 'pushing',
            run_id: id,
            reason: null,
          },
        })
        .where(eq(approval.id, held.id))
        .run()

      return approvalRow(tdb, held.id)
    }

    const proj = tdb.select().from(project).where(eq(project.id, row.project_id)).get()!
    const approvalId = newId('approval')

    tdb
      .insert(approval)
      .values({
        id: approvalId,
        ...asked,
        project_id: row.project_id,
        task_id: row.id,
        title: `Ship ${row.title}`,
        changes: [],
        refs: {},
        source: 'task',
        status: 'waiting',
        deployments: [],
        ship: {
          phase: 'pushing',
          run_id: id,
          pull_request: row.pull_request
            ? {
                repo: row.pull_request.repo,
                number: row.pull_request.number,
                url: row.pull_request.url,
              }
            : null,
          head_sha: null,
          merge_sha: null,
          reason: null,
        },
      })
      .run()
    emit(
      tdb,
      'approval.created',
      {
        entity: 'approval',
        id: approvalId,
        project_id: proj.id,
      },
      {
        task_id: row.id,
      },
    )

    return approvalRow(tdb, approvalId)
  })

  deps.reconcile(box!.server_id)
  shipChanged(db, row, request, 'ship.pushing')

  return request
}

const pullRequestBody = (row: TaskRow, dashboardOrigin: string) =>
  [`Work from the Stationly task "${row.title}".`, '', `Task: ${dashboardOrigin}/#build/${row.id}`]
    .join('\n')
    .trim()

const linkPreview = (db: Db, row: TaskRow, repo: string, number: number) => {
  if (!row.preview_id) {
    return
  }

  db.update(target)
    .set({
      origin: {
        type: 'pull_request',
        repo,
        number,
        head_sha: '',
        fork: false,
      },
    })
    .where(eq(target.id, row.preview_id))
    .run()

  const proj = db.select().from(project).where(eq(project.id, row.project_id)).get()!
  const originals = db
    .select()
    .from(app)
    .where(eq(app.target_id, productionOf(db, proj.id).id))
    .all()
    .filter((entry) => (entry.source as RepoSource).repo === repo)

  for (const entry of db.select().from(app).where(eq(app.target_id, row.preview_id)).all()) {
    const original = originals.find((candidate) => candidate.name === entry.name)

    if (original) {
      db.update(app)
        .set({
          source: {
            ...(original.source as object),
            branch: row.branch,
          },
        })
        .where(eq(app.id, entry.id))
        .run()
    }
  }
}

const settle = (
  db: Db,
  row: TaskRow,
  request: ApprovalRow,
  next: Partial<ApprovalShip>,
  type: string,
) => {
  db.update(approval)
    .set({
      ship: {
        ...shipOf(request),
        ...next,
      },
    })
    .where(eq(approval.id, request.id))
    .run()
  shipChanged(db, row, approvalRow(db, request.id), type)
}

export const advanceShips = async (deps: { db: Db; github: GitHub; dashboardOrigin: string }) => {
  const { db } = deps
  const pushing = db
    .select({
      request: approval,
      row: task,
    })
    .from(approval)
    .innerJoin(task, eq(task.id, approval.task_id))
    .where(
      and(
        eq(approval.status, 'waiting'),
        sql`json_extract(${approval.ship}, '$.phase') = 'pushing'`,
      ),
    )
    .all()
    .map(({ request, row }) => ({
      request,
      row,
      status:
        db
          .select({
            status: run.status,
          })
          .from(run)
          .where(eq(run.id, shipOf(request).run_id))
          .get()?.status ?? null,
    }))
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
          phase: 'failed',
          reason: `The push did not finish; its log is on run ${shipOf(request).run_id}.`,
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
          phase: 'open',
          pull_request: {
            repo,
            number: pull.number,
            url: pull.url,
          },
          head_sha: pull.head_sha,
          merge_sha: null,
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
          phase: 'failed',
          reason: `GitHub refused the pull request: ${error instanceof Error ? error.message : String(error)}`,
        },
        'ship.failed',
      )
    }
  }
}

export const decideShip = async (
  deps: { db: Db; github: GitHub },
  call: Call,
  request: ApprovalRow,
  decision: { approve: boolean; reason: string | null },
) => {
  const { db } = deps
  const row = db.select().from(task).where(eq(task.id, request.task_id!)).get()

  requireWaiting(request)

  const ship = shipOf(request)

  if (!row || !ship.pull_request || !ship.head_sha || deciding.has(request.id)) {
    fail(
      'APPROVAL_CLOSED',
      `Approval ${request.id} is not waiting for a decision.`,
      'Ship the task again to ask anew.',
    )
  }

  if (!decision.approve) {
    const rejected = rejectApproval(deps, call, request, decision.reason)

    shipChanged(db, row!, rejected, 'ship.decided')

    return rejected
  }

  const selfApproved = requireRequesterRule(db, request, call.principal)

  deciding.add(request.id)

  try {
    const mergeSha = await deps.github.mergePullRequest(
      ship.pull_request!.repo,
      ship.pull_request!.number,
      ship.head_sha!,
    )

    db.transaction((tx) => {
      const tdb = tx as unknown as Db

      tdb
        .update(approval)
        .set({
          status: 'approved',
          decided_by: call.principal.actor,
          decided_at: new Date(),
          self_approved: selfApproved,
          ship: {
            ...ship,
            phase: 'merged',
            merge_sha: mergeSha,
            reason: null,
          },
        })
        .where(eq(approval.id, request.id))
        .run()
      recordDecision(tdb, call, request, true, {
        self_approved: selfApproved,
      })
    })
    shipChanged(db, row!, approvalRow(db, request.id), 'ship.decided')
  } catch (error) {
    settle(
      db,
      row!,
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

  return approvalRow(db, request.id)
}

export const startShipAdvance = (
  deps: { db: Db; github: GitHub; dashboardOrigin: string },
  log: Log,
) => every(3, 'task.ship_advance_failed', log, () => advanceShips(deps))
