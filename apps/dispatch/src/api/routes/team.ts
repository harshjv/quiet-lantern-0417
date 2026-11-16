import { createHash, randomBytes } from 'node:crypto'

import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { t } from 'elysia'

import { fixedWindow, ipOf, rateLimited, type Principal } from '../../auth/principal.ts'
import { isInstanceAdmin } from '../../auth/scopes.ts'
import { newId } from '../../db/ids.ts'
import {
  account,
  github_app,
  invite,
  member,
  member_key,
  project,
  project_member,
  session,
  task,
  user,
} from '../../db/schema.ts'
import { gh } from '../../github/client.ts'
import { removeMachineUsers, stopTask } from '../../tasks/machine.ts'
import { addInput, latestConversation, runnerLive } from '../../tasks/runner.ts'
import {
  deleteKey,
  githubAccountOf,
  githubTokenOf,
  listKeys,
  memberKeyNames,
  setKey,
} from '../../team/keys.ts'
import { memberOf, projectsOf } from '../../team/members.ts'
import { requireHuman } from '../access.ts'
import { audit, type Call } from '../context.ts'
import { fail, invalid, notFound } from '../errors.ts'
import type { Kit } from '../kit.ts'
import {
  InviteCreated,
  InvitePage,
  Joined,
  JoinInfo,
  MemberPage,
  MemberView,
  MyKeys,
  MyRepositories,
  replies,
} from '../shapes.ts'

const roles = ['admin', 'member'] as const
const joinAttemptsPerMinute = 10
const repositoryPages = 5
const maxRepositories = 500
const defaultInviteDays = 7
const maxInviteDays = 30
const dayMs = 24 * 3600 * 1000

type InviteStatus = 'used' | 'revoked' | 'expired' | 'open'

const inviteStatus = (row: typeof invite.$inferSelect, now: Date): InviteStatus => {
  if (row.used_at) {
    return 'used'
  }

  if (row.revoked_at) {
    return 'revoked'
  }

  return row.expires_at <= now ? 'expired' : 'open'
}

const joins = fixedWindow(joinAttemptsPerMinute)

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

const requirePerson = (principal: Principal) => {
  if (principal.token_kind !== 'session' && principal.token_kind !== 'personal') {
    fail(
      'FORBIDDEN_SCOPE',
      'This is for people, through a session or a personal token.',
      'Sign in, or use a personal token.',
      {
        required: {
          project_id: '*',
          environment_id: '*',
          level: 'read',
        },
      },
    )
  }
}

const knownKey = (name: string) => {
  if (!memberKeyNames.includes(name)) {
    invalid([
      {
        path: '/name',
        message: `is not one of ${memberKeyNames.join(', ')}`,
      },
    ])
  }
}

export const teamRoutes = (kit: Kit) => {
  const { db } = kit.deps

  const projectIds = (ids: string[], path: string) => {
    const unique = [...new Set(ids)]
    const found = unique.length
      ? db
          .select({
            id: project.id,
          })
          .from(project)
          .where(inArray(project.id, unique))
          .all()
      : []

    if (found.length !== unique.length) {
      invalid([
        {
          path,
          message: 'names a project that does not exist',
        },
      ])
    }

    return unique
  }

  const openInvite = (code: string, now = new Date()) => {
    const row = db
      .select()
      .from(invite)
      .where(eq(invite.code_sha256, sha256(code)))
      .get()

    return row && !row.used_at && !row.revoked_at && row.expires_at > now ? row : null
  }

  const inviteView = (row: typeof invite.$inferSelect, now = new Date()) => ({
    id: row.id,
    role: row.role,
    projects: row.projects,
    status: inviteStatus(row, now),
    created_at: row.created_at.toISOString(),
    expires_at: row.expires_at.toISOString(),
    used_by: row.used_by,
  })

  const memberView = (row: typeof member.$inferSelect) => {
    const person = db.select().from(user).where(eq(user.id, row.user_id)).get()

    return {
      user_id: row.user_id,
      name: person?.name ?? '',
      email: person?.email ?? '',
      role: row.role,
      projects: projectsOf(db, row.user_id),
      joined_at: row.created_at.toISOString(),
      removed_at: row.removed_at?.toISOString() ?? null,
    }
  }

  const activeAdmins = () =>
    db
      .select()
      .from(member)
      .where(and(eq(member.role, 'admin'), isNull(member.removed_at)))
      .all().length

  const setProjects = (call: Call, userId: string, ids: string[], now: Date) => {
    db.delete(project_member).where(eq(project_member.user_id, userId)).run()

    for (const id of ids) {
      db.insert(project_member)
        .values({
          project_id: id,
          user_id: userId,
          added_by: call.principal.actor,
          created_at: now,
        })
        .run()
    }
  }

  const stopOwnedTasks = (userId: string) => {
    for (const row of db.select().from(task).all()) {
      if (
        row.owner.id !== userId ||
        !['queued', 'setting_up', 'working', 'waiting'].includes(row.status)
      ) {
        continue
      }

      const conversationRow = latestConversation(db, row.id)

      if (conversationRow && runnerLive(conversationRow)) {
        addInput(
          db,
          conversationRow,
          {
            kind: 'interrupt',
            text: null,
          },
          {
            type: 'system',
            id: null,
            client: 'dispatch/member-removed',
          },
        )
      }

      stopTask(db, row)
    }
  }

  type Repo = {
    full_name: string
    clone_url: string
    private: boolean
    default_branch: string
    pushed_at: string | null
  }

  const myRepositories = async (userId: string) => {
    if (!githubAccountOf(db, userId)) {
      return {
        github: 'not_connected' as const,
        items: [],
      }
    }

    const token = await githubTokenOf(kit.deps.auth, db, userId)
    const installations = token
      ? await gh<{ installations: { id: number; app_id: number }[] }>(
          '/user/installations?per_page=100',
          {
            token,
          },
        )
      : null

    if (!token || !installations || installations.status === 401) {
      return {
        github: 'reconnect' as const,
        items: [],
      }
    }

    const apps = new Set(
      db
        .select({
          app_id: github_app.app_id,
        })
        .from(github_app)
        .all()
        .map((row) => row.app_id),
    )
    const found: Repo[] = []

    for (const installation of (installations.data?.installations ?? []).filter((entry) =>
      apps.has(entry.app_id),
    )) {
      for (let page = 1; page <= repositoryPages && found.length < maxRepositories; page += 1) {
        const reply = await gh<{ repositories: Repo[] }>(
          `/user/installations/${installation.id}/repositories?per_page=100&page=${page}`,
          {
            token,
          },
        )
        const repositories = reply.data?.repositories ?? []

        found.push(...repositories)

        if (repositories.length < 100) {
          break
        }
      }
    }

    return {
      github: 'connected' as const,
      items: [...new Map(found.map((repo) => [repo.full_name, repo])).values()]
        .sort((a, b) => (b.pushed_at ?? '').localeCompare(a.pushed_at ?? ''))
        .slice(0, maxRepositories)
        .map((repo) => ({
          full_name: repo.full_name,
          clone_url: repo.clone_url,
          private: repo.private,
          default_branch: repo.default_branch,
        })),
    }
  }

  return kit
    .router('team', '/v1')
    .get(
      '/me/keys',
      async ({ request }) => {
        const principal = await kit.principal(request)

        requirePerson(principal)

        return {
          items: listKeys(db, principal.user_id),
        }
      },
      {
        operation: {
          id: 'list_my_keys',
          summary: 'Your own agent keys: which are set, never their values',
          level: 'any',
          mcp: false,
          cli: {
            path: ['me', 'keys', 'list'],
          },
        },
        response: replies({
          200: MyKeys,
        }),
      },
    )
    .put(
      '/me/keys/:name',
      async ({ request, params, body }) => {
        const call = await kit.call(request)

        requireHuman(call.principal, 'Setting your key')
        knownKey(params.name)
        setKey(db, kit.deps.keyring, call.principal.user_id, params.name, body.value)
        audit(
          db,
          call,
          'member_key.set',
          {
            entity: 'member_key',
            id: params.name,
          },
          {},
        )

        return {
          items: listKeys(db, call.principal.user_id),
        }
      },
      {
        operation: {
          id: 'set_my_key',
          summary: 'Set one of your own agent keys; your tasks use it instead of the project key',
          level: 'any',
          mcp: false,
          cli: {
            path: ['me', 'keys', 'set'],
            args: ['name'],
          },
        },
        body: t.Object({
          value: t.String({
            minLength: 1,
            maxLength: 4096,
          }),
        }),
        response: replies({
          200: MyKeys,
        }),
      },
    )
    .delete(
      '/me/keys/:name',
      async ({ request, params }) => {
        const call = await kit.call(request)

        requireHuman(call.principal, 'Deleting your key')
        knownKey(params.name)
        deleteKey(db, call.principal.user_id, params.name)
        audit(
          db,
          call,
          'member_key.delete',
          {
            entity: 'member_key',
            id: params.name,
          },
          {},
        )

        return {
          items: listKeys(db, call.principal.user_id),
        }
      },
      {
        operation: {
          id: 'delete_my_key',
          summary: 'Delete one of your own agent keys; your tasks go back to the project key',
          level: 'any',
          mcp: false,
          cli: {
            path: ['me', 'keys', 'delete'],
            args: ['name'],
          },
        },
        response: replies({
          200: MyKeys,
        }),
      },
    )
    .get(
      '/me/repositories',
      async ({ request }) => {
        const principal = await kit.principal(request)

        requirePerson(principal)

        return myRepositories(principal.user_id)
      },
      {
        operation: {
          id: 'list_my_repositories',
          summary:
            'The repositories you can reach through the GitHub App with your own GitHub account, newest push first',
          level: 'any',
          mcp: false,
          cli: {
            path: ['me', 'repositories'],
          },
        },
        response: replies({
          200: MyRepositories,
        }),
      },
    )
    .post(
      '/invites',
      async ({ request, body, set }) => {
        const call = await kit.call(request)

        requireHuman(call.principal, 'Inviting someone')

        const days = body.expires_in_days ?? defaultInviteDays
        const code = randomBytes(32).toString('base64url')
        const now = new Date()
        const row = {
          id: newId('invite'),
          code_sha256: sha256(code),
          role: body.role,
          projects: projectIds(body.projects ?? [], '/projects'),
          created_by: call.principal.actor,
          created_at: now,
          expires_at: new Date(now.getTime() + days * dayMs),
        }

        db.insert(invite).values(row).run()
        audit(
          db,
          call,
          'invite.create',
          {
            entity: 'invite',
            id: row.id,
          },
          {
            after: {
              role: row.role,
              projects: row.projects,
              expires_at: row.expires_at.toISOString(),
            },
          },
        )
        set.status = 201

        return {
          ...inviteView(db.select().from(invite).where(eq(invite.id, row.id)).get()!),
          url: `${kit.deps.auth.surface.dashboardOrigin}/join/${code}`,
        }
      },
      {
        operation: {
          id: 'create_invite',
          summary:
            'Invite someone to the team as an admin or a member; the link is shown once. Needs a human admin',
          level: 'instance admin',
          mcp: false,
          cli: {
            path: ['invites', 'create'],
          },
        },
        body: t.Object({
          role: t.UnionEnum([...roles]),
          projects: t.Optional(
            t.Array(t.String(), {
              maxItems: 200,
              description: 'Project ids the person joins',
            }),
          ),
          expires_in_days: t.Optional(
            t.Integer({
              minimum: 1,
              maximum: maxInviteDays,
            }),
          ),
        }),
        response: replies({
          201: InviteCreated,
        }),
      },
    )
    .get(
      '/invites',
      () => ({
        items: db
          .select()
          .from(invite)
          .orderBy(desc(invite.created_at))
          .all()
          .map((row) => inviteView(row)),
      }),
      {
        operation: {
          id: 'list_invites',
          summary: 'Invites, newest first, without their codes; for an admin',
          level: 'instance admin',
          mcp: false,
          cli: {
            path: ['invites', 'list'],
          },
        },
        response: replies({
          200: InvitePage,
        }),
      },
    )
    .delete(
      '/invites/:invite',
      async ({ request, params }) => {
        const call = await kit.call(request)

        requireHuman(call.principal, 'Revoking an invite')

        const row =
          db.select().from(invite).where(eq(invite.id, params.invite)).get() ??
          notFound('invite', params.invite)

        if (!row.used_at && !row.revoked_at) {
          db.update(invite)
            .set({
              revoked_at: new Date(),
            })
            .where(eq(invite.id, row.id))
            .run()
          audit(
            db,
            call,
            'invite.revoke',
            {
              entity: 'invite',
              id: row.id,
            },
            {},
          )
        }

        return inviteView(db.select().from(invite).where(eq(invite.id, row.id)).get()!)
      },
      {
        operation: {
          id: 'revoke_invite',
          summary: 'Revoke an invite so its link stops working; needs a human admin',
          level: 'instance admin',
          mcp: false,
          cli: {
            path: ['invites', 'revoke'],
            args: ['invite'],
          },
        },
        response: replies({
          200: InviteCreated,
        }),
      },
    )
    .get(
      '/join/:code',
      ({ params }) => {
        const row = openInvite(params.code) ?? notFound('invite', 'this link')
        const inviter =
          row.created_by.type === 'user' && row.created_by.id
            ? db.select().from(user).where(eq(user.id, row.created_by.id)).get()
            : undefined

        return {
          team: new URL(kit.deps.auth.surface.dashboardOrigin).hostname,
          invited_by: inviter?.name ?? 'An admin',
          role: row.role,
          expires_at: row.expires_at.toISOString(),
        }
      },
      {
        operation: {
          id: 'get_join',
          summary:
            'Who invited you, to which team and as what; public, answered only for an open invite',
          level: 'public',
          mcp: false,
          cli: false,
        },
        detail: {
          hide: true,
        },
        response: replies({
          200: JoinInfo,
        }),
      },
    )
    .post(
      '/join/:code',
      async ({ params, body, set, request }) => {
        const retry = joins.retryAfter(ipOf(request))

        if (retry !== null) {
          throw rateLimited('Too many attempts to join from this address.', retry)
        }

        joins.add(ipOf(request))

        const row = openInvite(params.code) ?? notFound('invite', 'this link')
        const email = body.email.trim().toLowerCase()

        if (db.select().from(user).where(eq(user.email, email)).get()) {
          invalid([
            {
              path: '/email',
              message: 'cannot be used here',
            },
          ])
        }

        const now = new Date()
        const claimed = db
          .update(invite)
          .set({
            used_at: now,
          })
          .where(and(eq(invite.id, row.id), isNull(invite.used_at), isNull(invite.revoked_at)))
          .run().changes

        if (!claimed) {
          notFound('invite', 'this link')
        }

        const created = await kit.deps.auth.current.api
          .createUser({
            body: {
              email,
              password: body.password,
              name: body.name.trim(),
              role: 'user',
              data: {
                emailVerified: true,
              },
            },
          })
          .catch((error: unknown) => {
            db.update(invite)
              .set({
                used_at: null,
              })
              .where(eq(invite.id, row.id))
              .run()

            throw error
          })

        db.update(invite)
          .set({
            used_by: created.user.id,
          })
          .where(eq(invite.id, row.id))
          .run()

        db.insert(member)
          .values({
            user_id: created.user.id,
            role: row.role,
            joined_by: row.id,
            created_at: now,
          })
          .run()

        for (const id of row.projects) {
          db.insert(project_member)
            .values({
              project_id: id,
              user_id: created.user.id,
              added_by: row.created_by,
              created_at: now,
            })
            .onConflictDoNothing()
            .run()
        }

        set.status = 201

        return {
          user_id: created.user.id,
          email,
        }
      },
      {
        operation: {
          id: 'join_team',
          summary:
            'Join the team with an invite: creates your account with a name, email and password; public',
          level: 'public',
          mcp: false,
          cli: false,
        },
        detail: {
          hide: true,
        },
        body: t.Object({
          name: t.String({
            minLength: 1,
            maxLength: 120,
          }),
          email: t.String({
            format: 'email',
            maxLength: 254,
          }),
          password: t.String({
            minLength: 12,
            maxLength: 256,
          }),
        }),
        response: replies({
          201: Joined,
        }),
      },
    )
    .get(
      '/members',
      async ({ request }) => {
        const principal = await kit.principal(request)

        requirePerson(principal)

        const admin = isInstanceAdmin(principal.scopes)

        return {
          items: db
            .select()
            .from(member)
            .orderBy(member.created_at)
            .all()
            .filter((row) => admin || !row.removed_at)
            .map(memberView),
        }
      },
      {
        operation: {
          id: 'list_members',
          summary: 'The people in the team with their role and projects',
          level: 'any',
          mcp: false,
          cli: {
            path: ['members', 'list'],
          },
        },
        response: replies({
          200: MemberPage,
        }),
      },
    )
    .patch(
      '/members/:user',
      async ({ request, params, body }) => {
        const call = await kit.call(request)

        requireHuman(call.principal, 'Changing a member')

        const row = memberOf(db, params.user)

        if (!row || row.removed_at) {
          notFound('member', params.user)
        }

        if (body.role === 'member' && row!.role === 'admin' && activeAdmins() <= 1) {
          invalid([
            {
              path: '/role',
              message: 'the team needs at least one admin',
            },
          ])
        }

        const now = new Date()

        if (body.role) {
          db.update(member)
            .set({
              role: body.role,
            })
            .where(eq(member.user_id, params.user))
            .run()
        }

        if (body.projects) {
          setProjects(call, params.user, projectIds(body.projects, '/projects'), now)
        }

        audit(
          db,
          call,
          'member.update',
          {
            entity: 'member',
            id: params.user,
          },
          {
            before: {
              role: row!.role,
            },
            after: {
              role: body.role ?? row!.role,
              projects: projectsOf(db, params.user),
            },
          },
        )

        return memberView(memberOf(db, params.user)!)
      },
      {
        operation: {
          id: 'update_member',
          summary: "Change a member's role or projects; needs a human admin",
          level: 'instance admin',
          mcp: false,
          cli: {
            path: ['members', 'update'],
            args: ['user'],
          },
        },
        body: t.Object({
          role: t.Optional(t.UnionEnum([...roles])),
          projects: t.Optional(
            t.Array(t.String(), {
              maxItems: 200,
            }),
          ),
        }),
        response: replies({
          200: MemberView,
        }),
      },
    )
    .delete(
      '/members/:user',
      async ({ request, params }) => {
        const call = await kit.call(request)

        requireHuman(call.principal, 'Removing a member')

        const row = memberOf(db, params.user)

        if (!row || row.removed_at) {
          notFound('member', params.user)
        }

        if (params.user === call.principal.user_id) {
          invalid([
            {
              path: '/user',
              message: 'an admin cannot remove themself',
            },
          ])
        }

        if (row!.role === 'admin' && activeAdmins() <= 1) {
          invalid([
            {
              path: '/user',
              message: 'the team needs at least one admin',
            },
          ])
        }

        db.update(member)
          .set({
            removed_at: new Date(),
          })
          .where(eq(member.user_id, params.user))
          .run()
        db.update(user)
          .set({
            banned: true,
            banReason: 'Removed from the team',
          })
          .where(eq(user.id, params.user))
          .run()
        db.delete(session).where(eq(session.userId, params.user)).run()
        db.delete(member_key).where(eq(member_key.user_id, params.user)).run()
        db.delete(account)
          .where(and(eq(account.userId, params.user), eq(account.providerId, 'github')))
          .run()
        stopOwnedTasks(params.user)
        removeMachineUsers(db, params.user, (station) => kit.deps.stations.reconcile(station))
        audit(
          db,
          call,
          'member.remove',
          {
            entity: 'member',
            id: params.user,
          },
          {},
        )

        return memberView(memberOf(db, params.user)!)
      },
      {
        operation: {
          id: 'remove_member',
          summary:
            'Remove someone from the team: their sessions end, their running tasks stop, and their tasks stay for an admin; needs a human admin',
          level: 'instance admin',
          mcp: false,
          cli: {
            path: ['members', 'remove'],
            args: ['user'],
          },
        },
        response: replies({
          200: MemberView,
        }),
      },
    )
}
