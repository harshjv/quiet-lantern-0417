import { eq, inArray } from 'drizzle-orm'

import { workspaceEnv, workspaceUser } from '@stationly/protocol'

import { mintToken } from '../../auth/tokens.ts'
import { newId } from '../../db/ids.ts'
import { app, app_port, domain, machine, project, run, task } from '../../db/schema.ts'
import { asMember } from '../../sandboxes/workspace.ts'
import { credentialExpiry } from '../../secrets/relay.ts'
import {
  deliveredRun,
  homeOf,
  machineUserOf,
  memberEnv,
  stationRunDelivery,
} from '../../tasks/machine.ts'
import { previewOf } from '../../tasks/preview.ts'
import type { TaskRow } from '../../tasks/status.ts'
import { ChangeSet, commit } from '../changes.ts'
import type { Call } from '../context.ts'
import { fail } from '../errors.ts'
import { generatedHostname } from '../exposure.ts'
import type { Kit } from '../kit.ts'
import { productionOf, type TargetRow } from '../lookup.ts'

import { createPreview } from './previews.ts'

const previewTokenSeconds = 3600

const previewRunTimeoutS = 1800

type RepoSource = { repo?: string; path?: string }

export const repoKey = (repository: string) =>
  repository
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')

const previewName = (row: TaskRow) =>
  `task-${row.branch.replace(/^task\//, '').slice(0, 40)}-${row.id.slice(-4).toLowerCase()}`

const addressPreview = (kit: Kit, call: Call, source: string, preview: TargetRow) => {
  const { db } = kit.deps
  const changes = new ChangeSet()
  const previewApps = db.select().from(app).where(eq(app.target_id, preview.id)).all()

  for (const original of db.select().from(app).where(eq(app.target_id, source)).all()) {
    const copy = previewApps.find((entry) => entry.name === original.name)
    const ports = db.select().from(app_port).where(eq(app_port.app_id, original.id)).all()
    const routed = ports.length
      ? db
          .select()
          .from(domain)
          .where(
            inArray(
              domain.app_port_id,
              ports.map((port) => port.id),
            ),
          )
          .all()
      : []

    if (!copy || !routed.length) {
      continue
    }

    const copyPorts = db.select().from(app_port).where(eq(app_port.app_id, copy.id)).all()

    for (const routedDomain of routed) {
      const port = ports.find((entry) => entry.id === routedDomain.app_port_id)
      const target_port = copyPorts.find((entry) => entry.port === port?.port)
      const hostname = generatedHostname(db, copy.name, preview.name)
      const taken = target_port
        ? db.select().from(domain).where(eq(domain.app_port_id, target_port.id)).get()
        : undefined

      if (target_port && hostname && !taken) {
        changes.add('domain', target_port.id, {
          hostname,
          kind: 'generated',
        })
      }
    }
  }

  commit(
    kit.deps,
    call,
    {
      target: preview,
      protect: false,
    },
    changes,
  )
}

export const ensurePreview = (kit: Kit, call: Call, row: TaskRow) => {
  const { db } = kit.deps
  const found = previewOf(db, row)

  if (found) {
    return found
  }

  const proj = db.select().from(project).where(eq(project.id, row.project_id)).get()!
  const created = createPreview(kit, call, proj, {
    name: previewName(row),
    origin: {
      type: 'task',
      task_id: row.id,
    },
    expires_at: null,
    deploy: false,
  }).preview

  addressPreview(kit, call, productionOf(db, proj.id).id, created)
  db.update(task)
    .set({
      preview_id: created.id,
    })
    .where(eq(task.id, row.id))
    .run()

  return created
}

export const deployPreview = async (kit: Kit, call: Call, row: TaskRow) => {
  const { db } = kit.deps
  const box = db.select().from(machine).where(eq(machine.id, row.machine_id)).get()

  if (!box?.workspace || box.status !== 'running') {
    fail(
      'MACHINE_NOT_RUNNING',
      `Task ${row.title} is not running, so its worktree cannot be deployed.`,
      'Reply to the task to start it, then make the preview again.',
      {
        machine_id: row.machine_id,
      },
    )
  }

  const wanted = repoKey(row.repository)
  const builtFrom = (entry: typeof app.$inferSelect) => {
    const source = entry.source as RepoSource

    return source.repo !== undefined && repoKey(source.repo) === wanted
  }
  const proj = db.select().from(project).where(eq(project.id, row.project_id)).get()!
  const originals = db
    .select()
    .from(app)
    .where(eq(app.target_id, productionOf(db, proj.id).id))
    .all()
    .filter(builtFrom)

  if (!originals.length) {
    fail(
      'NOT_FOUND',
      `No app of project ${proj.name} is built from ${row.repository}.`,
      'Add an app built from this repository to the project, then make the preview again.',
      {
        repository: row.repository,
      },
    )
  }

  const preview = ensurePreview(kit, call, row)
  const targets = db
    .select()
    .from(app)
    .where(eq(app.target_id, preview.id))
    .all()
    .filter((entry) => originals.some((original) => original.name === entry.name))

  for (const entry of targets) {
    const source = entry.source as RepoSource & { type: string; dockerfile?: string }

    if (source.type !== 'local') {
      db.update(app)
        .set({
          source: {
            type: 'local',
            ...(source.dockerfile
              ? {
                  dockerfile: source.dockerfile,
                }
              : {}),
          },
        })
        .where(eq(app.id, entry.id))
        .run()
    }
  }

  const member = machineUserOf(db, row)
  const user = member?.name ?? workspaceUser.name
  const home = member ? homeOf(member.name) : workspaceUser.home
  const worktree = row.worktree ?? box!.workspace!.path
  const owner = row.owner.id ?? call.principal.user_id
  const minted = await mintToken(kit.deps.auth, db, {
    userId: owner,
    name: `preview/${preview.name}`,
    kind: 'scoped',
    scopes: [
      {
        project_id: row.project_id,
        target: 'previews',
        preview_id: preview.id,
        level: 'deploy',
      },
    ],
    seconds: previewTokenSeconds,
    machineHeld: true,
  })
  const id = newId('run')
  const pushArgs = targets.flatMap((entry) => [
    entry.id,
    (originals.find((original) => original.name === entry.name)!.source as RepoSource).path || '.',
  ])
  const delivered = await deliveredRun(
    stationRunDelivery(kit.deps.stations),
    box!,
    id,
    member ? memberEnv(member) : [],
    [
      {
        key: workspaceEnv.token,
        value: minted.key,
        token_id: minted.row.id,
        expires_at: credentialExpiry(minted.row.expires_at, previewRunTimeoutS),
      },
    ],
  )

  const script = [
    'set -eu',
    'cd "$1"',
    'shift',
    'while [ "$#" -gt 1 ]; do sly push --app "$1" --wait "${2:-.}"; shift 2; done',
  ].join('\n')

  db.insert(run)
    .values({
      id,
      app_id: null,
      machine_id: box!.id,
      deployment_id: null,
      kind: 'exec',
      command: member
        ? asMember(member, ['bash', '-lc', script, 'task-preview', worktree, ...pushArgs])
        : ['bash', '-lc', script, 'task-preview', worktree, ...pushArgs],
      status: 'queued',
      log_ref: `logs/sandboxes/${box!.id}/${id}`,
      tty: false,
      actor: call.principal.actor,
      exec: {
        cwd: member ? '/root' : home,
        user: member ? 'root' : user,
        timeout_s: previewRunTimeoutS,
        stdin: null,
        env_keys: delivered.envKeys,
        attach: false,
        credentials: delivered.credentials,
      },
    })
    .run()
  kit.deps.stations.reconcile(box!.server_id)

  return {
    preview: {
      id: preview.id,
      name: preview.name,
    },
    run_id: id,
    apps: targets.map((entry) => entry.id),
  }
}

export const removePreview = (kit: Kit, call: Call, row: TaskRow) => {
  const preview = previewOf(kit.deps.db, row)

  if (!preview) {
    return
  }

  const changes = new ChangeSet()

  changes.remove('preview', preview.id, {
    id: preview.id,
    name: preview.name,
  })
  commit(
    kit.deps,
    call,
    {
      target: preview,
      protect: false,
    },
    changes,
  )
  kit.deps.stations.reconcile()
}
