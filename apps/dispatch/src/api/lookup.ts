import { and, eq } from 'drizzle-orm'

import { anyTarget, type Target } from '../auth/scopes.ts'
import type { Db } from '../db/client.ts'
import {
  build,
  deployment,
  domain,
  environment,
  port_allocation,
  project,
  run,
  sandbox,
  sandbox_snapshot,
  secret_value,
  service,
  service_port,
  staged_change,
  station,
  variable,
  volume,
} from '../db/schema.ts'

import { notFound } from './errors.ts'

export type ProjectRow = typeof project.$inferSelect
export type EnvironmentRow = typeof environment.$inferSelect
export type ServiceRow = typeof service.$inferSelect
export type PortRow = typeof service_port.$inferSelect
export type VolumeRow = typeof volume.$inferSelect
export type DomainRow = typeof domain.$inferSelect
export type AllocationRow = typeof port_allocation.$inferSelect
export type DeploymentRow = typeof deployment.$inferSelect
export type VariableRow = typeof variable.$inferSelect
export type StagedRow = typeof staged_change.$inferSelect
export type StationRow = typeof station.$inferSelect
export type SandboxRow = typeof sandbox.$inferSelect
export type SandboxSnapshotRow = typeof sandbox_snapshot.$inferSelect

export type ServiceContext = {
  service: ServiceRow
  environment: EnvironmentRow
  project: ProjectRow
  target: Target
}

export const projectByRef = (db: Db, ref: string) => {
  const row = db
    .select()
    .from(project)
    .where(ref.startsWith('prj_') ? eq(project.id, ref) : eq(project.name, ref))
    .get()

  return row ?? notFound('project', ref)
}

export const projectContext = (db: Db, ref: string) => {
  const row = projectByRef(db, ref)

  return {
    project: row,
    target: {
      project_id: row.id,
      environment_id: '*',
    },
  }
}

export const environmentById = (db: Db, id: string) => {
  const row =
    db.select().from(environment).where(eq(environment.id, id)).get() ?? notFound('environment', id)
  const proj = db.select().from(project).where(eq(project.id, row.project_id)).get()!

  return {
    environment: row,
    project: proj,
    target: {
      project_id: proj.id,
      environment_id: row.id,
    },
  }
}

export const environmentInProject = (db: Db, proj: ProjectRow, ref: string) => {
  const row =
    db
      .select()
      .from(environment)
      .where(
        and(
          eq(environment.project_id, proj.id),
          ref.startsWith('env_') ? eq(environment.id, ref) : eq(environment.name, ref),
        ),
      )
      .get() ?? notFound('environment', ref)

  return row
}

export const serviceById = (db: Db, id: string): ServiceContext => {
  const row = db.select().from(service).where(eq(service.id, id)).get() ?? notFound('service', id)
  const ctx = environmentById(db, row.environment_id)

  return {
    service: row,
    environment: ctx.environment,
    project: ctx.project,
    target: ctx.target,
  }
}

export const serviceInEnvironment = (db: Db, environmentId: string, ref: string) =>
  db
    .select()
    .from(service)
    .where(
      and(
        eq(service.environment_id, environmentId),
        ref.startsWith('svc_') ? eq(service.id, ref) : eq(service.name, ref),
      ),
    )
    .get()

export const portById = (db: Db, id: string) => {
  const row =
    db.select().from(service_port).where(eq(service_port.id, id)).get() ?? notFound('port', id)

  return {
    port: row,
    ...serviceById(db, row.service_id),
  }
}

export const volumeById = (db: Db, id: string) => {
  const row = db.select().from(volume).where(eq(volume.id, id)).get() ?? notFound('volume', id)
  const owner = row.service_id ? serviceById(db, row.service_id) : null

  return {
    volume: row,
    owner,
    target:
      owner?.target ??
      (row.project_id
        ? {
            project_id: row.project_id,
            environment_id: '*',
          }
        : anyTarget),
  }
}

export const domainById = (db: Db, id: string) => {
  const row = db.select().from(domain).where(eq(domain.id, id)).get() ?? notFound('domain', id)

  return {
    domain: row,
    ...portById(db, row.service_port_id),
  }
}

export const allocationById = (db: Db, id: string) => {
  const row =
    db.select().from(port_allocation).where(eq(port_allocation.id, id)).get() ??
    notFound('port_allocation', id)

  return {
    allocation: row,
    ...portById(db, row.service_port_id),
  }
}

export const deploymentById = (db: Db, id: string) => {
  const row =
    db.select().from(deployment).where(eq(deployment.id, id)).get() ?? notFound('deployment', id)

  return {
    deployment: row,
    ...serviceById(db, row.service_id),
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
    .from(station)
    .where(ref.startsWith('stn_') ? eq(station.id, ref) : eq(station.name, ref))
    .get() ?? notFound('station', ref)

export type SandboxContext = {
  sandbox: SandboxRow
  environment: EnvironmentRow
  project: ProjectRow
  target: Target
}

const sandboxContext = (db: Db, row: SandboxRow): SandboxContext => {
  const env = db.select().from(environment).where(eq(environment.id, row.environment_id)).get()

  if (!env) {
    return notFound('sandbox', row.id)
  }

  const proj = db.select().from(project).where(eq(project.id, env.project_id)).get()!

  return {
    sandbox: row,
    environment: env,
    project: proj,
    target: {
      project_id: proj.id,
      environment_id: env.id,
    },
  }
}

export const sandboxById = (db: Db, id: string): SandboxContext => {
  const row = db.select().from(sandbox).where(eq(sandbox.id, id)).get() ?? notFound('sandbox', id)

  return sandboxContext(db, row)
}

export const sandboxInEnvironment = (db: Db, environmentId: string, ref: string) =>
  db
    .select()
    .from(sandbox)
    .where(
      and(
        eq(sandbox.environment_id, environmentId),
        ref.startsWith('sbx_') ? eq(sandbox.id, ref) : eq(sandbox.name, ref),
      ),
    )
    .get()

export type SnapshotContext = {
  snapshot: SandboxSnapshotRow
  environment: EnvironmentRow
  project: ProjectRow
  target: Target
}

export const snapshotById = (db: Db, id: string): SnapshotContext => {
  const row =
    db.select().from(sandbox_snapshot).where(eq(sandbox_snapshot.id, id)).get() ??
    notFound('sandbox_snapshot', id)
  const env = db.select().from(environment).where(eq(environment.id, row.environment_id)).get()

  if (!env) {
    return notFound('sandbox_snapshot', id)
  }

  const proj = db.select().from(project).where(eq(project.id, env.project_id)).get()!

  return {
    snapshot: row,
    environment: env,
    project: proj,
    target: {
      project_id: proj.id,
      environment_id: env.id,
    },
  }
}

export type RunOwner = { target: Target; environment: EnvironmentRow; station_id: string }

export const runOwner = (
  db: Db,
  r: { service_id: string | null; sandbox_id: string | null },
): RunOwner => {
  if (r.sandbox_id) {
    const ctx = sandboxById(db, r.sandbox_id)

    return {
      target: ctx.target,
      environment: ctx.environment,
      station_id: ctx.sandbox.station_id,
    }
  }

  const ctx = serviceById(db, r.service_id!)

  return {
    target: ctx.target,
    environment: ctx.environment,
    station_id: ctx.service.station_id,
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
  if (row.scope === 'service') {
    return serviceById(db, row.service_id!).target
  }

  if (row.scope === 'sandbox') {
    return sandboxById(db, row.sandbox_id!).target
  }

  if (row.scope === 'project') {
    return {
      project_id: row.project_id!,
      environment_id: '*',
    }
  }

  return anyTarget
}

export const variableById = (db: Db, id: string) => {
  const row =
    db.select().from(variable).where(eq(variable.id, id)).get() ?? notFound('variable', id)

  return {
    variable: row,
    target: variableTarget(db, row),
  }
}

export const secretValueById = (db: Db, id: string) => {
  const row =
    db.select().from(secret_value).where(eq(secret_value.id, id)).get() ??
    notFound('secret_value', id)
  const owner = variableById(db, row.variable_id)
  const target =
    row.environment_id && owner.variable.scope === 'project'
      ? {
          project_id: owner.variable.project_id!,
          environment_id: row.environment_id,
        }
      : owner.target

  return {
    secretValue: row,
    variable: owner.variable,
    target,
  }
}

export const stagedById = (db: Db, id: string) => {
  const row =
    db.select().from(staged_change).where(eq(staged_change.id, id)).get() ??
    notFound('staged_change', id)
  const live = row.environment_id
    ? db
        .select({
          id: environment.id,
        })
        .from(environment)
        .where(eq(environment.id, row.environment_id))
        .get()
    : undefined
  const env = live ? environmentById(db, live.id) : null

  return {
    staged: row,
    environment: env,
    target: env?.target ?? anyTarget,
  }
}

export const targets = {
  project: projectContext,
  environment: environmentById,
  service: serviceById,
  service_port: portById,
  domain: domainById,
  port_allocation: allocationById,
  deployment: deploymentById,
  build: buildById,
  run: runById,
  volume: volumeById,
  variable: variableById,
  secret_value: secretValueById,
  staged_change: stagedById,
  sandbox: sandboxById,
  sandbox_snapshot: snapshotById,
} satisfies Record<string, (db: Db, id: string) => { target: Target }>

export type TargetEntity = keyof typeof targets
