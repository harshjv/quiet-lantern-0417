import { and, eq, isNull, or, sql } from 'drizzle-orm'

import type { Principal } from '../auth/principal.ts'
import { anyTarget, type Target } from '../auth/scopes.ts'
import type { Db } from '../db/client.ts'
import {
  app,
  app_port,
  approval,
  build,
  deployment,
  domain,
  environment_variable,
  machine,
  project,
  run,
  secret_value,
  server,
  target,
  task,
  volume,
} from '../db/schema.ts'

import { seesTask } from './access.ts'
import { notFound } from './errors.ts'

export type ProjectRow = typeof project.$inferSelect
export type TargetRow = typeof target.$inferSelect
export type AppRow = typeof app.$inferSelect
export type PortRow = typeof app_port.$inferSelect
export type VolumeRow = typeof volume.$inferSelect
export type DomainRow = typeof domain.$inferSelect
export type DeploymentRow = typeof deployment.$inferSelect
export type VariableRow = typeof environment_variable.$inferSelect
export type ApprovalRow = typeof approval.$inferSelect

export const decidable = () =>
  and(
    eq(approval.status, 'waiting'),
    or(isNull(approval.ship), sql`json_extract(${approval.ship}, '$.phase') = 'open'`),
  )
export type StationRow = typeof server.$inferSelect
export type MachineRow = typeof machine.$inferSelect

export type AppContext = {
  app: AppRow
  target_row: TargetRow
  project: ProjectRow
  target: Target
}

const isProjectId = (ref: string) => ref.startsWith('prj_')

export const projectByRef = (db: Db, ref: string) => {
  const row = db
    .select()
    .from(project)
    .where(isProjectId(ref) ? eq(project.id, ref) : eq(project.name, ref))
    .get()

  return row ?? notFound('project', ref)
}

export const projectIdByRef = (db: Db, ref: string) =>
  isProjectId(ref) ? ref : projectByRef(db, ref).id

export const projectTarget = (projectId: string): Target => ({
  project_id: projectId,
  target: '*',
})

export const scopeOf = (row: TargetRow): Target =>
  row.kind === 'production'
    ? {
        project_id: row.project_id,
        target: 'production',
      }
    : {
        project_id: row.project_id,
        target: 'previews',
        preview_id: row.id,
      }

export const isProduction = (row: TargetRow) => row.kind === 'production'

export const placeName = (row: TargetRow) =>
  row.kind === 'production' ? 'production' : `preview ${row.name}`

export const previewIdOf = (row: TargetRow) => (row.kind === 'preview' ? row.id : null)

export const projectContext = (db: Db, ref: string) => {
  const row = projectByRef(db, ref)

  return {
    project: row,
    target: projectTarget(row.id),
  }
}

export const productionOf = (db: Db, projectId: string) =>
  db
    .select()
    .from(target)
    .where(and(eq(target.project_id, projectId), eq(target.kind, 'production')))
    .get()!

export const targetById = (db: Db, id: string) => {
  const row = db.select().from(target).where(eq(target.id, id)).get() ?? notFound('preview', id)
  const proj = db.select().from(project).where(eq(project.id, row.project_id)).get()!

  return {
    target_row: row,
    project: proj,
    target: scopeOf(row),
  }
}

export const previewById = (db: Db, id: string) => {
  const ctx = targetById(db, id)

  return ctx.target_row.kind === 'preview' ? ctx : notFound('preview', id)
}

export const previewInProject = (db: Db, proj: ProjectRow, ref: string) =>
  db
    .select()
    .from(target)
    .where(
      and(
        eq(target.project_id, proj.id),
        eq(target.kind, 'preview'),
        ref.startsWith('env_') ? eq(target.id, ref) : eq(target.name, ref),
      ),
    )
    .get() ?? notFound('preview', ref)

export const targetInProject = (db: Db, proj: ProjectRow, preview: string | undefined | null) =>
  preview ? previewInProject(db, proj, preview) : productionOf(db, proj.id)

export const placeContext = (db: Db, projectRef: string, preview: string | undefined | null) => {
  const proj = projectByRef(db, projectRef)
  const row = targetInProject(db, proj, preview)

  return {
    target_row: row,
    project: proj,
    target: scopeOf(row),
  }
}

export const appById = (db: Db, id: string): AppContext => {
  const row = db.select().from(app).where(eq(app.id, id)).get() ?? notFound('app', id)
  const ctx = targetById(db, row.target_id)

  return {
    app: row,
    target_row: ctx.target_row,
    project: ctx.project,
    target: ctx.target,
  }
}

export const appInTarget = (db: Db, targetId: string, ref: string) =>
  db
    .select()
    .from(app)
    .where(
      and(
        eq(app.target_id, targetId),
        ref.startsWith('svc_') ? eq(app.id, ref) : eq(app.name, ref),
      ),
    )
    .get()

export const portById = (db: Db, id: string) => {
  const row = db.select().from(app_port).where(eq(app_port.id, id)).get() ?? notFound('port', id)

  return {
    port: row,
    ...appById(db, row.app_id),
  }
}

export const volumeById = (db: Db, id: string) => {
  const row = db.select().from(volume).where(eq(volume.id, id)).get() ?? notFound('volume', id)
  const owner = row.app_id ? appById(db, row.app_id) : null

  return {
    volume: row,
    owner,
    target: owner?.target ?? (row.project_id ? projectTarget(row.project_id) : anyTarget),
  }
}

export const domainById = (db: Db, id: string) => {
  const row = db.select().from(domain).where(eq(domain.id, id)).get() ?? notFound('domain', id)

  return {
    domain: row,
    ...portById(db, row.app_port_id),
  }
}

export const deploymentById = (db: Db, id: string) => {
  const row =
    db.select().from(deployment).where(eq(deployment.id, id)).get() ?? notFound('deployment', id)

  return {
    deployment: row,
    ...appById(db, row.app_id),
  }
}

export const buildById = (db: Db, id: string) => {
  const row = db.select().from(build).where(eq(build.id, id)).get() ?? notFound('build', id)

  return {
    build: row,
    ...deploymentById(db, row.deployment_id),
  }
}

export const stationByRef = (db: Db, ref: string) =>
  db
    .select()
    .from(server)
    .where(ref.startsWith('stn_') ? eq(server.id, ref) : eq(server.name, ref))
    .get() ?? notFound('server', ref)

export type MachineContext = {
  machine: MachineRow
  target_row: TargetRow
  project: ProjectRow
  target: Target
}

const machineContext = (db: Db, row: MachineRow): MachineContext => {
  const env = db.select().from(target).where(eq(target.id, row.target_id)).get()

  if (!env) {
    return notFound('machine', row.id)
  }

  const proj = db.select().from(project).where(eq(project.id, env.project_id)).get()!

  return {
    machine: row,
    target_row: env,
    project: proj,
    target: scopeOf(env),
  }
}

export const machineById = (db: Db, id: string): MachineContext => {
  const row = db.select().from(machine).where(eq(machine.id, id)).get() ?? notFound('machine', id)

  return machineContext(db, row)
}

export const machineInTarget = (db: Db, targetId: string, ref: string) =>
  db
    .select()
    .from(machine)
    .where(
      and(
        eq(machine.target_id, targetId),
        ref.startsWith('sbx_') ? eq(machine.id, ref) : eq(machine.name, ref),
      ),
    )
    .get()

export type RunOwner = { target: Target; target_row: TargetRow; server_id: string }

export const runOwner = (
  db: Db,
  r: { app_id: string | null; machine_id: string | null },
): RunOwner => {
  if (r.machine_id) {
    const ctx = machineById(db, r.machine_id)

    return {
      target: ctx.target,
      target_row: ctx.target_row,
      server_id: ctx.machine.server_id,
    }
  }

  const ctx = appById(db, r.app_id!)

  return {
    target: ctx.target,
    target_row: ctx.target_row,
    server_id: ctx.app.server_id,
  }
}

export const runById = (db: Db, id: string) => {
  const row = db.select().from(run).where(eq(run.id, id)).get() ?? notFound('run', id)

  return {
    run: row,
    ...runOwner(db, row),
  }
}

export const variableTarget = (db: Db, row: VariableRow): Target => {
  if (row.scope === 'app') {
    return appById(db, row.app_id!).target
  }

  if (row.scope === 'machine') {
    return machineById(db, row.machine_id!).target
  }

  if (row.scope === 'project') {
    return projectTarget(row.project_id!)
  }

  return anyTarget
}

export const variableById = (db: Db, id: string) => {
  const row =
    db.select().from(environment_variable).where(eq(environment_variable.id, id)).get() ??
    notFound('environment variable', id)

  return {
    variable: row,
    target: variableTarget(db, row),
  }
}

export const secretValueById = (db: Db, id: string) => {
  const row =
    db.select().from(secret_value).where(eq(secret_value.id, id)).get() ??
    notFound('secret_value', id)
  const owner = variableById(db, row.environment_variable_id)

  return {
    secretValue: row,
    variable: owner.variable,
    target: owner.target,
  }
}

export const approvalById = (db: Db, id: string) => {
  const row =
    db.select().from(approval).where(eq(approval.id, id)).get() ?? notFound('approval', id)
  const production = row.project_id
    ? db
        .select()
        .from(target)
        .where(and(eq(target.project_id, row.project_id), eq(target.kind, 'production')))
        .get()
    : undefined

  return {
    approval: row,
    production: production ?? null,
    target: production ? scopeOf(production) : anyTarget,
  }
}

export const targets = {
  project: projectContext,
  preview: previewById,
  app: appById,
  app_port: portById,
  domain: domainById,
  deployment: deploymentById,
  build: buildById,
  run: runById,
  volume: volumeById,
  environment_variable: variableById,
  secret_value: secretValueById,
  approval: approvalById,
  machine: machineById,
} satisfies Record<string, (db: Db, id: string) => { target: Target }>

export type TargetEntity = keyof typeof targets

export const taskById = (db: Db, id: string) =>
  db.select().from(task).where(eq(task.id, id)).get() ?? notFound('task', id)

export const visibleTask = (db: Db, principal: Principal, id: string) => {
  const row = taskById(db, id)

  if (!seesTask(principal, row)) {
    notFound('task', id)
  }

  return row
}
