import { eq, inArray } from 'drizzle-orm'

import { workspaceUser } from '@stationly/protocol'

import { mintToken } from '../../auth/tokens.ts'
import { newId } from '../../db/ids.ts'
import {
  domain,
  environment,
  project,
  run,
  sandbox,
  service,
  service_port,
  task,
} from '../../db/schema.ts'
import { asMember } from '../../sandboxes/workspace.ts'
import { ephemeralDelivery } from '../../secrets/deliver.ts'
import { homeOf, machineUserOf } from '../../tasks/machine.ts'
import { previewOf } from '../../tasks/preview.ts'
import type { TaskRow } from '../../tasks/status.ts'
import { ChangeSet, commit } from '../changes.ts'
import type { Call } from '../context.ts'
import { fail } from '../errors.ts'
import { generatedHostname } from '../exposure.ts'
import type { Kit } from '../kit.ts'

import { cloneInto } from './environments.ts'

const previewTtlSeconds = 7 * 24 * 3600
const previewTokenSeconds = 3600

type RepoSource = { repo?: string; path?: string }

export const repoKey = (repository: string) =>
  repository
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')

const previewName = (row: TaskRow) =>
  `task-${row.branch.replace(/^task\//, '').slice(0, 40)}-${row.id.slice(-4).toLowerCase()}`

const addressPreview = (
  kit: Kit,
  call: Call,
  source: string,
  target: typeof environment.$inferSelect,
) => {
  const { db } = kit.deps
  const changes = new ChangeSet()
  const previewServices = db
    .select()
    .from(service)
    .where(eq(service.environment_id, target.id))
    .all()

  for (const original of db
    .select()
    .from(service)
    .where(eq(service.environment_id, source))
    .all()) {
    const copy = previewServices.find((entry) => entry.name === original.name)
    const ports = db
      .select()
      .from(service_port)
      .where(eq(service_port.service_id, original.id))
      .all()
    const routed = ports.length
      ? db
          .select()
          .from(domain)
          .where(
            inArray(
              domain.service_port_id,
              ports.map((port) => port.id),
            ),
          )
          .all()
      : []

    if (!copy || !routed.length) {
      continue
    }

    const copyPorts = db
      .select()
      .from(service_port)
      .where(eq(service_port.service_id, copy.id))
      .all()

    for (const routedDomain of routed) {
      const port = ports.find((entry) => entry.id === routedDomain.service_port_id)
      const target_port = copyPorts.find((entry) => entry.port === port?.port)
      const hostname = generatedHostname(db, copy.name, target.name, copy.station_id)
      const taken = target_port
        ? db.select().from(domain).where(eq(domain.service_port_id, target_port.id)).get()
        : undefined

      if (target_port && hostname && !taken) {
        changes.add('domain', target_port.id, {
          hostname,
          kind: 'generated',
          ingress: routedDomain.ingress,
        })
      }
    }
  }

  commit(
    kit.deps,
    call,
    {
      environment: target,
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
  const source = db
    .select()
    .from(environment)
    .where(eq(environment.id, proj.default_environment_id))
    .get()!
  const id = newId('environment')

  db.insert(environment)
    .values({
      id,
      project_id: proj.id,
      name: previewName(row),
      protected: false,
      ephemeral: true,
      source_environment_id: source.id,
      ttl_seconds: previewTtlSeconds,
      pull_request: null,
    })
    .run()

  const created = db.select().from(environment).where(eq(environment.id, id)).get()!

  cloneInto(kit, call, proj, source, created, false)
  addressPreview(kit, call, source.id, created)
  db.update(task)
    .set({
      preview_environment_id: id,
    })
    .where(eq(task.id, row.id))
    .run()

  return created
}

export const deployPreview = async (kit: Kit, call: Call, row: TaskRow) => {
  const { db } = kit.deps
  const box = db.select().from(sandbox).where(eq(sandbox.id, row.sandbox_id)).get()

  if (!box?.workspace || box.status !== 'running') {
    fail(
      'SANDBOX_NOT_RUNNING',
      `The machine of task ${row.title} is not running, so its worktree cannot be deployed.`,
      'Reply to the task to start its machine, then make the preview again.',
      {
        sandbox_id: row.sandbox_id,
      },
    )
  }

  const wanted = repoKey(row.repository)
  const builtFrom = (entry: typeof service.$inferSelect) => {
    const source = entry.source as RepoSource

    return source.repo !== undefined && repoKey(source.repo) === wanted
  }
  const proj = db.select().from(project).where(eq(project.id, row.project_id)).get()!

  if (
    !db
      .select()
      .from(service)
      .where(eq(service.environment_id, proj.default_environment_id))
      .all()
      .some(builtFrom)
  ) {
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
    .from(service)
    .where(eq(service.environment_id, preview.id))
    .all()
    .filter(builtFrom)

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
        environment_id: preview.id,
        level: 'deploy',
      },
    ],
    seconds: previewTokenSeconds,
  })
  const id = newId('run')
  const pushArgs = targets.flatMap((entry) => [entry.id, (entry.source as RepoSource).path || '.'])
  const entries: [string, string][] = [
    ['STATIONLY_TOKEN', minted.key],
    ...(member ? ([['STATIONLY_MEMBER', member.name]] as [string, string][]) : []),
  ]

  await kit.deps.stations.ask(
    box!.station_id,
    'secrets.deliver',
    ephemeralDelivery(
      {
        run_id: id,
      },
      'run',
      entries,
    ),
  )

  const script = [
    'set -eu',
    'cd "$1"',
    'shift',
    'while [ "$#" -gt 1 ]; do sly push --service "$1" --wait "${2:-.}"; shift 2; done',
  ].join('\n')

  db.insert(run)
    .values({
      id,
      service_id: null,
      sandbox_id: box!.id,
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
        timeout_s: 1800,
        stdin: null,
        env_keys: entries.map(([key]) => key).sort(),
        attach: false,
      },
    })
    .run()
  kit.deps.stations.reconcile(box!.station_id)

  return {
    environment: {
      id: preview.id,
      name: preview.name,
    },
    run_id: id,
    services: targets.map((entry) => entry.id),
  }
}

export const removePreview = (kit: Kit, call: Call, row: TaskRow) => {
  const preview = previewOf(kit.deps.db, row)

  if (!preview) {
    return
  }

  const changes = new ChangeSet()

  changes.remove('environment', preview.id, {
    id: preview.id,
    name: preview.name,
  })
  commit(
    kit.deps,
    call,
    {
      environment: preview,
      protect: false,
    },
    changes,
  )
  kit.deps.stations.reconcile()
}
