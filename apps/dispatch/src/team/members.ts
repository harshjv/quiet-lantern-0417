import { and, eq, isNotNull, sql } from 'drizzle-orm'

import { atLeast, fullAdmin, type Level, type Scope } from '../auth/scopes.ts'
import type { Db } from '../db/client.ts'
import { member, project_member, sandbox, task, user } from '../db/schema.ts'

export const memberLevel: Level = 'read'

export const memberOf = (db: Db, userId: string) =>
  db.select().from(member).where(eq(member.user_id, userId)).get()

export const projectsOf = (db: Db, userId: string) =>
  db
    .select({
      project_id: project_member.project_id,
    })
    .from(project_member)
    .where(eq(project_member.user_id, userId))
    .all()
    .map((row) => row.project_id)

export const userScopes = (db: Db, userId: string | null): Scope[] => {
  if (!userId) {
    return []
  }

  const row = memberOf(db, userId)

  if (!row || row.removed_at) {
    return []
  }

  if (row.role === 'admin') {
    return fullAdmin
  }

  const projects = projectsOf(db, userId)
  const previews = db
    .select({
      project_id: task.project_id,
      environment_id: task.preview_environment_id,
    })
    .from(task)
    .where(
      and(
        isNotNull(task.preview_environment_id),
        sql`json_extract(${task.owner}, '$.id') = ${userId}`,
      ),
    )
    .all()
    .filter((row) => projects.includes(row.project_id))

  return [
    ...projects.map((projectId) => ({
      project_id: projectId,
      environment_id: '*',
      level: memberLevel,
    })),
    ...previews.map((row) => ({
      project_id: row.project_id,
      environment_id: row.environment_id!,
      level: 'deploy' as const,
    })),
  ]
}

const lower = (a: Level, b: Level) => (atLeast(a, b) ? b : a)

export const capScopes = (scopes: Scope[], held: Scope[]): Scope[] =>
  scopes.flatMap((scope) =>
    held.flatMap((grant) => {
      const project =
        scope.project_id === '*'
          ? grant.project_id
          : grant.project_id === '*'
            ? scope.project_id
            : null
      const environment =
        scope.environment_id === '*'
          ? grant.environment_id
          : grant.environment_id === '*'
            ? scope.environment_id
            : null

      if (
        (project === null && scope.project_id !== grant.project_id) ||
        (environment === null && scope.environment_id !== grant.environment_id)
      ) {
        return []
      }

      return [
        {
          project_id: project ?? scope.project_id,
          environment_id: environment ?? scope.environment_id,
          level: lower(scope.level, grant.level),
        },
      ]
    }),
  )

export const inTeam = (db: Db, userId: string) => {
  const row = memberOf(db, userId)

  return row ? !row.removed_at : !db.select().from(member).limit(1).get()
}

export const projectMachineToken = (db: Db, tokenId: string | null) =>
  !!tokenId &&
  db
    .select({
      id: sandbox.id,
    })
    .from(sandbox)
    .where(
      and(
        sql`json_extract(${sandbox.workspace}, '$.token_id') = ${tokenId}`,
        sql`json_extract(${sandbox.workspace}, '$.kind') = 'project'`,
      ),
    )
    .get() !== undefined

export const ensureFirstAdmins = (db: Db, now = new Date()) => {
  if (db.select().from(member).limit(1).get()) {
    return
  }

  for (const row of db
    .select({
      id: user.id,
    })
    .from(user)
    .all()) {
    db.insert(member)
      .values({
        user_id: row.id,
        role: 'admin',
        joined_by: null,
        created_at: now,
      })
      .onConflictDoNothing()
      .run()
  }
}

export const gitIdentityOf = (db: Db, userId: string | null) => {
  const person = userId ? db.select().from(user).where(eq(user.id, userId)).get() : undefined

  return person
    ? {
        name: person.name || person.email,
        email: person.email,
      }
    : null
}
