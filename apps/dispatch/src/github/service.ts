import { createHash } from 'node:crypto'
import { and, asc, desc, eq, isNull, lt } from 'drizzle-orm'
import type { Principal } from '../auth/principal.ts'
import type { AuthService } from '../auth/auth.ts'
import type { Db } from '../db/client.ts'
import { newId } from '../db/ids.ts'
import {
  build,
  deployment,
  environment,
  event,
  github_app,
  github_delivery,
  github_installation,
  github_status,
  project,
  service,
  source_poll
} from '../db/schema.ts'
import type { Call } from '../api/context.ts'
import { ChangeSet, commit } from '../api/changes.ts'
import { ApiError } from '../api/errors.ts'
import { readSetting } from '../db/settings.ts'
import { env } from '../env.ts'
import type { Keyring } from '../secrets/keyring.ts'
import { eventBus } from '../station/events.ts'
import { advertisement, appJwt, gh, GitHubError, type GitHubResponse, githubWeb, repoOf, signatureValid, splitRepo } from './client.ts'

type AppRow = typeof github_app.$inferSelect
type InstallationRow = typeof github_installation.$inferSelect
type ServiceRow = typeof service.$inferSelect
type Json = Record<string, unknown>
type RepoSource = { type: 'dockerfile' | 'railpack'; repo: string; branch: string; auth?: 'app' | 'public' }

export type GitHubDeps = { db: Db; keyring: Keyring; auth: AuthService }

const log = (event: string, fields: Json = {}) => console.log(JSON.stringify({ event, ...fields }))

const aad = (app: { id: string }, field: string) => `github_app:${app.id}:${field}`

export const repoServices = (db: Db) =>
  db
    .select({ svc: service, env: environment })
    .from(service)
    .innerJoin(environment, eq(environment.id, service.environment_id))
    .all()
    .filter(({ svc }) => {
      const source = svc.source as Json
      return (source.type === 'dockerfile' || source.type === 'railpack') && typeof source.repo === 'string'
    })

export const githubActor = (client: string) => ({ type: 'system' as const, id: 'github', client })

export const systemCall = (client: string, requestId: string): Call => ({
  principal: {
    actor: githubActor(client),
    human: false,
    user_id: 'system:github',
    token_kind: 'scoped',
    token_id: null,
    credential: 'system:github',
    scopes: [{ project_id: '*', environment_id: '*', level: 'admin' }],
    expires_at: new Date(Date.now() + 3600_000),
    resource: null
  } as Principal,
  request_id: requestId,
  idempotency_key: null
})

const infraCodes = new Set(['STATION_OFFLINE', 'SECRETS_UNAVAILABLE', 'PROTOCOL_LIMIT', 'INTERNAL_ERROR', 'SOURCE_UNREACHABLE'])

export const createGitHub = (deps: GitHubDeps) => {
  const { db, keyring } = deps
  const timers: NodeJS.Timeout[] = []
  let stopped = false

  const secretsOf = (app: AppRow) => ({
    pem: keyring.decrypt(aad(app, 'private_key'), app.data_key_id!, app.private_key),
    webhookSecret: app.webhook_secret ? keyring.decrypt(aad(app, 'webhook_secret'), app.data_key_id!, app.webhook_secret) : null
  })

  const seal = (id: string, field: string, value: string) => keyring.encrypt(aad({ id }, field), value)

  const jwtFor = (app: AppRow) => appJwt(app.client_id, secretsOf(app).pem)

  const installationToken = async (app: AppRow, installationId: number, repositories: string[] | null, permissions: Record<string, string>) => {
    const body: Json = { permissions }
    if (repositories) body.repositories = repositories
    const response = await gh<{ token: string; expires_at: string }>(`/app/installations/${installationId}/access_tokens`, { method: 'POST', token: jwtFor(app), body })
    return response.data.token
  }

  const installationFor = (owner: string) =>
    db
      .select({ app: github_app, installation: github_installation })
      .from(github_installation)
      .innerJoin(github_app, eq(github_app.id, github_installation.github_app_id))
      .where(and(eq(github_installation.account, owner.toLowerCase()), isNull(github_installation.suspended_at)))
      .get()

  const appForOwner = (owner: string) => db.select().from(github_app).where(eq(github_app.owner, owner.toLowerCase())).get()

  const installUrl = (app: AppRow) => `${githubWeb()}/apps/${app.slug}/installations/new`

  const connectUrl = () => `${deps.auth.surface.dashboardOrigin}/github/connect`

  const repoToken = async (repo: string, permission: Record<string, string>) => {
    const { owner, name } = splitRepo(repo)
    const found = installationFor(owner)
    if (!found) return null
    try {
      return { token: await installationToken(found.app, found.installation.installation_id, [name], permission), app: found.app }
    } catch (error) {
      if (error instanceof GitHubError && (error.status === 422 || error.status === 404)) return null
      throw error
    }
  }

  const resolveRepo = async (repo: string) => {
    const { owner, name, full_name } = splitRepo(repo)
    const scoped = await repoToken(repo, { contents: 'read' })
    if (scoped) {
      const meta = await gh<{ default_branch: string }>(`/repos/${owner}/${name}`, { token: scoped.token })
      return { auth: 'app' as const, default_branch: meta.data.default_branch }
    }
    try {
      const result = await advertisement(repo, null)
      const head = result.advertisement?.head
      return { auth: 'public' as const, default_branch: head?.startsWith('refs/heads/') ? head.slice('refs/heads/'.length) : 'main' }
    } catch (error) {
      const app = appForOwner(owner)
      const install_url = app ? installUrl(app) : connectUrl()
      throw new ApiError(
        'SOURCE_UNREACHABLE',
        `${full_name} is not covered by a GitHub App installation and cannot be read anonymously (${(error as Error).message}).`,
        app ? `Install the GitHub App on ${owner} and give it access to ${name}: ${install_url}` : `Connect a GitHub App for ${owner} (a human opens ${install_url}), then install it.`,
        { reason: 'no_installation', repo, install_url }
      )
    }
  }

  const branchHead = async (repo: string, branch: string, etag: string | null = null) => {
    const { owner, name } = splitRepo(repo)
    const scoped = await repoToken(repo, { contents: 'read' })
    if (scoped) {
      const response = await gh<{ commit: { sha: string } }>(`/repos/${owner}/${name}/branches/${encodeURIComponent(branch)}`, { token: scoped.token, etag })
      const interval = Number(response.headers.get('x-poll-interval') ?? '') || null
      return { auth: 'app' as const, sha: response.status === 304 ? null : response.data.commit.sha, etag: response.headers.get('etag') ?? etag, interval }
    }
    const result = await advertisement(repo, null, etag)
    if (result.status === 304) return { auth: 'public' as const, sha: null, etag, interval: null }
    const sha = result.advertisement!.refs.get(`refs/heads/${branch}`)
    if (!sha) throw new GitHubError(404, `${repo} has no branch ${branch}`, null)
    return { auth: 'public' as const, sha, etag: result.etag, interval: null }
  }

  const cloneCredential = async (repo: string, auth: string | undefined) => {
    if (auth !== 'app') return null
    const scoped = await repoToken(repo, { contents: 'read' })
    return scoped?.token ?? null
  }

  const enqueueStatus = (repo: string, sha: string, context: string, state: 'pending' | 'success' | 'failure' | 'error', description: string, target: string | null) => {
    const { owner } = splitRepo(repo)
    if (!installationFor(owner)) return
    db.insert(github_status).values({ repo, sha, context, state, description: description.slice(0, 140), target_url: target }).run()
  }

  const dashboardLink = (path: string) => `${deps.auth.surface.dashboardOrigin}${path}`

  const contexts = (svc: ServiceRow) => {
    const env = db.select().from(environment).where(eq(environment.id, svc.environment_id)).get()!
    return { build: `stationly/build/${svc.name}`, deploy: `stationly/deploy/${env.name}/${svc.name}` }
  }

  const buildStarted = (buildRow: typeof build.$inferSelect, svc: ServiceRow, sha: string) => {
    const source = svc.source as RepoSource
    if (source.auth !== 'app') return
    const ctx = contexts(svc)
    enqueueStatus(source.repo, sha, ctx.build, 'pending', `Building ${svc.name} on stationly`, dashboardLink(`/builds/${buildRow.id}`))
    enqueueStatus(source.repo, sha, ctx.deploy, 'pending', `Waiting for the build of ${svc.name}`, dashboardLink(`/deployments/${buildRow.deployment_id}`))
  }

  const onDeploymentEvent = (row: typeof event.$inferSelect) => {
    const depId = (row.payload.deployment ?? row.subject.id) as string
    const dep = db.select().from(deployment).where(eq(deployment.id, depId)).get()
    if (!dep?.build_id) return
    const b = db.select().from(build).where(eq(build.id, dep.build_id)).get()
    const svc = db.select().from(service).where(eq(service.id, dep.service_id)).get()
    const sha = (b?.source as { sha?: string } | undefined)?.sha
    if (!b || !svc || !sha) return
    const source = svc.source as RepoSource
    if (source.auth !== 'app') return
    const ctx = contexts(svc)
    const buildLink = dashboardLink(`/builds/${b.id}`)
    const depLink = dashboardLink(`/deployments/${dep.id}`)
    if (row.type === 'deployment.started') {
      enqueueStatus(source.repo, sha, ctx.build, 'success', `Built in ${b.duration_s ?? 0} s`, buildLink)
      enqueueStatus(source.repo, sha, ctx.deploy, 'pending', `Deploying deployment ${dep.number}`, depLink)
    } else if (row.type === 'deployment.active') {
      enqueueStatus(source.repo, sha, ctx.deploy, 'success', `Deployment ${dep.number} is active`, depLink)
    } else if (row.type === 'deployment.failed') {
      const failure = (dep.failure ?? {}) as { phase?: string; code?: string; summary?: string }
      const state = infraCodes.has(failure.code ?? '') ? 'error' : 'failure'
      const text = `${failure.code ?? 'FAILED'}: ${failure.summary ?? 'the deployment failed'}`
      if (failure.phase === 'build') {
        enqueueStatus(source.repo, sha, ctx.build, state, text, buildLink)
        enqueueStatus(source.repo, sha, ctx.deploy, state, 'The build failed; nothing was deployed', depLink)
      } else enqueueStatus(source.repo, sha, ctx.deploy, state, text, depLink)
    } else if (row.type === 'deployment.cancelled') {
      enqueueStatus(source.repo, sha, ctx.deploy, 'error', `Deployment ${dep.number} was cancelled`, depLink)
    }
  }

  const statusTimes: number[] = []
  const postStatuses = async () => {
    const now = Date.now()
    while (statusTimes.length && statusTimes[0]! < now - 3600_000) statusTimes.shift()
    if (statusTimes.length >= 450 || statusTimes.filter(t => t > now - 60_000).length >= 70) return
    const next = db.select().from(github_status).where(and(isNull(github_status.posted_at), lt(github_status.attempts, 5))).orderBy(asc(github_status.id)).get()
    if (!next) return
    const { owner, name } = splitRepo(next.repo)
    statusTimes.push(now)
    try {
      const scoped = await repoToken(next.repo, { statuses: 'write' })
      if (!scoped) throw new Error('no installation covers the repository')
      await gh(`/repos/${owner}/${name}/statuses/${next.sha}`, {
        method: 'POST',
        token: scoped.token,
        body: { state: next.state, context: next.context, description: next.description, ...(next.target_url ? { target_url: next.target_url } : {}) }
      })
      db.update(github_status).set({ posted_at: new Date(), attempts: next.attempts + 1, last_error: null }).where(eq(github_status.id, next.id)).run()
      log('github.status_posted', { repo: next.repo, sha: next.sha, context: next.context, state: next.state })
    } catch (error) {
      db.update(github_status).set({ attempts: next.attempts + 1, last_error: (error as Error).message }).where(eq(github_status.id, next.id)).run()
      log('github.status_failed', { repo: next.repo, context: next.context, explanation: (error as Error).message })
    }
  }

  const alreadyDeployed = (serviceId: string, sha: string) =>
    db
      .select({ id: deployment.id, trigger: deployment.trigger })
      .from(deployment)
      .where(eq(deployment.service_id, serviceId))
      .orderBy(desc(deployment.number))
      .limit(20)
      .all()
      .some(d => d.trigger.source_sha === sha)

  const triggerPush = (repo: string, branch: string, sha: string, via: 'webhook' | 'poll', requestId: string) => {
    db.update(source_poll)
      .set({ sha, changed_at: new Date() })
      .where(and(eq(source_poll.repo, repo), eq(source_poll.branch, branch)))
      .run()
    const targets = repoServices(db).filter(({ svc, env }) => !env.ephemeral && (svc.source as RepoSource).repo === repo && (svc.source as RepoSource).branch === branch)
    const created: string[] = []
    for (const { svc, env } of targets) {
      if (alreadyDeployed(svc.id, sha) || svc.desired_state !== 'running') continue
      const set = new ChangeSet()
      set.deploy(svc.id, 'push', { source_sha: sha, reason: `push to ${branch} (${via})` })
      try {
        const result = commit(deps, systemCall(`github/${via}`, requestId), { environment: env, protect: env.protected, source: 'api' }, set)
        if (result.applied) created.push(...result.deployments)
        else if ((svc.source as RepoSource).auth === 'app') {
          enqueueStatus(repo, sha, contexts(svc).deploy, 'pending', `Staged in protected ${env.name}; a human must accept ${result.staged.id}`, dashboardLink(`/staged-changes/${result.staged.id}`))
        }
        log('github.push_deploy', { repo, branch, sha, via, service_id: svc.id, applied: result.applied, deployments: result.applied ? result.deployments : [], staged_change: result.applied ? null : result.staged.id })
      } catch (error) {
        log('github.push_deploy_failed', { repo, branch, sha, via, service_id: svc.id, explanation: (error as Error).message })
      }
    }
    return created
  }

  const upsertInstallation = (app: AppRow, data: { id: number; account: { login: string }; repository_selection: 'all' | 'selected'; suspended_at: string | null }) => {
    const values = {
      github_app_id: app.id,
      installation_id: data.id,
      account: data.account.login.toLowerCase(),
      repository_selection: data.repository_selection,
      suspended_at: data.suspended_at ? new Date(data.suspended_at) : null
    }
    const existing = db.select().from(github_installation).where(eq(github_installation.installation_id, data.id)).get()
    if (existing) db.update(github_installation).set(values).where(eq(github_installation.id, existing.id)).run()
    else db.insert(github_installation).values({ id: newId('github_installation'), ...values }).run()
    return db.select().from(github_installation).where(eq(github_installation.installation_id, data.id)).get()!
  }

  const refreshAuth = async (owner: string) => {
    for (const { svc } of repoServices(db)) {
      const source = svc.source as RepoSource
      if (splitRepo(source.repo).owner !== owner.toLowerCase()) continue
      try {
        const resolved = await resolveRepo(source.repo)
        if (resolved.auth !== source.auth) {
          db.update(service).set({ source: { ...source, auth: resolved.auth } }).where(eq(service.id, svc.id)).run()
          log('github.auth_changed', { service_id: svc.id, repo: source.repo, from: source.auth ?? null, to: resolved.auth })
        }
      } catch (error) {
        log('github.auth_unresolved', { service_id: svc.id, repo: source.repo, explanation: (error as Error).message })
      }
    }
  }

  const syncInstallations = async (app: AppRow) => {
    const found: InstallationRow[] = []
    for (let page = 1; page < 20; page++) {
      const response = await gh<{ id: number; account: { login: string }; repository_selection: 'all' | 'selected'; suspended_at: string | null }[]>(`/app/installations?per_page=100&page=${page}`, {
        token: jwtFor(app)
      })
      for (const item of response.data) found.push(upsertInstallation(app, item))
      if (response.data.length < 100) break
    }
    const keep = new Set(found.map(f => f.installation_id))
    for (const row of db.select().from(github_installation).where(eq(github_installation.github_app_id, app.id)).all()) {
      if (!keep.has(row.installation_id)) db.delete(github_installation).where(eq(github_installation.id, row.id)).run()
    }
    await refreshAuth(app.owner)
    return found
  }

  const prEnvironmentName = (number: number) => `pr-${number}`

  const onPullRequest = async (app: AppRow, payload: Json, guid: string) => {
    const action = payload.action as string
    const pr = payload.pull_request as { number: number; head: { sha: string; ref: string; repo: { full_name: string } | null }; base: { repo: { full_name: string } } }
    const base = repoOf(pr.base.repo.full_name)
    const fork = !pr.head.repo || pr.head.repo.full_name.toLowerCase() !== pr.base.repo.full_name.toLowerCase()
    const { cloneInto } = await import('../api/routes/environments.ts')
    const results: Json[] = []
    for (const proj of db.select().from(project).all()) {
      if (!proj.pr_environments?.enabled) continue
      const sourceEnvId = proj.pr_environments.source_environment_id ?? proj.default_environment_id
      const sourceEnv = db.select().from(environment).where(eq(environment.id, sourceEnvId)).get()
      if (!sourceEnv) continue
      const tracked = db
        .select()
        .from(service)
        .where(eq(service.environment_id, sourceEnv.id))
        .all()
        .some(s => (s.source as RepoSource).repo === base)
      if (!tracked) continue
      const name = prEnvironmentName(pr.number)
      const existing = db.select().from(environment).where(and(eq(environment.project_id, proj.id), eq(environment.name, name))).get()
      const call = systemCall(`github/${app.slug}`, `gh_${guid}`)
      if (action === 'closed') {
        if (!existing) continue
        const set = new ChangeSet()
        set.remove('environment', existing.id, { name })
        commit(deps, call, { environment: existing, protect: false, source: 'api' }, set)
        results.push({ project: proj.name, environment: name, action: 'deleted' })
        continue
      }
      if (!['opened', 'reopened', 'synchronize'].includes(action)) continue
      const pullRequest = { repo: base, number: pr.number, head_sha: pr.head.sha, fork }
      let env = existing
      if (!env) {
        const id = newId('environment')
        db.insert(environment)
          .values({ id, project_id: proj.id, name, protected: false, ephemeral: true, source_environment_id: sourceEnv.id, ttl_seconds: 7 * 24 * 3600, pull_request: pullRequest })
          .run()
        env = db.select().from(environment).where(eq(environment.id, id)).get()!
        cloneInto({ deps }, call, proj, sourceEnv, env, false)
        for (const svc of db.select().from(service).where(eq(service.environment_id, env.id)).all()) {
          const source = svc.source as RepoSource
          if (source.repo === base && !fork) db.update(service).set({ source: { ...source, branch: pr.head.ref } }).where(eq(service.id, svc.id)).run()
        }
      } else {
        db.update(environment).set({ pull_request: pullRequest }).where(eq(environment.id, env.id)).run()
        env = db.select().from(environment).where(eq(environment.id, env.id)).get()!
      }
      if (fork) {
        results.push({ project: proj.name, environment: name, action: existing ? 'updated' : 'created', fork: true, deployments: [] })
        log('github.pr_fork_waiting', { project_id: proj.id, environment_id: env.id, number: pr.number, head_sha: pr.head.sha })
        continue
      }
      const set = new ChangeSet()
      for (const svc of db.select().from(service).where(eq(service.environment_id, env.id)).all()) {
        const source = svc.source as RepoSource
        if (source.repo === base) {
          if (!alreadyDeployed(svc.id, pr.head.sha)) set.deploy(svc.id, 'push', { source_sha: pr.head.sha, reason: `pull request #${pr.number} ${action}` })
        } else if (!existing) set.deploy(svc.id, 'manual', { reason: `pull request #${pr.number} environment created` })
      }
      const result = set.empty ? null : commit(deps, call, { environment: env, protect: false, source: 'api' }, set)
      results.push({ project: proj.name, environment: name, action: existing ? 'updated' : 'created', fork: false, deployments: result?.applied ? result.deployments : [] })
    }
    return results
  }

  const processDelivery = async (guid: string) => {
    const row = db.select().from(github_delivery).where(eq(github_delivery.guid, guid)).get()
    if (!row || row.status !== 'queued') return
    const app = db.select().from(github_app).where(eq(github_app.id, row.github_app_id)).get()
    if (!app) return
    const payload = JSON.parse(row.payload) as Json
    let detail: Json = {}
    let status: 'processed' | 'ignored' | 'failed' = 'processed'
    try {
      if (row.event === 'push') {
        const ref = payload.ref as string
        if (payload.deleted || !ref.startsWith('refs/heads/')) status = 'ignored'
        else {
          const repo = repoOf((payload.repository as { full_name: string }).full_name)
          const branch = ref.slice('refs/heads/'.length)
          detail = { repo, branch, sha: payload.after, deployments: triggerPush(repo, branch, payload.after as string, 'webhook', `gh_${guid}`) }
        }
      } else if (row.event === 'pull_request') {
        detail = { results: await onPullRequest(app, payload, guid) }
      } else if (row.event === 'installation') {
        const installation = payload.installation as { id: number; account: { login: string }; repository_selection: 'all' | 'selected'; suspended_at: string | null }
        if (payload.action === 'deleted') db.delete(github_installation).where(eq(github_installation.installation_id, installation.id)).run()
        else upsertInstallation(app, installation)
        await refreshAuth(installation.account.login)
        detail = { installation_id: installation.id, action: payload.action }
      } else if (row.event === 'installation_repositories') {
        const installation = payload.installation as { id: number; account: { login: string }; repository_selection: 'all' | 'selected'; suspended_at: string | null }
        upsertInstallation(app, { ...installation, repository_selection: (payload.repository_selection as 'all' | 'selected') ?? installation.repository_selection })
        await refreshAuth(installation.account.login)
        detail = { installation_id: installation.id, action: payload.action }
      } else status = 'ignored'
    } catch (error) {
      status = 'failed'
      detail = { explanation: (error as Error).message }
    }
    db.update(github_delivery).set({ status, detail, processed_at: new Date() }).where(eq(github_delivery.guid, guid)).run()
    log('github.delivery_processed', { guid, github_event: row.event, action: row.action, status, redelivery: row.redelivery, detail })
  }

  const receive = async (appIdParam: string, request: Request) => {
    const appId = Number(appIdParam)
    const app = Number.isInteger(appId) ? db.select().from(github_app).where(eq(github_app.app_id, appId)).get() : undefined
    const length = Number(request.headers.get('content-length') ?? '0')
    if (length > 25 * 1024 * 1024) return new Response(null, { status: 413 })
    const body = Buffer.from(await request.arrayBuffer())
    if (!app) return new Response(null, { status: 404 })
    const secret = secretsOf(app).webhookSecret
    if (!secret || !signatureValid(secret, body, request.headers.get('x-hub-signature-256'))) {
      log('github.webhook_refused', { app_id: appId, delivery: request.headers.get('x-github-delivery'), reason: secret ? 'bad_signature' : 'no_webhook_secret' })
      return new Response(null, { status: 401 })
    }
    const guid = request.headers.get('x-github-delivery') ?? createHash('sha256').update(body).digest('hex')
    const eventName = request.headers.get('x-github-event') ?? 'unknown'
    let action: string | null = null
    try {
      action = ((JSON.parse(body.toString('utf8')) as Json).action as string | undefined) ?? null
    } catch {
      return new Response(null, { status: 400 })
    }
    const inserted = db
      .insert(github_delivery)
      .values({ guid, github_app_id: app.id, event: eventName, action, payload: body.toString('utf8'), status: 'queued' })
      .onConflictDoNothing()
      .run()
    if (inserted.changes === 0) {
      log('github.delivery_duplicate', { guid, github_event: eventName })
      return new Response(null, { status: 204 })
    }
    log('github.delivery_received', { guid, github_event: eventName, action, app_id: appId })
    setImmediate(() => void processDelivery(guid))
    return new Response(null, { status: 204 })
  }

  const sweepDeliveries = async () => {
    const results: Json[] = []
    for (const app of db.select().from(github_app).where(eq(github_app.webhooks, true)).all()) {
      const since = Date.now() - 3 * 24 * 3600_000
      const attempts = new Map<string, { id: number; ok: boolean; delivered_at: number }[]>()
      let cursor: string | null = null
      for (let page = 0; page < 30; page++) {
        const path: string = `/app/hook/deliveries?per_page=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
        const response: GitHubResponse<{ id: number; guid: string; status_code: number; delivered_at: string }[]> = await gh(path, { token: jwtFor(app) })
        let older = false
        for (const d of response.data) {
          const at = Date.parse(d.delivered_at)
          if (at < since) older = true
          const list = attempts.get(d.guid) ?? []
          list.push({ id: d.id, ok: d.status_code >= 200 && d.status_code < 300, delivered_at: at })
          attempts.set(d.guid, list)
        }
        const next: string | undefined = /<([^>]+)>;\s*rel="next"/.exec(response.headers.get('link') ?? '')?.[1]
        cursor = next ? new URL(next).searchParams.get('cursor') : null
        if (!cursor || older) break
      }
      for (const [guid, list] of attempts) {
        if (list.some(a => a.ok)) continue
        if (db.select({ guid: github_delivery.guid }).from(github_delivery).where(eq(github_delivery.guid, guid)).get()) continue
        const latest = list.sort((a, b) => b.delivered_at - a.delivered_at)[0]!
        if (latest.delivered_at < since) continue
        try {
          await gh(`/app/hook/deliveries/${latest.id}/attempts`, { method: 'POST', token: jwtFor(app) })
          results.push({ app_id: app.app_id, guid, delivery_id: latest.id, redelivered: true })
          log('github.redelivery_requested', { app_id: app.app_id, guid, delivery_id: latest.id })
        } catch (error) {
          results.push({ app_id: app.app_id, guid, delivery_id: latest.id, redelivered: false, explanation: (error as Error).message })
        }
      }
    }
    return results
  }

  const lastSync = new Map<string, number>()

  const pollOnce = async () => {
    const results: Json[] = []
    const intervalS = Math.max(10, readSetting(db, 'github.poll_interval_s'))
    const pollingApps = db.select().from(github_app).where(eq(github_app.webhooks, false)).all()
    for (const app of pollingApps) {
      if (Date.now() - (lastSync.get(app.id) ?? 0) < intervalS * 1000) continue
      lastSync.set(app.id, Date.now())
      try {
        await syncInstallations(app)
      } catch (error) {
        log('github.sync_failed', { app_id: app.app_id, explanation: (error as Error).message })
      }
    }
    const pollingOwners = new Set(pollingApps.map(a => a.owner))
    const tracked = new Map<string, { repo: string; branch: string; auth: string }>()
    for (const { svc, env } of repoServices(db)) {
      if (env.ephemeral) continue
      const source = svc.source as RepoSource
      const polled = source.auth === 'public' || (source.auth === 'app' && pollingOwners.has(splitRepo(source.repo).owner))
      if (polled && source.branch) tracked.set(`${source.repo}#${source.branch}`, { repo: source.repo, branch: source.branch, auth: source.auth! })
    }
    for (const { repo, branch } of tracked.values()) {
      if (stopped) break
      const state = db.select().from(source_poll).where(and(eq(source_poll.repo, repo), eq(source_poll.branch, branch))).get()
      const wait = Math.max(intervalS, state?.interval_s ?? 0) * 1000
      if (state?.checked_at && Date.now() - state.checked_at.getTime() < wait) continue
      try {
        const head = await branchHead(repo, branch, state?.etag ?? null)
        const sha = head.sha ?? state?.sha ?? null
        db.insert(source_poll)
          .values({ repo, branch, auth: head.auth, sha, etag: head.etag, interval_s: head.interval, checked_at: new Date(), last_error: null })
          .onConflictDoUpdate({ target: [source_poll.repo, source_poll.branch], set: { auth: head.auth, sha, etag: head.etag, interval_s: head.interval, checked_at: new Date(), last_error: null } })
          .run()
        const changed = head.sha !== null && state?.sha && head.sha !== state.sha
        const deployments = changed ? triggerPush(repo, branch, head.sha!, 'poll', `poll_${Date.now()}`) : []
        results.push({ repo, branch, auth: head.auth, sha, not_modified: head.sha === null, changed: Boolean(changed), deployments })
        if (changed) log('github.poll_changed', { repo, branch, from: state?.sha, to: head.sha, auth: head.auth, deployments })
      } catch (error) {
        db.insert(source_poll)
          .values({ repo, branch, auth: 'public', checked_at: new Date(), last_error: (error as Error).message })
          .onConflictDoUpdate({ target: [source_poll.repo, source_poll.branch], set: { checked_at: new Date(), last_error: (error as Error).message } })
          .run()
        results.push({ repo, branch, error: (error as Error).message })
      }
    }
    return results
  }

  const onEvent = (id: string) => {
    const row = db.select().from(event).where(eq(event.id, id)).get()
    if (!row || !row.type.startsWith('deployment.')) return
    try {
      onDeploymentEvent(row)
    } catch (error) {
      log('github.status_enqueue_failed', { event_id: id, explanation: (error as Error).message })
    }
  }

  const guarded = (name: string, fn: () => Promise<unknown>) => async () => {
    try {
      await fn()
    } catch (error) {
      log(`github.${name}_failed`, { explanation: (error as Error).message })
    }
  }

  const start = () => {
    eventBus.on('event', onEvent)
    for (const row of db.select({ guid: github_delivery.guid }).from(github_delivery).where(eq(github_delivery.status, 'queued')).all()) setImmediate(() => void processDelivery(row.guid))
    const sweep = guarded('sweep', sweepDeliveries)
    const poll = guarded('poll', pollOnce)
    const statuses = guarded('statuses', postStatuses)
    setTimeout(sweep, 2_000)
    timers.push(setInterval(sweep, env().STATIONLY_GITHUB_SWEEP_MS))
    let polling = false
    timers.push(
      setInterval(async () => {
        if (polling) return
        polling = true
        await poll()
        polling = false
      }, 5_000)
    )
    timers.push(setInterval(statuses, 1_000))
  }

  const stop = () => {
    stopped = true
    eventBus.off('event', onEvent)
    for (const t of timers) clearInterval(t)
  }

  const connection = () => {
    const apps = db.select().from(github_app).orderBy(asc(github_app.created_at)).all()
    return {
      apps: apps.map(app => {
        const installation = db.select().from(github_installation).where(eq(github_installation.github_app_id, app.id)).get()
        return {
          id: app.id,
          app_id: app.app_id,
          slug: app.slug,
          owner: app.owner,
          webhooks: app.webhooks,
          install_url: installUrl(app),
          installation: installation
            ? { id: installation.id, installation_id: installation.installation_id, account: installation.account, repository_selection: installation.repository_selection, suspended_at: installation.suspended_at?.toISOString() ?? null }
            : null
        }
      }),
      connect_url: connectUrl()
    }
  }

  return {
    resolveRepo,
    branchHead,
    cloneCredential,
    buildStarted,
    receive,
    sweepDeliveries,
    pollOnce,
    syncInstallations,
    upsertInstallation,
    installationToken,
    installUrl,
    connectUrl,
    jwtFor,
    seal,
    connection,
    start,
    stop,
  }
}

export type GitHub = ReturnType<typeof createGitHub>
